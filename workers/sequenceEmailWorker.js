const schedule = require('node-schedule');
const OpenAI = require('openai');
const pool = require('../config/db');
const { track } = require('../utils/jobTracker');
const EmailSenderService = require('../services/emailSenderService');
const SuppressionService = require('../services/suppressionService');
const SequenceService = require('../services/sequenceService');
const PlaybookService = require('../services/playbookService');
const ReplyQualityService = require('../services/replyQualityService');
const SchedulerStatusService = require('../services/schedulerStatusService');
const { notifyAdmin } = require('../services/adminNotifyService');
const { getCachedResearch, researchSiteFor, RESEARCH_MAX_ATTEMPTS } = require('../services/leadResearchService');
const { trackedCompletion } = require('../utils/aiUsage');
const { renderEmailBody } = require('../utils/emailRender');
const { getBackendUrl } = require('../utils/backendUrlConfig');
const { checkSpamContent } = require('../utils/spamCheck');
const { generateTrackingToken, buildClickUrl, buildPixelUrl } = require('../utils/emailTracking');
const { getThreadHeaders } = require('../utils/emailThreading');
const { isWithinSendWindow } = require('../utils/sendWindow');
const { getFreshStartAt, allowNoWebsiteEmail } = require('../utils/freshStart');
const FreshResend = require('../services/freshResendService');
const { getSetting } = require('../services/settingsService');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const BATCH_SIZE = 50;
const SEND_DELAY_MS = 1500;
const COMPOSE_MAX_ATTEMPTS = 2; // 1 draft + 1 feedback-driven revision, bounded for a 50-lead batch
const PRIOR_EMAILS_LIMIT = 5;
const MAX_SEND_FAIL_ATTEMPTS = 3; // same cap convention as RESEARCH_MAX_ATTEMPTS / mails.so's 3 verify retries
// How long to wait for Brevo's `delivered` webhook before sending a follow-up anyway. Not every
// receiving mail server generates a delivery confirmation, so silence past this point is treated
// as "probably fine" rather than blocking the lead forever — an explicit bounce still kills the
// sequence immediately via routes/brevoWebhook.js, long before this timeout matters.
const DELIVERY_CONFIRM_TIMEOUT_HOURS = 24;
// Hard cap on emails per lead per sequence (1 cold + 2 follow-ups), same 1+2 cap the WhatsApp
// channel adopted 2026-08-29. Without it, recurring_interval_days kept emailing non-repliers
// weekly forever — the main driver of spam complaints/domain-reputation damage.
const MAX_SEQUENCE_EMAILS = 3;
const DEFAULT_OWN_DOMAINS = 'dreamstechnology.in,dreams-technology.com';

let isRunning = false;

async function getOwnDomains() {
  const raw = (await getSetting('OWN_EMAIL_DOMAINS')) || DEFAULT_OWN_DOMAINS;
  return raw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
}

async function fetchPortfolioItems() {
  const result = await pool.query(
    'SELECT title, url, description FROM portfolio_items ORDER BY created_at DESC LIMIT 5'
  );
  return result.rows;
}

// Follow-up conversation memory: every prior email actually sent to this lead in this
// sequence, oldest first, so composeEmail() can avoid repeating a subject/angle/wording
// instead of composing each step blind. `body` in email_logs is the rendered HTML (footer,
// pixel, links included) — stripHtmlToText below reduces it to a short plain excerpt.
async function fetchPriorSentEmails(leadId) {
  const since = await getFreshStartAt(); // older mail never arrived — not "prior" for the writer
  const result = await pool.query(
    `SELECT subject, body FROM email_logs
     WHERE lead_id = $1 AND direction = 'out' AND sequence_id IS NOT NULL AND error IS NULL
       AND ($3::timestamp IS NULL OR COALESCE(sent_at, created_at) >= $3::timestamp)
     ORDER BY COALESCE(sent_at, created_at) DESC LIMIT $2`,
    [leadId, PRIOR_EMAILS_LIMIT, since]
  );
  return result.rows.reverse();
}

function stripHtmlToText(html, maxLen = 220) {
  const text = String(html || '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&middot;/gi, '·').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  // Cut at the unsubscribe footer ("Dreams Technology · Unsubscribe") so it isn't quoted back
  // into the next prompt as if it were part of the message.
  return text.split(' Dreams Technology ')[0].slice(0, maxLen);
}

function buildPriorEmailsText(priorEmails) {
  if (!priorEmails.length) return '';
  const list = priorEmails
    .map((e, i) => `${i + 1}. Subject: "${e.subject}" — ${stripHtmlToText(e.body)}`)
    .join('\n');
  return `\n\nEmails ALREADY SENT to this lead earlier in this sequence (oldest first) — do NOT reuse ` +
    `their subject line, opening angle, or wording. This email must read as a genuinely new, distinct ` +
    `message, not a rehash:\n${list}`;
}

// Deterministic (non-AI) angle assignment: step N always gets angle[N % length], so
// consecutive emails in a sequence never compete for the same angle, and a short sequence
// naturally uses several different angles instead of the model picking the same one each time.
function selectAngleForStep(emailAngles, stepNumber) {
  if (!emailAngles.length) return { angle: null, others: [] };
  const angle = emailAngles[stepNumber % emailAngles.length];
  return { angle, others: emailAngles.filter((a) => a !== angle) };
}

// Subjects the model tends to regress to when it isn't leaning on real lead-specific detail —
// named explicitly as negative examples rather than just telling it to "be specific" in the
// abstract, since that alone kept producing exactly these.
const GENERIC_SUBJECT_EXAMPLES = [
  'Enhance Your Business Management with Our Software Solutions',
  'Unlock Efficiency for Your Business',
  'Streamline Your Business Operations',
  'Transform Your Business Management',
];

// Rewritten 2026-11-23 on the owner's review of a real first email ("When a buyer asks Rasman
// Technologies for an electric motor quote, how do you usually respond...?"): the owner could not tell
// who was writing or WHY, and the 55-word question-first format read like US cold email. Indian owners
// expect: who we are, why we are writing to THEM (what we actually found on their website/listing),
// one concrete offer tied to that finding, and an easy reply. Simple Indian English, ~80-130 words.
// The research (website facts, products, locations) is the reason for writing, so it is shown in full.
const SALES_WORDS_BANNED = ['solution', 'leverage', 'streamline', 'unlock', 'elevate', 'boost', 'seamless',
  'cutting-edge', 'digital transformation', 'next level', 'CRM', 'ERP', 'analytics', 'lead capture', 'leads',
  'conversion', 'engagement', 'optimize', 'enhance', 'synergy', 'touch base', 'circle back', 'I hope this',
  'I wanted to reach out', 'I came across'];

// "Mr.Ashwani Kr. Vaish" → "Ashwani". Owner names from directories carry titles and initials; the old
// prompt said "Hi <first name>" and got "Hi Mr.Ashwani Kr. Vaish".
function cleanFirstName(raw) {
  const words = String(raw || '').replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean)
    .filter(w => !/^(mr|mrs|ms|miss|dr|shri|shree|smt|sri|er|ca|prof|m\/s)$/i.test(w));
  const first = words.find(w => w.length > 1 && /^[A-Za-z]/.test(w));
  if (!first || /^(sales|admin|info|contact|office|manager|owner|team|accounts|hr|support)$/i.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function siteHost(lead) {
  const raw = String(lead?.website || '').trim();
  if (!raw) return null;
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).hostname.replace(/^www\./, ''); } catch { return null; }
}

// Plain-language facts the email may state as "what we noticed". Only booleans the crawler actually
// recorded as false become "not found"; null/unknown is never turned into a claim.
function websiteFindings(research, lead) {
  const t = research?.technology || {};
  const host = siteHost(lead);
  const out = [];
  if (host) {
    if (t.forms === false) out.push(`No enquiry/contact form found on ${host} (a buyer cannot send a requirement online)`);
    if (t.whatsapp === false) out.push(`No WhatsApp chat button on ${host}`);
    if (t.cms === 'WordPress' && /woocommerce/i.test(t.maturity_note || '')) out.push(`${host} runs on WordPress with WooCommerce (so an enquiry form or product enquiry button can be added to the existing site, no rebuild needed)`);
    else if (t.cms) out.push(`${host} is built on ${t.cms}`);
    if (Array.isArray(t.payment_gateways) && t.payment_gateways.length === 0 && /woocommerce|shop|store/i.test(t.maturity_note || '')) out.push(`No online payment option seen on ${host}`);
  }
  return out;
}

function stageNoteFor(stepNumber, { hasResearch, host, trade, city, firstName }) {
  // "Vinodbhai" / "Hetalben" already carry the honorific; adding "ji" doubles it.
  const greet = firstName ? `"Hello ${firstName}${/(bhai|ben|behen|ji)$/i.test(firstName) ? '' : ' ji'},"` : '"Hello,"';
  if (stepNumber === 0) {
    return `This is the FIRST email to this business. Start with ${greet} then write 4 short paragraphs, 80-130 words in total (not counting the greeting):\n` +
      `1. WHO WE ARE, one sentence: "I am writing from Dreams Technology, a website and software company in Gandhinagar." (You may adapt slightly, e.g. "We make websites and business software for companies in Gujarat.")\n` +
      `2. WHY WE ARE WRITING TO THEM, 1-2 sentences, the most important part. Be SPECIFIC: name their website (or where we saw them), at least one of their real products, and the ONE real gap from the research below. A reader must see this email could only have been written to them. ` +
      (hasResearch && host
        ? `Say it plainly, e.g. "I checked ${host}. You show a good range of <their real products>, but I could not find a simple enquiry form where a buyer can send their requirement." `
        : host
          ? `We have no findings about ${host}, so say where we saw them, e.g. "I saw your business listed as a ${trade}${city ? ` in ${city}` : ''}." Never claim you checked their website or found anything on it. `
          : `THEY HAVE NO WEBSITE on record. Say where we saw them and that we could not find a website, e.g. "I saw your business listed as a ${trade}${city ? ` in ${city}` : ''}, but I could not find a website for your business." NEVER mention "your website", "your site", or adding anything to an existing site; the offer is a simple business website. `) +
      `Then one plain line on why that matters for THEIR buyers (e.g. "Many buyers today don't call; they want to send details online and get a quote.").\n` +
      `3. THE OFFER, 1-2 sentences: the ONE service that fixes exactly that gap (see HOW TO PICK THE OFFER), and how it helps them get more enquiries, orders and sales. E.g. "We can add an enquiry form to your existing website with your product list. Every enquiry comes to your WhatsApp and email, so no buyer is missed and you get more orders." No list of services.\n` +
      `4. THE ASK, one sentence, easy and low-pressure: e.g. "If you want, reply 'yes' and I will send a short sample of how it will look on your site." Prefer a reply-yes ask over asking for a call.\n` +
      `At most ONE question mark in the whole email (the ask may be a statement).\n` +
      `The example sentences above show the IDEA only. Write it in your own words for THIS business; never copy an example sentence word for word, because hundreds of businesses get these emails and each must read as written for them.`;
  }
  if (stepNumber === 1) {
    return `This is a FOLLOW-UP to our first email (shown below). Start with ${greet} then 2-3 short sentences, 40-70 words:\n` +
      `1. Remind them in a few words what we wrote about, e.g. "I wrote to you last week about an enquiry form for ${host || 'your website'}."\n` +
      `2. Add ONE new, useful point that is different from the first email and true for their business from the research (another product of theirs, another finding, or a simple example of how it would work for them). Never invent a client, story, result or number.\n` +
      `3. The same easy ask in new words (reply "yes" for a sample/examples). At most one question mark.`;
  }
  return `This is the LAST email. Start with ${greet} then at most 2 short sentences, polite and simple, e.g. "I have not heard back, so I will not disturb you again. If you need any website or software work in future, just reply to this email." No new pitch.`;
}

// Owner 2026-11-23: "offer our services where they are lacking; always frame it as helping their growth
// and revenue — everyone needs sales, that is the Indian market." Gap found → our service → sales benefit.
const GAP_TO_OFFER = `HOW TO PICK THE OFFER: match the ONE gap you state to the service that fixes it, and always say how it brings them more enquiries, more orders and more sales (business owners in India care about sales and growth):
- No enquiry form / buyers can't send a requirement online → an enquiry form or "Get a quote" button on their existing site; every enquiry reaches their WhatsApp and email, so no buyer is missed and more enquiries turn into orders.
- No WhatsApp button → a WhatsApp chat button on every product page; buyers message them directly, which brings more enquiries.
- Shop/WooCommerce but no online payment or ordering → online ordering with payment, so they take orders and advance payments 24x7.
- Old, slow or not mobile-friendly site → a fresh, fast mobile-friendly website that shows their products properly and builds buyer trust, so more visitors become enquiries.
- Not found on Google / poor visibility → SEO and Google Business Profile, so buyers searching for their products in their city find them first.
- No website at all → a simple business website with products and an enquiry button, so buyers who search online can find and contact them.
- Many enquiries handled on phone/WhatsApp by hand → simple software that keeps every enquiry and follow-up in one place, so no order is lost.
Say the benefit in plain words ("more enquiries", "more orders", "more sales", "grow your business online"). Never promise numbers or guaranteed results.`;

const HUMAN_TONE_SUBJECT_RULE = `\nSubject: 3-7 plain words about the finding or offer for THEM, lowercase is fine, ` +
  `e.g. "enquiry form on rasman.in", "whatsapp enquiries for jet fibre tanks". Never use the words lead, leads, ` +
  `capture, management, tools, solution, growth or marketing.`;

function buildSystemPrompt(stepNumber, portfolioItems, playbookContext, research, priorEmails, feedback, lead, { humanTone = false } = {}) {
  const portfolioText = portfolioItems.length
    // URLs deliberately left out (2026-10-07) — the hard rules forbid links in sequence emails.
    ? `\n\nSome of our recent work you can mention in plain words if it fits naturally (never as a link):\n` +
      portfolioItems.map(p => `- ${p.title}${p.description ? `: ${p.description}` : ''}`).join('\n')
    : '';
  const playbookText = ReplyQualityService.buildPlaybookText(playbookContext?.fewShotExamples);
  const notesText = ReplyQualityService.buildPlaybookNotesText(playbookContext?.notes);

  const painPoints = Array.isArray(research?.pain_points) ? research.pain_points : [];
  const emailAngles = Array.isArray(research?.email_angles) ? research.email_angles : [];
  const products = Array.isArray(research?.business?.products) ? research.business.products : [];
  const markets = Array.isArray(research?.business?.markets) ? research.business.markets : [];
  const locations = Array.isArray(research?.business?.locations) ? research.business.locations : [];
  const { angle: angleForStep } = selectAngleForStep(emailAngles, stepNumber);
  const findings = websiteFindings(research, lead);
  const hasRealResearch = painPoints.length > 0 || products.length > 0 || findings.length > 0 || Boolean(research?.summary);
  const industry = (lead?.business_category || '').trim();
  const trade = (lead?.niche || industry || 'business').trim();
  const host = siteHost(lead);
  const firstName = cleanFirstName(lead?.owner_name);

  const researchText = hasRealResearch
    ? `\n\nWHAT WE FOUND ABOUT THIS BUSINESS (from our research on their own website; this is the reason we are writing — use it):\n` +
      (research?.summary ? `About them: ${research.summary}\n` : '') +
      (products.length ? `Their products/services: ${products.join(', ')}\n` : '') +
      (locations.length ? `Their locations: ${locations.join(', ')}\n` : '') +
      (markets.length ? `Markets: ${markets.join(', ')}\n` : '') +
      (findings.length ? `Website findings you MAY state as fact:\n${findings.map(f => `- ${f}`).join('\n')}\n` : '') +
      (painPoints.length ? `Gaps our analyst noted (translate into plain words a shop owner uses; never say CRM, analytics, lead capture or engagement): ${painPoints.join('; ')}\n` : '') +
      (angleForStep ? `Suggested angle for this email: ${angleForStep}\n` : '') +
      `Only state things listed here. Never invent details about their business.`
    : industry
      ? `\n\nNo website research is available. CRM facts only: business "${lead?.hotel_name || ''}", trade "${industry}"${lead?.city ? `, city ${lead.city}` : ''}. ` +
        `Make the email specific to how a "${industry}" business gets and answers buyer enquiries, without claiming you looked at their website.`
      : `\n\nNo research or industry data is available. Do not invent business details; keep it short and simple.`;

  const priorEmailsText = buildPriorEmailsText(priorEmails);

  const subjectRules = `\n\nSubject line rules: specific to THIS business (their name, website, product or the finding), never a ` +
    `generic template like ${GENERIC_SUBJECT_EXAMPLES.map(s => `"${s}"`).join(', ')}. It must differ from every subject already sent.` +
    HUMAN_TONE_SUBJECT_RULE;

  const stageNote = stageNoteFor(stepNumber, { hasResearch: hasRealResearch && findings.length > 0, host, trade, city: lead?.city, firstName });

  const feedbackNote = feedback
    ? `\n\nA previous draft needs improvement: ${feedback} Rewrite addressing this while keeping the message natural.`
    : '';

  return `You write emails from Dreams Technology (a website and software company in Gandhinagar, Gujarat) to the owner of an Indian business. The reader is a busy Indian business owner. They must understand in 10 seconds who is writing, why we are writing to THEM, and what we offer.

${stageNote}

Language and tone:
- Simple Indian English, the way a polite Gujarati business person writes to another business: short sentences, everyday words, respectful ("ji" in the greeting is good). Not American sales style.
- Plain text. No links, no bullet points, no exclamation marks, no emojis, no em dashes.
- Never use: ${SALES_WORDS_BANNED.map(p => `"${p}"`).join(', ')}.
- Polite, never pushy. Never criticise their business; state a finding neutrally ("I could not find…") and move to the offer.
- Never mention you are an AI. Never invent facts, clients, numbers or results.

${GAP_TO_OFFER}${portfolioText}${playbookText}${notesText}${researchText}${priorEmailsText}${subjectRules}${feedbackNote}

Respond with ONLY a JSON object: {"subject": "...", "body": "..."} where body is plain text with "\\n\\n" between paragraphs. Do NOT add a sign-off, signature, P.S. or unsubscribe line — those are added automatically.`;
}

// guidance (optional): extra writing rules appended to the system prompt (directory cadence passes
// the shared human-tone rules + the lead's trade). Sequences don't pass it.
async function composeEmail(lead, stepNumber, portfolioItems, playbookContext, research, priorEmails = [], feedback = null, guidance = null, { humanTone = false } = {}) {
  const leadContext = `Business: ${lead.hotel_name}\nOwner: ${lead.owner_name || 'Unknown'}\nCity: ${lead.city || 'Unknown'}${lead.business_category ? `\nCategory: ${lead.business_category}` : ''}${lead.website ? `\nWebsite: ${lead.website}` : ''}`;

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt(stepNumber, portfolioItems, playbookContext, research, priorEmails, feedback, lead, { humanTone }) + (guidance ? `\n\n${guidance}` : '') },
      { role: 'user', content: leadContext },
    ],
  }, { purpose: 'sequence_email_compose', leadId: lead.lead_id ?? lead.id ?? null });

  const parsed = JSON.parse(response.choices[0].message.content);
  const subject = (parsed.subject || '').trim() || 'Quick question';
  let body = (parsed.body || '').trim();
  // Em dashes are the commonest AI tell and the model still slips one in now and then.
  if (humanTone) body = body.replace(/\s*[—–]\s*/g, ', ');
  return { subject, body };
}

function computeNextRunAt(sequence, stepBeforeSend) {
  const gaps = typeof sequence.initial_gaps === 'string'
    ? JSON.parse(sequence.initial_gaps || '[]')
    : (sequence.initial_gaps || []);
  const gapDays = stepBeforeSend < gaps.length
    ? Number(gaps[stepBeforeSend])
    : Number(sequence.recurring_interval_days || 7);
  return new Date(Date.now() + gapDays * 86400000);
}

async function killSequence(leadSequenceId, leadId, reason) {
  await pool.query(
    `UPDATE lead_sequences SET status = 'dead', paused_reason = $1, updated_at = NOW() WHERE id = $2`,
    [reason, leadSequenceId]
  );
  await pool.query(
    `INSERT INTO agent_actions (lead_id, action, detail, decision) VALUES ($1, 'sequence_stopped', $2, $3)`,
    [leadId, JSON.stringify({ reason }), reason]
  );
}

// Compose → spam-lint + quality-score loop → sign → render → send. Shared by processRow below
// (sequences) and the directory cadence (services/cadenceService.js), so both channels of cold
// email go through exactly one writing/quality/compliance path. `lead` needs hotel_name/owner_name/
// city/business_category/website; leadId is passed explicitly because a sequence row's own `id` is
// the lead_sequences id, not the lead's. Throws if composing fails (caller decides when to retry);
// a failed SEND is returned (sendResult.success === false), not thrown.
// quality (optional, directory cadence): { minScore, strict, attempts, holdIfBelow, guidance } —
// a stricter one-decimal gate with extra writing guidance; holdIfBelow=true means a draft that never
// reaches minScore is NOT sent (returns { held: true }) instead of the sequence default "send the
// last attempt anyway". Sequences call without it and behave exactly as before.
async function composeAndSendColdEmail({ leadId, lead, leadEmail, stepNumber, sender, research, priorEmails = [], logDetail = {}, quality = null }) {
  const minScore = quality?.minScore ?? ReplyQualityService.COLD_EMAIL_SCORE_THRESHOLD;
  const maxAttempts = quality?.attempts ?? COMPOSE_MAX_ATTEMPTS;
  const [portfolioItems, playbookContext] = await Promise.all([
    fetchPortfolioItems(),
    PlaybookService.getPlaybookContext(),
  ]);
  const unsubscribeUrl = `${getBackendUrl()}/unsubscribe?token=${SuppressionService.generateToken(leadEmail)}`;

  // Combined spam-lint + quality-score gate: up to COMPOSE_MAX_ATTEMPTS drafts, feeding both
  // the spam-trigger words and the quality reviewer's feedback back in as one revision note.
  // Whatever the last attempt scores, it's sent — this is a lint/gate on WHAT gets written,
  // never a hold on WHETHER the sequence fires (queuing 50 cold emails/tick to a human
  // approval queue would just stall the channel). Every attempt is logged to agent_actions
  // for visibility (AnalyticsView's activity feed already renders any action generically).
  let composed;
  let finalQualityScore = null;
  let feedback = null;
  let spamResult, qualityResult;
  let passed = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    composed = await composeEmail(lead, stepNumber, portfolioItems, playbookContext, research, priorEmails, feedback, quality?.guidance, { humanTone: Boolean(quality?.strict) });
    spamResult = checkSpamContent(composed.subject, composed.body);
    qualityResult = await ReplyQualityService.scoreColdEmail({
      leadId, lead, subject: composed.subject, body: composed.body, stepNumber, strict: Boolean(quality?.strict),
    });

    passed = spamResult.clean && qualityResult.score >= minScore;
    const isLastAttempt = attempt === maxAttempts;

    await pool.query(
      `INSERT INTO agent_actions (lead_id, action, detail, draft_text, score, decision) VALUES ($1, 'cold_email_scored', $2, $3, $4, $5)`,
      [
        leadId,
        JSON.stringify({ attempt, stepNumber, spamFlagged: spamResult.flagged, feedback: qualityResult.feedback, subject: composed.subject, score_exact: qualityResult.score, minScore, ...logDetail }),
        composed.body,
        Math.round(qualityResult.score), // agent_actions.score is INT; exact score is in detail
        passed ? 'send' : (isLastAttempt ? (quality?.holdIfBelow ? 'held_low_quality' : 'send_low_quality') : 'revise'),
      ]
    );

    finalQualityScore = qualityResult.score;
    if (passed || isLastAttempt) break;

    const feedbackParts = [];
    if (!spamResult.clean) feedbackParts.push(`Avoid these spam-trigger phrases: ${spamResult.flagged.join(', ')}.`);
    if (qualityResult.score < minScore) feedbackParts.push(qualityResult.feedback);
    feedback = feedbackParts.join(' ');
    console.log(`[SequenceEmail] Lead ${leadId} draft attempt ${attempt} scored ${qualityResult.score}/5 (spam-clean: ${spamResult.clean}) — recomposing`);
  }
  if (!passed && quality?.holdIfBelow) {
    return { held: true, finalQualityScore, feedback: qualityResult?.feedback || '', composed };
  }

  // Follow-ups (step > 0) thread onto the conversation so far; a step-0 cold email has no
  // logged messages yet, so getThreadHeaders returns nulls and it starts a fresh thread.
  // No open-tracking pixel on sequence emails (removed 2026-10-07): a hidden 1x1 image is a
  // classic bulk-mail signal for Gmail/Outlook filters, and opens are inflated by Apple Mail
  // privacy/scanners anyway — replies are the metric that matters. Click tracking stays (the
  // prompt asks for no links, so it rarely fires). Brevo's own open events still flow in via webhook.
  // Back as a switch (2026-10-09): SMTP senders have no Brevo open events, so the owner wants the
  // pixel to see open rates — EMAIL_OPEN_TRACKING (default on) turns it off again if inboxing drops.
  const trackingToken = generateTrackingToken();
  const openTracking = String((await getSetting('EMAIL_OPEN_TRACKING')) ?? '').trim().toLowerCase() !== 'false';
  const tracking = {
    trackUrl: (url) => buildClickUrl(trackingToken, url),
    ...(openTracking ? { pixelUrl: buildPixelUrl(trackingToken) } : {}),
  };
  const { inReplyTo, references } = await getThreadHeaders(leadId);

  // A real person's sign-off + an easy way to say no — a "stop" reply is still a reply (the
  // reply worker classifies it not_interested and ends the sequence), and it's far better for
  // sender reputation than a spam-button click. No visible unsubscribe link: this line is the
  // opt-out, backed by the List-Unsubscribe headers EmailSenderService.send() sets.
  const signature = await EmailSenderService.signatureFor(sender);
  const fullBody = `${composed.body}\n\n${signature}\n\n` +
    `If this is not useful for you, just reply "no" and we will not email you again.`;

  const { html, text } = renderEmailBody(fullBody, unsubscribeUrl, tracking, { visibleFooter: false });
  const sendResult = await EmailSenderService.send(sender, {
    to: leadEmail, subject: composed.subject, html, text,
    unsubscribeUrl, inReplyTo, references,
  });

  return { sendResult, composed, html, trackingToken, finalQualityScore };
}

async function processRow(row, sequenceCapTracker, { manual = false } = {}) {
  const leadSequenceId = row.id;
  const leadId = row.lead_id;
  const sequenceId = row.sequence_id;

  // Fresh start (services/freshResendService.js): while leads are still waiting for their original
  // first email to be re-sent, brand-new first emails wait, so the re-sends go out first. Pushed back
  // (not just skipped) so these rows don't fill every tick's batch ahead of follow-ups.
  // ...and a lead still waiting for its own re-send gets nothing else first (not even a follow-up).
  if (!manual && await FreshResend.isLeadWaiting(leadId)) {
    await pool.query(`UPDATE lead_sequences SET next_run_at = NOW() + INTERVAL '6 hours', updated_at = NOW() WHERE id = $1`, [leadSequenceId]);
    return 'deferred';
  }
  if (!manual && row.current_step === 0 && await FreshResend.isPending()) {
    await pool.query(`UPDATE lead_sequences SET next_run_at = NOW() + INTERVAL '6 hours', updated_at = NOW() WHERE id = $1`, [leadSequenceId]);
    return 'deferred';
  }

  if (row.email_status === 'bounced' || row.email_status === 'unsubscribed') {
    console.log(`[SequenceEmail] Lead ${leadId} email_status=${row.email_status} — stopping sequence`);
    await killSequence(leadSequenceId, leadId, row.email_status);
    return 'stopped';
  }

  if (!row.lead_email) {
    console.log(`[SequenceEmail] Lead ${leadId} has no email — stopping sequence`);
    await killSequence(leadSequenceId, leadId, 'no_email');
    return 'stopped';
  }

  if (await SuppressionService.isSuppressed(row.lead_email)) {
    console.log(`[SequenceEmail] ${row.lead_email} is suppressed — stopping sequence`);
    await killSequence(leadSequenceId, leadId, 'suppressed');
    return 'stopped';
  }

  // Our own addresses ended up in the lead list via scraping/imports and were being cold-emailed.
  const emailDomain = String(row.lead_email).split('@')[1]?.toLowerCase();
  if (emailDomain && (await getOwnDomains()).includes(emailDomain)) {
    console.log(`[SequenceEmail] ${row.lead_email} is one of our own domains — stopping sequence`);
    await killSequence(leadSequenceId, leadId, 'own_domain');
    return 'stopped';
  }

  if (row.current_step >= MAX_SEQUENCE_EMAILS) {
    console.log(`[SequenceEmail] Lead ${leadId} already got ${row.current_step} emails (cap ${MAX_SEQUENCE_EMAILS}) — ending sequence`);
    await killSequence(leadSequenceId, leadId, 'sequence_complete');
    return 'stopped';
  }

  // Delivery gate: don't send a follow-up (step > 0) blind — confirm the previous email in this
  // sequence was actually delivered first. A "sent" row just means Brevo's API accepted it
  // synchronously; delivered_at is only stamped once Brevo's webhook confirms real delivery. An
  // async bounce already kills the sequence via routes/brevoWebhook.js before this ever runs
  // again, so reaching here with neither delivered_at nor bounced_at just means "no webhook event
  // yet" — wait a few hours and recheck, but give up waiting past DELIVERY_CONFIRM_TIMEOUT_HOURS
  // since not every recipient server fires a delivery confirmation at all.
  if (row.current_step > 0) {
    const lastSent = await pool.query(
      `SELECT delivered_at, bounced_at, sent_at FROM email_logs
       WHERE lead_id = $1 AND sequence_id = $2 AND direction = 'out' AND error IS NULL
       ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1`,
      [leadId, sequenceId]
    );
    const last = lastSent.rows[0];
    if (last?.bounced_at) {
      console.log(`[SequenceEmail] Lead ${leadId} — previous email bounced, stopping sequence`);
      await killSequence(leadSequenceId, leadId, 'bounced');
      return 'stopped';
    }
    if (last && !last.delivered_at) {
      const hoursSinceSent = (Date.now() - new Date(last.sent_at).getTime()) / 3600000;
      if (hoursSinceSent < DELIVERY_CONFIRM_TIMEOUT_HOURS) {
        console.log(`[SequenceEmail] Lead ${leadId} — previous email not yet confirmed delivered (${hoursSinceSent.toFixed(1)}h ago) — waiting`);
        await pool.query(
          `UPDATE lead_sequences SET next_run_at = NOW() + INTERVAL '3 hours', updated_at = NOW() WHERE id = $1`,
          [leadSequenceId]
        );
        return 'awaiting_delivery';
      }
    }
  }

  // Research gate: a lead with a website must have completed research before ANY email goes out
  // — workers/researchWorker.js front-loads that crawl on its own 5-min cron, well ahead of send
  // time, so this just reads whatever's cached rather than triggering a crawl inline. A lead
  // whose research permanently failed after RESEARCH_MAX_ATTEMPTS is NOT emailed (changed
  // 2026-10-07): those produced the generic emails that got opened and ignored, and every ignored
  // cold email costs sender reputation for the good ones. Since 2026-10-09 (owner: "we can't just
  // send random email") the same holds for a lead with nothing to research — no website and a
  // free-mail address; with no website but a company-domain email, that domain is researched.
  const site = researchSiteFor({ website: row.website, email: row.lead_email });
  const noSiteAllowed = !site && await allowNoWebsiteEmail();
  if (!site && !noSiteAllowed) {
    console.log(`[SequenceEmail] Lead ${leadId} has no website or company domain to research — not sending a generic email, stopping sequence`);
    await killSequence(leadSequenceId, leadId, 'no_research_possible');
    return 'stopped';
  }
  const research = site ? await getCachedResearch(leadId) : null;
  if (!research && !noSiteAllowed) {
    if ((row.research_attempts || 0) < RESEARCH_MAX_ATTEMPTS) {
      console.log(`[SequenceEmail] Lead ${leadId} has a website but research isn't ready yet — waiting for researchWorker`);
      return 'awaiting_research';
    }
    console.log(`[SequenceEmail] Lead ${leadId} research permanently failed — not sending a generic email, stopping sequence`);
    await killSequence(leadSequenceId, leadId, 'research_failed');
    return 'stopped';
  }

  const remainingCap = sequenceCapTracker.get(sequenceId);
  if (remainingCap !== undefined && remainingCap <= 0) {
    console.log(`[SequenceEmail] Sequence ${sequenceId} hit its daily_send_limit — skipping lead ${leadId} for now`);
    return 'capacity_skip';
  }

  // First email: next sender in the 10-per-mailbox rotation. Follow-ups: the same mailbox as the
  // first email — if it's paused or full today the lead waits rather than switching mailbox.
  // A manual send (Leads → Send now) may skip the mailbox spacing gap, never the cap or a pause.
  const sender = await EmailSenderService.getSenderForLead(leadId, { ignorePacing: manual });
  if (!sender) {
    console.log(`[SequenceEmail] No sender capacity for lead ${leadId} (its mailbox is full/paused, or all senders are) — retrying in 1h`);
    // Push it back so waiting follow-ups don't fill every tick's LIMIT batch and starve leads
    // whose mailbox still has room.
    await pool.query(
      `UPDATE lead_sequences SET next_run_at = NOW() + INTERVAL '1 hour', updated_at = NOW() WHERE id = $1`,
      [leadSequenceId]
    );
    return 'no_sender';
  }

  let sent;
  try {
    sent = await composeAndSendColdEmail({
      leadId, lead: row, leadEmail: row.lead_email, stepNumber: row.current_step, sender, research,
      priorEmails: await fetchPriorSentEmails(leadId),
    });
  } catch (err) {
    console.error(`[SequenceEmail] Compose failed for lead ${leadId}:`, err.message);
    await pool.query(
      `UPDATE lead_sequences SET next_run_at = NOW() + INTERVAL '1 hour', updated_at = NOW() WHERE id = $1`,
      [leadSequenceId]
    );
    return 'deferred';
  }
  const { sendResult, composed, html, trackingToken, finalQualityScore } = sent;

  if (!sendResult.success) {
    console.error(`[SequenceEmail] Send failed for lead ${leadId}:`, sendResult.error);
    await pool.query(
      `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, error, sent_at)
       VALUES ($1, $2, $3, 'out', $4, $5, $6, NOW())`,
      [leadId, sender.id, sequenceId, composed.subject, html, sendResult.error]
    );
    await pool.query(
      `INSERT INTO agent_actions (lead_id, action, detail, draft_text, decision) VALUES ($1, 'draft_sent', $2, $3, 'error')`,
      [leadId, JSON.stringify({ error: sendResult.error, sequenceId }), composed.body]
    );

    // A 400 rejecting the "to" address itself (malformed/nonexistent recipient — e.g. Brevo's
    // "email is not valid in to") is permanent: retrying sends the identical address again and
    // will fail identically forever, just burning API calls and worker time. Stop chasing
    // immediately instead of the hourly retry below, same as a confirmed bounce.
    const isInvalidRecipient = sendResult.status === 400 &&
      /not valid|invalid.*(email|recipient|to\b)|does not exist|no such (user|recipient|mailbox)|mailbox.*(unavailable|not found)/i.test(sendResult.error || '');
    if (isInvalidRecipient) {
      console.log(`[SequenceEmail] Lead ${leadId} — permanent recipient rejection, stopping sequence: ${sendResult.error}`);
      await pool.query(`UPDATE hotel_leads SET email_status = 'bounced', updated_at = NOW() WHERE id = $1`, [leadId]);
      await SuppressionService.addToSuppression(row.lead_email, 'invalid_email');
      await killSequence(leadSequenceId, leadId, 'invalid_email');
      return 'stopped';
    }

    // Anything else (network blip, provider outage, rate limit) is treated as transient — retry
    // hourly, but only up to MAX_SEND_FAIL_ATTEMPTS total before giving up on this lead too.
    const failCount = (row.send_fail_count || 0) + 1;
    if (failCount >= MAX_SEND_FAIL_ATTEMPTS) {
      console.log(`[SequenceEmail] Lead ${leadId} — ${failCount} consecutive send failures, giving up`);
      await killSequence(leadSequenceId, leadId, 'send_failed');
      return 'stopped';
    }
    await pool.query(
      `UPDATE lead_sequences SET send_fail_count = $1, next_run_at = NOW() + INTERVAL '1 hour', updated_at = NOW() WHERE id = $2`,
      [failCount, leadSequenceId]
    );
    return 'failed';
  }

  const nextRunAt = computeNextRunAt(row, row.current_step);

  await pool.query(
    `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, provider_message_id, tracking_token, sent_at)
     VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, NOW())`,
    [leadId, sender.id, sequenceId, composed.subject, html, sendResult.messageId, trackingToken]
  );

  await pool.query(
    `UPDATE lead_sequences
     SET current_step = current_step + 1, next_run_at = $1, sender_id = $2, send_fail_count = 0, updated_at = NOW()
     WHERE id = $3`,
    [nextRunAt, sender.id, leadSequenceId]
  );

  await SequenceService.incrementSentToday(sequenceId);
  if (remainingCap !== undefined) sequenceCapTracker.set(sequenceId, remainingCap - 1);

  await pool.query(
    `INSERT INTO agent_actions (lead_id, action, detail, draft_text, score, decision) VALUES ($1, 'draft_sent', $2, $3, $4, 'send')`,
    [leadId, JSON.stringify({ subject: composed.subject, sequenceId, senderId: sender.id }), composed.body, finalQualityScore]
  );

  console.log(`[SequenceEmail] Sent step ${row.current_step + 1} to ${row.lead_email} via sender ${sender.id}`);
  return 'sent';
}

async function runSequenceWorker(trigger = 'cron') {
  if (isRunning) {
    console.log('[SequenceEmail] Previous run still in progress — skipping this tick');
    return { skipped: true, reason: 'already_running' };
  }

  // Send window: every lead in this system is an India-based business (Google Places search
  // is hard-locked to region:'in'), so IST business hours are the one recipient-timezone check
  // needed — a 3am cold email hurts reply rate and looks automated. A 'manual' trigger (the
  // "catch-up if the cron tick was missed" button in routes/agent.js) deliberately bypasses
  // this, same as it already bypasses the daily send cap — that's the whole point of the button.
  if (trigger !== 'manual') {
    const window = await isWithinSendWindow();
    if (!window.allowed) {
      console.log(`[SequenceEmail] Outside send window (IST ${window.hourIst}:00, day ${window.dayIst}; window ${window.startHour}-${window.endHour}, days ${window.days.join(',')}) — skipping this tick`);
      const stats = { skipped: true, reason: 'outside_send_window', ...window };
      await SchedulerStatusService.recordRun('email_sequences', trigger, stats);
      return stats;
    }
  }

  isRunning = true;

  const stats = { due: 0, sent: 0, stopped: 0, capacitySkip: 0, noSender: 0, awaitingResearch: 0, awaitingDelivery: 0, deferred: 0, failed: 0 };

  try {
    await SequenceService.resetStaleCounters();

    const dueResult = await pool.query(
      `SELECT ls.*, hl.email AS lead_email, hl.hotel_name, hl.owner_name, hl.city,
              hl.business_category, hl.website, hl.email_status, hl.research_attempts,
              s.initial_gaps, s.recurring_interval_days, s.daily_send_limit, s.sent_today
       FROM lead_sequences ls
       JOIN hotel_leads hl ON hl.id = ls.lead_id
       JOIN sequences s ON s.id = ls.sequence_id
       WHERE ls.next_run_at <= NOW() AND ls.status = 'active' AND s.active = TRUE
       ORDER BY (ls.current_step = 0) DESC, ls.next_run_at ASC
       LIMIT $1`,
      [BATCH_SIZE]
    );

    stats.due = dueResult.rows.length;

    if (stats.due > 0) {
      console.log(`[SequenceEmail] ${stats.due} lead(s) due for sending`);

      const sequenceCapTracker = new Map();
      for (const row of dueResult.rows) {
        if (!sequenceCapTracker.has(row.sequence_id)) {
          sequenceCapTracker.set(row.sequence_id, row.daily_send_limit - row.sent_today);
        }
      }

      for (const row of dueResult.rows) {
        const outcome = await processRow(row, sequenceCapTracker);
        if (outcome === 'sent') stats.sent++;
        else if (outcome === 'stopped') stats.stopped++;
        else if (outcome === 'capacity_skip') stats.capacitySkip++;
        else if (outcome === 'no_sender') stats.noSender++;
        else if (outcome === 'awaiting_research') stats.awaitingResearch++;
        else if (outcome === 'awaiting_delivery') stats.awaitingDelivery++;
        else if (outcome === 'deferred') stats.deferred++;
        else if (outcome === 'failed') stats.failed++;
        await new Promise(resolve => setTimeout(resolve, SEND_DELAY_MS));
      }
    }
  } catch (err) {
    console.error('[SequenceEmail] Error in sequence worker:', err.message);
    stats.error = err.message;
  } finally {
    isRunning = false;
  }

  await SchedulerStatusService.recordRun('email_sequences', trigger, stats);

  // Runs every 15 min — notifying every tick would be dozens of WhatsApp pings/day.
  // Always notify on a manual trigger; on cron, only when something actually happened.
  if (trigger === 'manual' || stats.sent > 0 || stats.failed > 0 || stats.error) {
    await notifyAdmin(
      `📧 *Email Sequences ran* (${trigger === 'manual' ? 'manual trigger' : 'auto, every 15 min'})\n\n` +
      `Due: ${stats.due}\n` +
      `✅ Sent: ${stats.sent}\n` +
      (stats.stopped ? `🛑 Sequence stopped (bounced/no email/suppressed): ${stats.stopped}\n` : '') +
      (stats.capacitySkip ? `⏳ Skipped — daily cap reached: ${stats.capacitySkip}\n` : '') +
      (stats.noSender ? `⚠️ Skipped — no sender capacity: ${stats.noSender}\n` : '') +
      (stats.awaitingResearch ? `🔬 Waiting on website research: ${stats.awaitingResearch}\n` : '') +
      (stats.awaitingDelivery ? `📬 Waiting on delivery confirmation: ${stats.awaitingDelivery}\n` : '') +
      (stats.failed ? `⚠️ Send failures: ${stats.failed}\n` : '') +
      (stats.error ? `❌ Error: ${stats.error}\n` : '')
    );
  }

  return stats;
}

// Manual "Run Now" for one lead — the same pipeline as the cron tick (research → compose →
// send → advance step/next_run_at), but ignores next_run_at and the sequence daily cap so a
// test send can always go out. Suppression/bounce checks and sender capacity still apply.
async function runSequenceForLead(leadId) {
  if (isRunning) {
    return { outcome: 'busy', message: 'Sequence worker is mid-run — try again in a minute.' };
  }
  isRunning = true;
  try {
    const result = await pool.query(
      `SELECT ls.*, hl.email AS lead_email, hl.hotel_name, hl.owner_name, hl.city,
              hl.business_category, hl.website, hl.email_status, hl.research_attempts,
              s.initial_gaps, s.recurring_interval_days, s.daily_send_limit, s.sent_today
       FROM lead_sequences ls
       JOIN hotel_leads hl ON hl.id = ls.lead_id
       JOIN sequences s ON s.id = ls.sequence_id
       WHERE ls.lead_id = $1 AND ls.status = 'active'
       ORDER BY ls.updated_at DESC
       LIMIT 1`,
      [leadId]
    );
    if (result.rows.length === 0) {
      return { outcome: 'not_enrolled', message: 'No active sequence enrollment — enroll the lead in a sequence first.' };
    }
    const row = result.rows[0];
    const stepBefore = row.current_step;
    // Empty cap tracker → processRow never sees a sequence-cap entry, so the daily cap is bypassed.
    // The research gate still applies here — a manual "Run Now" bypasses timing, not the
    // requirement that a lead with a website be researched before it gets emailed.
    const outcome = await processRow(row, new Map(), { manual: true });

    const stats = { due: 1, sent: 0, stopped: 0, capacitySkip: 0, noSender: 0, awaitingResearch: 0, awaitingDelivery: 0, deferred: 0, failed: 0, leadId };
    if (outcome === 'sent') stats.sent = 1;
    else if (outcome === 'stopped') stats.stopped = 1;
    else if (outcome === 'no_sender') stats.noSender = 1;
    else if (outcome === 'awaiting_research') stats.awaitingResearch = 1;
    else if (outcome === 'awaiting_delivery') stats.awaitingDelivery = 1;
    else if (outcome === 'deferred') stats.deferred = 1;
    else if (outcome === 'failed') stats.failed = 1;
    await SchedulerStatusService.recordRun('email_sequences', 'manual_lead', stats);

    const messages = {
      sent: `Step ${stepBefore + 1} sent to ${row.lead_email}.`,
      stopped: 'Sequence was stopped — the lead is bounced, suppressed, invalid, has no email, is on one of our own domains, already got the max 3 emails, or its website research permanently failed. The lead\'s activity log has the exact reason.',
      no_sender: 'No sender capacity right now (daily caps / warmup ramp) — try later or raise the sender cap.',
      awaiting_research: 'This lead has a website but hasn\'t been researched yet — workers/researchWorker.js checks every 5 minutes, or click "Research Now" on the lead to run it immediately.',
      awaiting_delivery: `The previous email hasn't been confirmed delivered yet — waiting up to ${DELIVERY_CONFIRM_TIMEOUT_HOURS}h for Brevo's delivery webhook before sending the next step anyway.`,
      deferred: 'Email composition failed — it will retry automatically in 1 hour.',
      failed: 'Send failed — will retry, up to 3 attempts before the sequence stops.',
    };
    if (outcome === 'no_sender') {
      // Spell out exactly which sender is blocked and why — "no capacity" alone is useless
      const senders = (await pool.query('SELECT * FROM email_senders')).rows;
      messages.no_sender = senders.length
        ? 'No sender capacity: ' + senders.map(s => {
            const cap = EmailSenderService.effectiveDailyCap(s);
            const warmupNote = s.warmup_started_at && cap < s.daily_cap ? ` (warmup, full cap ${s.daily_cap})` : '';
            return `${s.from_email} — ${s.status}, sent ${s.sent_today}/${cap} today${warmupNote}`;
          }).join(' · ') + '. Raise the daily cap in Settings → Email Senders, or wait for the midnight-UTC reset.'
        : 'No email senders configured — add one in Settings → Email Senders.';
    }
    return { outcome, step: stepBefore + 1, email: row.lead_email, message: messages[outcome] || outcome };
  } finally {
    isRunning = false;
  }
}

// Every 10 min (was 15): with EMAIL_SENDER_MIN_GAP_MINUTES each mailbox sends at most ~1 per tick, so
// 6 ticks/hour × 9 window hours ≈ 54 ≥ a 50/day cap (owner 2026-11-22: 50/mailbox/day, spread out).
schedule.scheduleJob('*/10 * * * *', () => track('email_sequences', () => runSequenceWorker('cron'), { record: false }).catch(() => {}));

console.log('📧 Sequence email worker started - checks every 15 minutes');

// composeEmail + the pure prompt-assembly helpers are exported for test/preview use — all
// side-effect-free (no send, no DB write).
module.exports = { runSequenceWorker, runSequenceForLead, composeEmail, composeAndSendColdEmail, selectAngleForStep, stripHtmlToText, buildPriorEmailsText };
