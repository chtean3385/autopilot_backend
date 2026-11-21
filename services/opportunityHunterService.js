// Opportunity Hunter (2026-11-19, _docs/opportunity-hunter.md).
//
// WhatsApp group/channel posts (services/waGroupReaderService.js, or pasted on the Opportunities page)
// → keyword pre-filter → owner's hard skip rules → GPT qualification (explicit / inferred / unknown,
// engagement type, work location, score) → one of:
//   email   — post gives an email: a short intro email draft (Drafts box; sent on Send, or automatically
//             in OPP_HUNTER_MODE=auto) from the one mailbox picked in OPP_HUNTER_SENDER_ID
//   manual  — phone only: a WhatsApp message the owner copies and sends BY HAND (we never send WhatsApp)
//   skip    — job vacancy, full-time, office/onsite/hybrid or a physical work location, not an
//             opportunity, no contact, or below OPP_HUNTER_MIN_SCORE. Kept with the reason, never sent.
//
// Owner rules: freelance/project work only. One email per opportunity, no follow-ups — when they reply
// the owner handles it (handleReply alerts them; the AI never answers these leads). Emails are a short
// capability intro: no prices, no budget talk, never mention their budget.
//
// A sent application creates a hotel_leads row with pipeline = 'opportunity'. Every other send path
// skips pipeline IS NOT NULL (follow-ups, campaigns, sequence enrollment), and whatsapp_number is left
// empty so no WhatsApp path can ever match it.

const crypto = require('crypto');
const OpenAI = require('openai');
const pool = require('../config/db');
const { getSetting } = require('./settingsService');
const EmailSenderService = require('./emailSenderService');
const SuppressionService = require('./suppressionService');
const { logAgentAction, notifyOwner } = require('./replyDeliveryService');
const { trackedCompletion, isAiAvailable } = require('../utils/aiUsage');
const { renderEmailBody } = require('../utils/emailRender');
const { getBackendUrl } = require('../utils/backendUrlConfig');
const { generateTrackingToken, buildPixelUrl } = require('../utils/emailTracking');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'missing' });
const PIPELINE = 'opportunity';
const MAX_ATTEMPTS = 3;
const AUTO_SEND_HOURS = { start: 8, end: 21 }; // IST — fresh posts are answered fast, but not at night
const AUTO_SEND_MAX_AGE_DAYS = 3;              // an auto-send never goes out for a stale post

const DREAMS_SERVICES = [
  'Custom web development', 'WordPress / WooCommerce', 'Mobile app development (Flutter, React Native)',
  'SaaS development', 'Laravel / PHP', 'React / Next.js', 'Node.js / MERN', 'AI applications, AI agents, LLM/RAG',
  'CRM / ERP / HRMS', 'Hotel / PMS software, booking systems', 'WhatsApp automation', 'API & payment gateway integration',
  'Cloud / server deployment', 'App Store / Play Store publishing', 'SEO / AEO / digital marketing',
  'Website & app maintenance / AMC',
];

// ── Text helpers ───────────────────────────────────────────────────────────────────────────────

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}@.]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
const hashText = (text) => crypto.createHash('sha256').update(normalizeText(text)).digest('hex');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Indian mobiles (with/without +91 / 0) and other +country numbers. Digits only after normalising.
const PHONE_RE = /(?:\+|00)?(?:\d[\s-]?){10,13}/g;

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) return `91${d}`;
  if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2))) return d;
  if (d.length >= 11 && d.length <= 13 && !d.startsWith('0')) return d; // other country codes
  return null;
}

// Contacts come only from the post text itself — the AI may choose between them, never add one.
function extractContacts(text) {
  const emails = [...new Set((String(text).match(EMAIL_RE) || []).map((e) => e.replace(/\.+$/, '').toLowerCase()))];
  const phones = [...new Set((String(text).match(PHONE_RE) || []).map(normalizePhone).filter(Boolean))];
  return { emails, phones };
}

// Cheap gate before any GPT call: must look like someone needing work done.
const POSITIVE_RE = /\b(hiring|hire|freelanc\w*|need(ed|s)?|looking for|require(d|ment)?|wanted|urgent(ly)?|project|developer|designer|apply|contract|website|web ?site|app|application|software|crm|erp|hrms|wordpress|woocommerce|shopify|react|node|laravel|php|flutter|seo|bench|resource|budget)\b/i;
function prefilter(text) {
  const t = String(text || '').trim();
  if (t.length < 40) return { pass: false, reason: 'too short' };
  if (!POSITIVE_RE.test(t)) return { pass: false, reason: 'no work-request keywords' };
  return { pass: true };
}

// Owner's skip rule (2026-11-19): anything that says office / in-house / onsite / hybrid, or is plainly
// an employment vacancy, is skipped. Full-time / part-time skips ONLY when the post offers no
// freelance / contract / project-based option (changed 2026-11-21: "Full-Time / Freelance / Contract"
// and "Freelance or Full-Time" remote posts are leads). A physical work location (city/address) is
// judged by the AI (work_location.type = 'office') since "Location: Remote" must not trip it.
const FLEX_OPTION_RE = /\bfreelanc\w*|\bcontract(ual|s)?\b|\bproject[\s-]?based\b/i;
const HARD_SKIP = [
  [/\bfull[\s-]?time\b/i, 'Full-time role', { unlessFlex: true }],
  [/\bpart[\s-]?time\b/i, 'Part-time role', { unlessFlex: true }],
  [/\bin[\s-]?house\b/i, 'In-house role'],
  [/\bwork(ing)?\s+from\s+(the\s+|our\s+)?([\w-]+\s+){0,2}office\b|\bWFO\b/i, 'Work from office'],
  [/\b(at|from|in)\s+(our|the)\s+([\w-]+\s+){0,2}office\b|\boffice\s+location\b|\bon[\s-]?site\b|\bonsite\b/i, 'Office / onsite work'],
  [/\bhybrid\b/i, 'Hybrid (office) role'],
  [/\bwalk[\s-]?in\b/i, 'Walk-in interview'],
  [/\bCTC\b|\bnotice\s+period\b|\bsalary\b|\bLPA\b|\bper\s+annum\b/i, 'Salaried job vacancy'],
  [/\binternship\b|\bintern\b/i, 'Internship'],
];
function hardSkipReason(text) {
  const flex = FLEX_OPTION_RE.test(String(text));
  for (const [re, reason, opts] of HARD_SKIP) {
    if (opts?.unlessFlex && flex) continue;
    const m = String(text).match(re);
    if (m) return `${reason} ("${m[0].trim()}")`;
  }
  return null;
}

// Drafts must never talk money (owner rule). Checked on every AI draft; a hit is regenerated once, then
// flagged — a flagged draft is never auto-sent.
const MONEY_RE = /₹|\brs\.?\s?\d|\binr\b|\$\s?\d|\bbudget\b|\bpric(e|es|ing)\b|\bquot(e|ation)\b|\bcost(s|ing)?\b|\bfees?\b|\bdiscount\b|\bhourly\b|\b\d{2,3}\s?k\b/i;

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ── AI steps ───────────────────────────────────────────────────────────────────────────────────

async function qualify(text, contacts) {
  const system = `You are the Opportunity Hunter for Dreams Technology, an Indian software studio. You read posts copied from WhatsApp groups/channels and decide whether Dreams Technology should apply.

Dreams Technology provides: ${DREAMS_SERVICES.join('; ')}.

We ONLY take freelance / project-based work (a client needs something built, fixed, or a freelancer/agency for a defined piece of work). We NEVER apply for employment vacancies.

engagement_type:
- "freelance": the post explicitly hires a freelancer / contract / project-based.
- "project": someone needs a deliverable built or fixed (website, app, store, App Store approval…), even if the title says "Hiring", when the work has an end point. Also a company looking for an agency / freelancer on retainer or a long-term agency partnership for a service Dreams provides (this is client work, NOT "not_opportunity").
- "staff_augmentation": a company/vendor wants a "bench resource" / contract developer supplied (remote).
- "job_vacancy": hiring an employee — e.g. "X is hiring a React Native Developer", a years-of-experience band, fixed shift/working hours, salary/CTC, "send your CV for the position", joining date — with NO freelance/project/contract wording. When a post has explicit freelance/project wording, that wins over a generic job-description layout.
- "not_opportunity": not a request for work (people offering their own services, job seekers, courses, spam, news, MLM).
- "unclear": you genuinely cannot tell.

work_location.type: "remote" (remote/WFH/pan-India/time-zone overlap only), "office" (an office, city or address is given as where the work happens, onsite, in-house), "hybrid", or "not_stated". A city mentioned only as the client's home base is not a work location.

Separate strictly: "explicit" = only what the post actually says (null when not stated); "inferred" = your reasoning; "unknown" = important facts missing. Never invent a company, budget, deadline or contact.

Scores (integers): service_fit 0-25 (how well it matches what Dreams does), clarity 0-20 (how clearly the work is described), budget_signal 0-15 (0 = no budget stated, up to 15 = clear, realistic budget), source_quality 0-10 (direct client 8-10, agency/middleman 5-7, vague 0-4).

apply_email: which email from this list the application should go to, or null: ${JSON.stringify(contacts.emails)}.

Return ONLY JSON:
{"engagement_type":"...","work_location":{"type":"...","place":null},"title":"short title (max 8 words)","client":null,
 "explicit":{"requirement":"one line","services":[],"tech_stack":[],"budget":null,"deadline":null,"work_mode":null,"apply_instructions":null},
 "inferred":{"dreams_services":[],"project_size":"small|medium|large|unknown","client_type":null,"notes":null},
 "unknown":[],"scores":{"service_fit":0,"clarity":0,"budget_signal":0,"source_quality":0},
 "tags":[],"apply_email":null,"reason":"one short sentence why apply / skip"}
tags may include: "quick_task", "ongoing_support", "middleman", "urgent".`;

  const res = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    temperature: 0.1,
    max_tokens: 700,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: String(text).slice(0, 6000) }],
  }, { purpose: 'opportunity_qualify' });
  const out = parseJson(res.choices[0].message.content);
  if (!out || !out.engagement_type) throw new Error('AI returned no usable qualification');
  return out;
}

async function portfolioList() {
  const { rows } = await pool.query(`SELECT id, title, url, description, tags FROM portfolio_items WHERE COALESCE(url, '') <> '' ORDER BY id DESC LIMIT 60`);
  return rows;
}

const DRAFT_RULES = `Rules:
- Restate their requirement in one line so they see we read it.
- Say plainly that this is exactly the kind of work we do, naming ONLY the capabilities that match their post.
- NEVER mention money: no price, rate, cost, quote, discount, and never mention or ask about their budget. Budget is discussed later by a person.
- Don't ask a list of questions. End with one soft call to action (happy to share more work / a quick call).
- Never invent facts: no years in business, client names, team size, numbers or results that aren't given to you.
- Plain, warm, human tone. Indian English is fine. No hype words ("cutting-edge", "world-class", "synergy"), no emojis.`;

async function draftEmail({ text, qual, portfolio }) {
  const system = `Write a short email from Dreams Technology applying to the opportunity below (a post from a WhatsApp group).
${DRAFT_RULES}
- Under 120 words in the body. Greeting "Hi," or "Hi <client name>," if the client name is given.
- If any portfolio item below fits, include 1-2 of them as a bullet "• <title>: <url>" — only from this list, exact URLs. If none fits, include none.
- Do NOT write a sign-off or signature (it is added automatically).
- Subject: specific to their requirement, under 9 words, ending with " – Dreams Technology".
Portfolio items: ${JSON.stringify(portfolio.map((p) => ({ title: p.title, url: p.url, about: [p.description, p.tags].filter(Boolean).join(' | ').slice(0, 160) })))}
Return ONLY JSON: {"subject":"...","body":"..."}`;
  const user = `Post:\n${String(text).slice(0, 5000)}\n\nWhat we understood:\n${JSON.stringify({ title: qual.title, client: qual.client, explicit: qual.explicit, inferred: qual.inferred })}`;
  return draftWithMoneyGuard(system, user, 'opportunity_email_draft', (d) => d && d.subject && d.body, (d) => `${d.subject}\n${d.body}`);
}

async function draftWhatsApp({ text, qual, senderName }) {
  const system = `Write a short WhatsApp message from Dreams Technology to the person who posted the opportunity below. The owner will copy it and send it from their own phone.
${DRAFT_RULES}
- Under 70 words, 2-4 short lines. Start with "Hi," — then say we saw their post about <their requirement>.
- End with "– ${senderName}, Dreams Technology (dreamstechnology.in)".
Return ONLY JSON: {"message":"..."}`;
  const user = `Post:\n${String(text).slice(0, 5000)}\n\nWhat we understood:\n${JSON.stringify({ title: qual.title, explicit: qual.explicit, inferred: qual.inferred })}`;
  return draftWithMoneyGuard(system, user, 'opportunity_wa_draft', (d) => d && d.message, (d) => d.message);
}

async function draftWithMoneyGuard(system, user, purpose, valid, textOf) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sys = attempt === 0 ? system : `${system}\nYOUR PREVIOUS DRAFT MENTIONED MONEY/BUDGET/PRICE. Remove every such mention.`;
    const res = await trackedCompletion(client, {
      model: 'gpt-4o-mini',
      temperature: 0.5,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    }, { purpose });
    const d = parseJson(res.choices[0].message.content);
    if (!valid(d)) continue;
    last = d;
    if (!MONEY_RE.test(textOf(d))) return { draft: d, warning: null };
  }
  if (!last) throw new Error('AI returned no usable draft');
  return { draft: last, warning: 'Draft mentions money/budget — edit before sending (never auto-sent)' };
}

// ── Decision ───────────────────────────────────────────────────────────────────────────────────

function freshnessPoints(receivedAt) {
  const h = (Date.now() - new Date(receivedAt || Date.now()).getTime()) / 3600000;
  return h < 24 ? 15 : h < 72 ? 10 : 5;
}

async function getMinScore() {
  const n = Number.parseInt(await getSetting('OPP_HUNTER_MIN_SCORE'), 10);
  return Number.isFinite(n) ? n : 55;
}

async function ownDomains() {
  const raw = (await getSetting('OWN_EMAIL_DOMAINS')) || 'dreamstechnology.in,dreams-technology.com';
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

// Pure decision from the AI output + facts we extracted ourselves. Exported for tests.
function decide({ qual, contacts, hardSkip, freshness, minScore, own = [] }) {
  const s = qual?.scores || {};
  const clamp = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));
  const usableEmails = contacts.emails.filter((e) => !own.includes(e.split('@')[1]));
  const email = usableEmails.includes(String(qual?.apply_email || '').toLowerCase()) ? qual.apply_email.toLowerCase() : (usableEmails[0] || null);
  const phone = contacts.phones[0] || null;
  const breakdown = {
    service_fit: clamp(s.service_fit, 25), clarity: clamp(s.clarity, 20), budget_signal: clamp(s.budget_signal, 15),
    contact: email ? 15 : phone ? 10 : 0, freshness, source_quality: clamp(s.source_quality, 10),
  };
  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const base = { score, breakdown, email, phone };

  if (hardSkip) return { ...base, decision: 'skip', reason: hardSkip };
  const type = qual?.engagement_type;
  if (type === 'job_vacancy') return { ...base, decision: 'skip', reason: `Job vacancy — ${qual.reason || 'hiring an employee'}` };
  if (type === 'not_opportunity') return { ...base, decision: 'skip', reason: `Not an opportunity — ${qual.reason || ''}`.trim() };
  if (!['freelance', 'project', 'staff_augmentation'].includes(type)) return { ...base, decision: 'skip', reason: `Unclear what they need — ${qual?.reason || ''}`.trim() };
  const loc = qual?.work_location?.type;
  if (loc === 'office' || loc === 'hybrid') {
    const place = qual.work_location.place ? ` (${qual.work_location.place})` : '';
    return { ...base, decision: 'skip', reason: `${loc === 'office' ? 'Office / onsite work' : 'Hybrid role'}${place}` };
  }
  if (!email && !phone) return { ...base, decision: 'skip', reason: 'No email or phone number in the post' };
  if (score < minScore) return { ...base, decision: 'skip', reason: `Score ${score} is below ${minScore} — ${qual.reason || ''}`.trim() };
  return { ...base, decision: email ? 'email' : 'manual', reason: qual.reason || null };
}

// ── Pipeline ───────────────────────────────────────────────────────────────────────────────────

// Store a raw post. Returns the message id, or null when this exact WhatsApp message was already stored.
async function ingestMessage({ sourceId = null, chatJid = null, waMessageId = null, sender = null, text, receivedAt = null }) {
  const body = String(text || '').trim();
  if (!body) return null;
  const { rows } = await pool.query(
    `INSERT INTO opportunity_messages (source_id, chat_jid, wa_message_id, sender, text, text_hash, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
     ON CONFLICT (chat_jid, wa_message_id) DO NOTHING RETURNING id`,
    [sourceId, chatJid, waMessageId, sender, body, hashText(body), receivedAt]
  );
  if (rows[0] && sourceId) {
    await pool.query(`UPDATE opportunity_sources SET last_message_at = NOW() WHERE id = $1`, [sourceId]);
  }
  return rows[0]?.id || null;
}

async function senderNameForDrafts() {
  const id = await getSetting('OPP_HUNTER_SENDER_ID');
  const s = id ? await EmailSenderService.getById(id).catch(() => null) : null;
  return (s?.from_name || '').trim() || 'Team';
}

// Analyse one stored message → maybe one opportunities row. Never throws for content problems; AI
// outages leave the message pending (attempts counted) so the next tick retries.
async function analyzeMessage(msg) {
  // forceApply = owner clicked "Apply anyway" on a skipped post: no pre-filter / skip rules.
  const pre = msg.forceApply ? { pass: true } : prefilter(msg.text);
  if (!pre.pass) {
    await pool.query(`UPDATE opportunity_messages SET status = 'filtered_out', error = $2 WHERE id = $1`, [msg.id, pre.reason]);
    return { outcome: 'filtered_out' };
  }
  const existing = await pool.query(`SELECT id FROM opportunities WHERE text_hash = $1`, [msg.text_hash]);
  if (existing.rows[0]) {
    await pool.query(`UPDATE opportunity_messages SET status = 'duplicate' WHERE id = $1`, [msg.id]);
    return { outcome: 'duplicate', opportunityId: existing.rows[0].id };
  }

  const contacts = extractContacts(msg.text);
  const hardSkip = msg.forceApply ? null : hardSkipReason(msg.text);
  const qual = await qualify(msg.text, contacts);
  let d = decide({ qual, contacts, hardSkip, freshness: freshnessPoints(msg.received_at), minScore: await getMinScore(), own: await ownDomains() });
  if (msg.forceApply && d.decision === 'skip' && (d.email || d.phone)) d = { ...d, decision: d.email ? 'email' : 'manual' };

  let draft = { subject: null, body: null, wa: null, warning: null };
  if (d.decision === 'email') {
    const r = await draftEmail({ text: msg.text, qual, portfolio: await portfolioList() });
    draft = { ...draft, subject: r.draft.subject, body: r.draft.body, warning: r.warning };
  } else if (d.decision === 'manual') {
    const r = await draftWhatsApp({ text: msg.text, qual, senderName: await senderNameForDrafts() });
    draft = { ...draft, wa: r.draft.message, warning: r.warning };
  }

  const status = d.decision === 'email' ? 'draft' : d.decision === 'manual' ? 'manual' : 'skipped';
  const sourceName = msg.source_id
    ? (await pool.query(`SELECT COALESCE(name, link) AS n FROM opportunity_sources WHERE id = $1`, [msg.source_id])).rows[0]?.n || null
    : 'Pasted';
  const { rows } = await pool.query(
    `INSERT INTO opportunities
       (message_id, text_hash, source_name, post_text, title, engagement_type, decision, skip_reason, score, score_breakdown,
        explicit, inferred, unknown, email, phone, status, draft_subject, draft_body, draft_warning, wa_draft)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (text_hash) DO NOTHING RETURNING id`,
    [msg.id, msg.text_hash, sourceName, msg.text, qual.title || null, qual.engagement_type, d.decision,
      d.decision === 'skip' ? d.reason : null, d.score, JSON.stringify(d.breakdown),
      JSON.stringify({ client: qual.client || null, ...(qual.explicit || {}), work_location: qual.work_location || null }),
      JSON.stringify({ ...(qual.inferred || {}), tags: qual.tags || [], reason: qual.reason || null }),
      JSON.stringify(qual.unknown || []), d.email, d.phone, status,
      draft.subject, draft.body, draft.warning, draft.wa]
  );
  await pool.query(`UPDATE opportunity_messages SET status = 'analyzed', error = NULL WHERE id = $1`, [msg.id]);
  return { outcome: status, opportunityId: rows[0]?.id || null };
}

let processing = false;
async function processPending(limit = 10) {
  if (processing) return { skipped: 'already_running' };
  processing = true;
  const stats = {};
  try {
    if (!isAiAvailable()) return { skipped: 'ai_unavailable' };
    const { rows } = await pool.query(
      `SELECT * FROM opportunity_messages WHERE status = 'pending' AND attempts < $1 ORDER BY id LIMIT $2`, [MAX_ATTEMPTS, limit]);
    for (const msg of rows) {
      try {
        const r = await analyzeMessage(msg);
        stats[r.outcome] = (stats[r.outcome] || 0) + 1;
      } catch (err) {
        stats.errors = (stats.errors || 0) + 1;
        await pool.query(
          `UPDATE opportunity_messages SET attempts = attempts + 1, error = $2,
             status = CASE WHEN attempts + 1 >= $3 THEN 'error' ELSE status END WHERE id = $1`,
          [msg.id, String(err.message).slice(0, 300), MAX_ATTEMPTS]);
        console.error(`[OppHunter] analyse message ${msg.id} failed:`, err.message);
        if (!isAiAvailable()) break;
      }
    }
    return stats;
  } finally {
    processing = false;
  }
}

// Pasted on the page (or forwarded): analysed right away. Same text again → the existing opportunity.
async function analyzeText(text) {
  const body = String(text || '').trim();
  if (body.length < 10) throw new Error('Paste the full post text');
  const hash = hashText(body);
  const existing = await pool.query(`SELECT id FROM opportunities WHERE text_hash = $1`, [hash]);
  if (existing.rows[0]) return { duplicate: true, opportunity: await getById(existing.rows[0].id) };
  await ingestMessage({ chatJid: 'manual', waMessageId: `manual-${hash.slice(0, 32)}`, sender: 'pasted', text: body });
  const msg = (await pool.query(`SELECT * FROM opportunity_messages WHERE chat_jid = 'manual' AND wa_message_id = $1`, [`manual-${hash.slice(0, 32)}`])).rows[0];
  const r = await analyzeMessage(msg);
  if (r.outcome === 'filtered_out') return { filteredOut: true, reason: (await pool.query(`SELECT error FROM opportunity_messages WHERE id = $1`, [msg.id])).rows[0]?.error };
  return { duplicate: r.outcome === 'duplicate', opportunity: r.opportunityId ? await getById(r.opportunityId) : null };
}

async function getById(id) {
  return (await pool.query(`SELECT * FROM opportunities WHERE id = $1`, [id])).rows[0] || null;
}

// ── Sending (email only — WhatsApp is always sent by hand) ──────────────────────────────────────

async function getChosenSender() {
  const id = await getSetting('OPP_HUNTER_SENDER_ID');
  if (!id) return { error: 'Pick the mailbox to send from first (top of the Opportunities page)' };
  await EmailSenderService.resetStaleCounters();
  const sender = await EmailSenderService.getById(id);
  if (!sender) return { error: 'The chosen mailbox no longer exists — pick another one' };
  if (sender.status !== 'active') return { error: `Mailbox "${sender.label}" is paused — activate it in Settings → Email Senders` };
  return { sender };
}

async function sendOpportunity(id, { trigger = 'manual' } = {}) {
  const claimed = await pool.query(
    `UPDATE opportunities SET status = 'sending', updated_at = NOW() WHERE id = $1 AND status IN ('draft', 'failed') RETURNING *`, [id]);
  const opp = claimed.rows[0];
  if (!opp) return { ok: false, error: 'Already sent, or not an email draft' };
  const fail = async (error, status = 'failed') => {
    await pool.query(`UPDATE opportunities SET status = $2, error = $3, updated_at = NOW() WHERE id = $1`, [id, status, error]);
    return { ok: false, error };
  };

  try {
    if (!opp.email) return fail('No email address on this opportunity');
    if (!opp.draft_subject || !opp.draft_body) return fail('Draft is empty');
    const { sender, error } = await getChosenSender();
    if (error) return fail(error);
    if (!EmailSenderService.hasCapacity(sender)) return fail(`Mailbox "${sender.label}" reached today's sending cap — send again tomorrow`);
    if ((await ownDomains()).includes(opp.email.split('@')[1])) return fail('That address is on our own domain', 'skipped');
    if (await SuppressionService.isSuppressed(opp.email)) return fail('This address unsubscribed / bounced before', 'skipped');

    // One application per address: an earlier opportunity lead, or any other CRM lead, means skip.
    const prior = (await pool.query(`SELECT id, pipeline FROM hotel_leads WHERE LOWER(email) = LOWER($1) LIMIT 1`, [opp.email])).rows[0];
    if (prior && prior.pipeline !== PIPELINE) return fail(`Already a lead in the CRM (lead #${prior.id}) — contact them from there`, 'skipped');
    if (prior) {
      const recent = (await pool.query(
        `SELECT 1 FROM opportunities WHERE lead_id = $1 AND id <> $2 AND sent_at > NOW() - INTERVAL '60 days' LIMIT 1`, [prior.id, id])).rows[0];
      if (recent) return fail('We already applied to this address in the last 60 days', 'skipped');
    }

    let leadId = prior?.id;
    if (!leadId) {
      const ex = typeof opp.explicit === 'string' ? JSON.parse(opp.explicit) : (opp.explicit || {});
      const name = String(ex.client || opp.title || opp.email).slice(0, 250);
      leadId = (await pool.query(
        `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, source, status, channel, website,
                                  email_status, email_source, phone, business_category, pipeline)
         VALUES ($1, '', $2, '', '', 'opportunity_hunter', 'contacted', 'email', '', 'found', 'opportunity_post', $3, 'Opportunity', $4)
         RETURNING id`,
        [name, opp.email, opp.phone || null, PIPELINE])).rows[0].id;
    }

    const unsubscribeUrl = `${getBackendUrl()}/unsubscribe?token=${SuppressionService.generateToken(opp.email)}`;
    const openTracking = String((await getSetting('EMAIL_OPEN_TRACKING')) ?? '').trim().toLowerCase() !== 'false';
    const trackingToken = openTracking ? generateTrackingToken() : null;
    const signed = `${opp.draft_body.trim()}\n\n${await EmailSenderService.signatureFor(sender)}`;
    // Personal note: no visible unsubscribe footer, no click-rewritten links (List-Unsubscribe header stays).
    const { html, text } = renderEmailBody(signed, unsubscribeUrl, trackingToken ? { pixelUrl: buildPixelUrl(trackingToken) } : {}, { visibleFooter: false });
    const result = await EmailSenderService.send(sender, { to: opp.email, subject: opp.draft_subject, html, text, unsubscribeUrl });

    if (!result.success) {
      await pool.query(
        `INSERT INTO email_logs (lead_id, sender_id, direction, subject, body, error, sent_at) VALUES ($1, $2, 'out', $3, $4, $5, NOW())`,
        [leadId, sender.id, opp.draft_subject, html, result.error]);
      await pool.query(`UPDATE opportunities SET lead_id = $2, sender_id = $3 WHERE id = $1`, [id, leadId, sender.id]);
      return fail(`Send failed: ${result.error}`);
    }
    await pool.query(
      `INSERT INTO email_logs (lead_id, sender_id, direction, subject, body, provider_message_id, tracking_token, sent_at)
       VALUES ($1, $2, 'out', $3, $4, $5, $6, NOW())`,
      [leadId, sender.id, opp.draft_subject, html, result.messageId, trackingToken]);
    await pool.query(
      `UPDATE opportunities SET status = 'sent', lead_id = $2, sender_id = $3, sent_at = NOW(), error = NULL, updated_at = NOW() WHERE id = $1`,
      [id, leadId, sender.id]);
    await pool.query(`UPDATE hotel_leads SET status = 'contacted', updated_at = NOW() WHERE id = $1 AND status = 'new'`, [leadId]);
    await sendOwnerCopy(sender, { to: opp.email, subject: opp.draft_subject, signed, unsubscribeUrl });
    await logAgentAction(leadId, 'opportunity_email_sent', {
      detail: { opportunityId: id, subject: opp.draft_subject, to: opp.email, trigger, dryRun: !!result.dryRun },
      draftText: opp.draft_body, score: null, decision: 'send',
    });
    return { ok: true, leadId, dryRun: !!result.dryRun };
  } catch (err) {
    console.error(`[OppHunter] send ${id} failed:`, err.message);
    return fail(err.message);
  }
}

// Owner's own copy of each application (settings OPP_HUNTER_COPY_TO). A separate send, not a BCC,
// because the client's email carries the open pixel: a BCC copy opened in the owner's inbox would
// mark the client as "opened". Never fails the application; not logged in email_logs.
async function sendOwnerCopy(sender, { to, subject, signed, unsubscribeUrl }) {
  try {
    const copyTo = String((await getSetting('OPP_HUNTER_COPY_TO')) || '').trim();
    if (!copyTo || copyTo.toLowerCase() === String(to).toLowerCase()) return;
    const note = `[Copy for you: this application was sent to ${to} from ${sender.from_email}]

`;
    const { html, text } = renderEmailBody(note + signed, unsubscribeUrl, {}, { visibleFooter: false });
    const r = await EmailSenderService.send(sender, { to: copyTo, subject: `[Sent] ${subject}`, html, text });
    if (!r.success) console.warn(`[OppHunter] copy to owner failed: ${r.error}`);
  } catch (err) {
    console.warn('[OppHunter] copy to owner failed:', err.message);
  }
}

function istHourNow() {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
}

// OPP_HUNTER_MODE=auto only: send the best fresh drafts, up to OPP_HUNTER_DAILY_CAP today (IST).
async function autoSendTick() {
  const mode = String((await getSetting('OPP_HUNTER_MODE')) || 'draft').toLowerCase();
  if (mode !== 'auto') return { skipped: 'draft_mode' };
  const h = istHourNow();
  if (h < AUTO_SEND_HOURS.start || h >= AUTO_SEND_HOURS.end) return { skipped: 'outside_hours' };
  if (!(await getSetting('OPP_HUNTER_SENDER_ID'))) return { skipped: 'no_mailbox' };
  const cap = Number.parseInt(await getSetting('OPP_HUNTER_DAILY_CAP'), 10) || 20;
  const sentToday = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM opportunities WHERE sent_at >= (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC')`)).rows[0].n;
  const room = cap - sentToday;
  if (room <= 0) return { skipped: 'daily_cap' };
  const { rows } = await pool.query(
    `SELECT id FROM opportunities WHERE status = 'draft' AND draft_warning IS NULL
       AND created_at > NOW() - ($1 || ' days')::interval ORDER BY score DESC, id LIMIT $2`,
    [String(AUTO_SEND_MAX_AGE_DAYS), Math.min(room, 5)]);
  const out = { sent: 0, failed: 0 };
  for (const r of rows) {
    const res = await sendOpportunity(r.id, { trigger: 'auto' });
    if (res.ok) out.sent++; else out.failed++;
  }
  return out;
}

// ── Replies (from emailReplyWorker) — never answered by AI; the owner takes over ────────────────

async function handleReply(lead, { subject, text, sender }) {
  const upd = await pool.query(
    `UPDATE opportunities SET status = 'replied', replied_at = NOW(), updated_at = NOW()
     WHERE lead_id = $1 AND status IN ('sent', 'replied') RETURNING id, title`, [lead.id]);
  await pool.query(`UPDATE hotel_leads SET status = 'responded', updated_at = NOW() WHERE id = $1`, [lead.id]);
  await logAgentAction(lead.id, 'opportunity_reply_received', { detail: { subject }, decision: 'owner_handles' });
  const title = upd.rows[0]?.title || lead.hotel_name;
  const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  await notifyOwner(sender, lead, 'Opportunity replied',
    `${lead.hotel_name} (${lead.email}) replied to your application "${title}": "${snippet}" — reply from the Email page or your mailbox.`)
    .catch((e) => console.error('[OppHunter] owner notify failed:', e.message));
}

module.exports = {
  PIPELINE, ingestMessage, processPending, analyzeText, analyzeMessage, getById, sendOpportunity, autoSendTick,
  handleReply, getChosenSender,
  // exported for tests
  _internal: { prefilter, hardSkipReason, extractContacts, normalizePhone, decide, hashText, MONEY_RE },
};
