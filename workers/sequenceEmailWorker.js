const schedule = require('node-schedule');
const OpenAI = require('openai');
const pool = require('../config/db');
const EmailSenderService = require('../services/emailSenderService');
const SuppressionService = require('../services/suppressionService');
const SequenceService = require('../services/sequenceService');
const PlaybookService = require('../services/playbookService');
const ReplyQualityService = require('../services/replyQualityService');
const SchedulerStatusService = require('../services/schedulerStatusService');
const { notifyAdmin } = require('../services/adminNotifyService');
const { getCachedResearch, RESEARCH_MAX_ATTEMPTS } = require('../services/leadResearchService');
const { trackedCompletion } = require('../utils/aiUsage');
const { renderEmailBody } = require('../utils/emailRender');
const { getBackendUrl } = require('../utils/backendUrlConfig');
const { checkSpamContent } = require('../utils/spamCheck');
const { generateTrackingToken, buildPixelUrl, buildClickUrl } = require('../utils/emailTracking');
const { getThreadHeaders } = require('../utils/emailThreading');
const { isWithinSendWindow } = require('../utils/sendWindow');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const BATCH_SIZE = 50;
const SEND_DELAY_MS = 1500;
const COMPOSE_MAX_ATTEMPTS = 2; // 1 draft + 1 feedback-driven revision, bounded for a 50-lead batch
const PRIOR_EMAILS_LIMIT = 5;

let isRunning = false;

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
  const result = await pool.query(
    `SELECT subject, body FROM email_logs
     WHERE lead_id = $1 AND direction = 'out' AND sequence_id IS NOT NULL AND error IS NULL
     ORDER BY COALESCE(sent_at, created_at) DESC LIMIT $2`,
    [leadId, PRIOR_EMAILS_LIMIT]
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

function buildSystemPrompt(stepNumber, portfolioItems, playbookContext, research, priorEmails, feedback, lead) {
  const portfolioText = portfolioItems.length
    ? `\n\nSome of our recent work you can reference if it fits naturally:\n` +
      portfolioItems.map(p => `- ${p.title}${p.url ? ` (${p.url})` : ''}${p.description ? `: ${p.description}` : ''}`).join('\n')
    : '';
  const playbookText = ReplyQualityService.buildPlaybookText(playbookContext?.fewShotExamples);
  const notesText = ReplyQualityService.buildPlaybookNotesText(playbookContext?.notes);

  const painPoints = Array.isArray(research?.pain_points) ? research.pain_points : [];
  const recommendedServices = Array.isArray(research?.recommended_services) ? research.recommended_services : [];
  const emailAngles = Array.isArray(research?.email_angles) ? research.email_angles : [];
  const products = Array.isArray(research?.business?.products) ? research.business.products : [];
  const markets = Array.isArray(research?.business?.markets) ? research.business.markets : [];
  const { angle: angleForStep, others: otherAngles } = selectAngleForStep(emailAngles, stepNumber);
  const hasRealResearch = painPoints.length > 0 || recommendedServices.length > 0 || emailAngles.length > 0;
  const industry = (lead?.business_category || '').trim();

  // Three branches: real per-lead website research (best case) → CRM-only industry fallback
  // (no website, or research permanently failed after RESEARCH_MAX_ATTEMPTS — sequenceEmailWorker's
  // gate lets these through rather than blocking the lead forever) → bare minimum if neither
  // exists. The middle branch is what used to be missing: a lead with no research previously fell
  // straight through to a bare "sell a software demo" prompt with zero lead-specific grounding,
  // which is exactly what produced the generic emails this whole rewrite is fixing.
  const researchText = hasRealResearch
    ? `\n\nWebsite research on THIS SPECIFIC lead (scraped from their own site — this is what makes ` +
      `the email specific instead of generic; the subject line AND the body must each use at least ` +
      `one real detail below):\n` +
      (painPoints.length ? `Pain points observed: ${painPoints.join('; ')}\n` : '') +
      (products.length ? `Products/services they offer: ${products.join('; ')}\n` : '') +
      (markets.length ? `Markets they serve: ${markets.join('; ')}\n` : '') +
      (recommendedServices.length ? `Relevant Dreams Technology services to weave in: ${recommendedServices.join('; ')}\n` : '') +
      (angleForStep ? `The specific angle to lead with in THIS email: ${angleForStep}\n` : '') +
      (otherAngles.length ? `Other angles reserved for other emails in this sequence — do NOT use these here: ${otherAngles.join('; ')}\n` : '') +
      `Every claim you make about their business must trace back to something in this research — never invent details beyond it.`
    : industry
      ? `\n\nNo website research is available for this lead (no site to crawl, or the crawl/analysis ` +
        `permanently failed) — you must still make this email SPECIFIC TO THEIR INDUSTRY using only ` +
        `this CRM fact: Industry/category: "${industry}"${lead?.city ? `, City: ${lead.city}` : ''}. ` +
        `Reference something concretely true of how a "${industry}" business actually runs day to day ` +
        `(what they juggle — bookings/orders, walk-ins, staff schedules, follow-ups, records — pick ` +
        `whatever is genuinely plausible for THIS industry) so the email reads as written for them, not ` +
        `as an industry-agnostic template. Do NOT claim to have looked at their website or found anything ` +
        `on it — none was available, and inventing a website detail would be a fabrication.`
      : `\n\nNo research or industry data is available for this lead — do not invent business details. ` +
        `Keep the email short and ask a genuinely open question about how they currently handle ` +
        `bookings, records, or customer follow-ups, instead of pitching a generic feature list.`;

  const priorEmailsText = buildPriorEmailsText(priorEmails);

  const subjectRules = `\n\nSubject line rules: it must reference something concrete and specific to ` +
    `this lead — their industry, their business name, or the angle/pain point above — never a ` +
    `generic template. Never write a subject resembling any of these (too generic, could be sent ` +
    `to any business): ${GENERIC_SUBJECT_EXAMPLES.map(s => `"${s}"`).join(', ')}. It must also differ ` +
    `from every subject already sent, listed below if any.`;

  // Three tiers instead of a flat first/follow-up split — a step-4 nudge should read very
  // differently from a step-1 nudge, both in length and in how much it still "pitches." Step 0
  // is now an explicit 3-beat structure (intro → their specific situation → soft question) instead
  // of a loose "introduce warmly then pitch" instruction, which is what let the model collapse
  // straight into a feature-dump sales pitch with no actual introduction first.
  const stageNote = stepNumber === 0
    ? `This is the FIRST email in the sequence. Write it in exactly this order — do not skip a beat ` +
      `or jump straight to a pitch:\n` +
      `1. One short, warm sentence introducing yourself and Dreams Technology by name. No selling yet.\n` +
      `2. 1-2 sentences naming a SPECIFIC, concrete observation about THEIR business, using the ` +
      `research/angle or industry detail below — this must read like you actually looked into them, ` +
      `never like a form letter.\n` +
      `3. Close with ONE soft, curiosity-driven question inviting a reply (e.g. "is that something ` +
      `you've already got sorted, or still fairly manual?") — NOT "let me know if you'd like a free ` +
      `demo." Do not pitch product features or list services in this email; the goal is a reply, not a ` +
      `booked demo.`
    : stepNumber === 1
      ? 'This is the FIRST FOLLOW-UP — a brief, low-pressure nudge. Acknowledge you reached out before without repeating what you said last time; lead with the new angle/industry detail above instead of restating the original message. Still no hard pitch — end with an easy, low-effort question.'
      : 'This is a LATER FOLLOW-UP — keep it very short (2-4 sentences), low-key, "just circling back" energy. Assume they are busy; give one simple, easy next step rather than re-pitching.';

  const feedbackNote = feedback
    ? `\n\nA previous draft needs improvement: ${feedback} Rewrite addressing this while keeping the message natural.`
    : '';

  return `You are a sales copywriter for Dreams Technology, a business management software company in India, writing a cold outreach email to a business owner.

${stageNote}

Goals:
- Earn a reply — the goal of this email is to start a conversation, not to close a demo booking in message 1.
- Keep it SHORT (3-6 sentences for the first email or first follow-up; 2-4 sentences for later follow-ups), professional, warm, no hype or spammy language.
- Never mention you are an AI.
- Do not fabricate facts about the recipient's business beyond what's given below.${portfolioText}${playbookText}${notesText}${researchText}${priorEmailsText}${subjectRules}${feedbackNote}

Respond with ONLY a JSON object: {"subject": "...", "body": "..."} where body is plain text with "\\n\\n" between paragraphs (no HTML, no signature, no unsubscribe line — those are appended separately).`;
}

async function composeEmail(lead, stepNumber, portfolioItems, playbookContext, research, priorEmails = [], feedback = null) {
  const leadContext = `Business: ${lead.hotel_name}\nOwner: ${lead.owner_name || 'Unknown'}\nCity: ${lead.city || 'Unknown'}${lead.business_category ? `\nCategory: ${lead.business_category}` : ''}${lead.website ? `\nWebsite: ${lead.website}` : ''}`;

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt(stepNumber, portfolioItems, playbookContext, research, priorEmails, feedback, lead) },
      { role: 'user', content: leadContext },
    ],
  }, { purpose: 'sequence_email_compose', leadId: lead.lead_id ?? lead.id ?? null });

  const parsed = JSON.parse(response.choices[0].message.content);
  const subject = (parsed.subject || '').trim() || 'Quick question';
  const body = (parsed.body || '').trim();
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

async function processRow(row, sequenceCapTracker) {
  const leadSequenceId = row.id;
  const leadId = row.lead_id;
  const sequenceId = row.sequence_id;

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

  // Research gate: a lead with a website must have completed research before ANY email goes out
  // — workers/researchWorker.js front-loads that crawl on its own 5-min cron, well ahead of send
  // time, so this just reads whatever's cached rather than triggering a crawl inline. A lead with
  // no website at all, or whose research permanently failed after RESEARCH_MAX_ATTEMPTS, falls
  // through and composes from the CRM-only industry fallback in buildSystemPrompt instead of
  // waiting forever on a crawl that can never succeed.
  const research = row.website ? await getCachedResearch(leadId) : null;
  if (row.website && !research && (row.research_attempts || 0) < RESEARCH_MAX_ATTEMPTS) {
    console.log(`[SequenceEmail] Lead ${leadId} has a website but research isn't ready yet — waiting for researchWorker`);
    return 'awaiting_research';
  }

  const remainingCap = sequenceCapTracker.get(sequenceId);
  if (remainingCap !== undefined && remainingCap <= 0) {
    console.log(`[SequenceEmail] Sequence ${sequenceId} hit its daily_send_limit — skipping lead ${leadId} for now`);
    return 'capacity_skip';
  }

  const sender = await EmailSenderService.getSenderForLead(leadId);
  if (!sender) {
    console.log(`[SequenceEmail] No sender capacity available — skipping lead ${leadId} for now`);
    return 'no_sender';
  }

  const [portfolioItems, playbookContext, priorEmails] = await Promise.all([
    fetchPortfolioItems(),
    PlaybookService.getPlaybookContext(),
    fetchPriorSentEmails(leadId),
  ]);
  const unsubscribeUrl = `${getBackendUrl()}/unsubscribe?token=${SuppressionService.generateToken(row.lead_email)}`;

  let composed;
  let finalQualityScore = null;
  try {
    // Combined spam-lint + quality-score gate: up to COMPOSE_MAX_ATTEMPTS drafts, feeding both
    // the spam-trigger words and the quality reviewer's feedback back in as one revision note.
    // Whatever the last attempt scores, it's sent — this is a lint/gate on WHAT gets written,
    // never a hold on WHETHER the sequence fires (queuing 50 cold emails/tick to a human
    // approval queue would just stall the channel). Every attempt is logged to agent_actions
    // for visibility (AnalyticsView's activity feed already renders any action generically).
    let feedback = null;
    let spamResult, qualityResult;
    for (let attempt = 1; attempt <= COMPOSE_MAX_ATTEMPTS; attempt++) {
      composed = await composeEmail(row, row.current_step, portfolioItems, playbookContext, research, priorEmails, feedback);
      spamResult = checkSpamContent(composed.subject, composed.body);
      qualityResult = await ReplyQualityService.scoreColdEmail({
        leadId, lead: row, subject: composed.subject, body: composed.body, stepNumber: row.current_step,
      });

      const passed = spamResult.clean && qualityResult.score >= ReplyQualityService.COLD_EMAIL_SCORE_THRESHOLD;
      const isLastAttempt = attempt === COMPOSE_MAX_ATTEMPTS;

      await pool.query(
        `INSERT INTO agent_actions (lead_id, action, detail, draft_text, score, decision) VALUES ($1, 'cold_email_scored', $2, $3, $4, $5)`,
        [
          leadId,
          JSON.stringify({ attempt, stepNumber: row.current_step, spamFlagged: spamResult.flagged, feedback: qualityResult.feedback, subject: composed.subject }),
          composed.body,
          qualityResult.score,
          passed ? 'send' : (isLastAttempt ? 'send_low_quality' : 'revise'),
        ]
      );

      finalQualityScore = qualityResult.score;
      if (passed || isLastAttempt) break;

      const feedbackParts = [];
      if (!spamResult.clean) feedbackParts.push(`Avoid these spam-trigger phrases: ${spamResult.flagged.join(', ')}.`);
      if (qualityResult.score < ReplyQualityService.COLD_EMAIL_SCORE_THRESHOLD) feedbackParts.push(qualityResult.feedback);
      feedback = feedbackParts.join(' ');
      console.log(`[SequenceEmail] Lead ${leadId} draft attempt ${attempt} scored ${qualityResult.score}/5 (spam-clean: ${spamResult.clean}) — recomposing`);
    }
  } catch (err) {
    console.error(`[SequenceEmail] Compose failed for lead ${leadId}:`, err.message);
    await pool.query(
      `UPDATE lead_sequences SET next_run_at = NOW() + INTERVAL '1 hour', updated_at = NOW() WHERE id = $1`,
      [leadSequenceId]
    );
    return 'deferred';
  }

  // Follow-ups (step > 0) thread onto the conversation so far; a step-0 cold email has no
  // logged messages yet, so getThreadHeaders returns nulls and it starts a fresh thread.
  const trackingToken = generateTrackingToken();
  const tracking = { pixelUrl: buildPixelUrl(trackingToken), trackUrl: (url) => buildClickUrl(trackingToken, url) };
  const { inReplyTo, references } = await getThreadHeaders(leadId);

  const { html, text } = renderEmailBody(composed.body, unsubscribeUrl, tracking);
  const sendResult = await EmailSenderService.send(sender, {
    to: row.lead_email, subject: composed.subject, html, text,
    unsubscribeUrl, inReplyTo, references,
  });

  if (!sendResult.success) {
    console.error(`[SequenceEmail] Send failed for lead ${leadId}:`, sendResult.error);
    await pool.query(
      `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, error, sent_at)
       VALUES ($1, $2, $3, 'out', $4, $5, $6, NOW())`,
      [leadId, sender.id, sequenceId, composed.subject, html, sendResult.error]
    );
    await pool.query(
      `UPDATE lead_sequences SET next_run_at = NOW() + INTERVAL '1 hour', updated_at = NOW() WHERE id = $1`,
      [leadSequenceId]
    );
    await pool.query(
      `INSERT INTO agent_actions (lead_id, action, detail, draft_text, decision) VALUES ($1, 'draft_sent', $2, $3, 'error')`,
      [leadId, JSON.stringify({ error: sendResult.error, sequenceId }), composed.body]
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
     SET current_step = current_step + 1, next_run_at = $1, sender_id = $2, updated_at = NOW()
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

  const stats = { due: 0, sent: 0, stopped: 0, capacitySkip: 0, noSender: 0, awaitingResearch: 0, deferred: 0, failed: 0 };

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
       ORDER BY ls.next_run_at ASC
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
    const outcome = await processRow(row, new Map());

    const stats = { due: 1, sent: 0, stopped: 0, capacitySkip: 0, noSender: 0, awaitingResearch: 0, deferred: 0, failed: 0, leadId };
    if (outcome === 'sent') stats.sent = 1;
    else if (outcome === 'stopped') stats.stopped = 1;
    else if (outcome === 'no_sender') stats.noSender = 1;
    else if (outcome === 'awaiting_research') stats.awaitingResearch = 1;
    else if (outcome === 'deferred') stats.deferred = 1;
    else if (outcome === 'failed') stats.failed = 1;
    await SchedulerStatusService.recordRun('email_sequences', 'manual_lead', stats);

    const messages = {
      sent: `Step ${stepBefore + 1} sent to ${row.lead_email}.`,
      stopped: 'Sequence was stopped — the lead is bounced, suppressed, or has no email.',
      no_sender: 'No sender capacity right now (daily caps / warmup ramp) — try later or raise the sender cap.',
      awaiting_research: 'This lead has a website but hasn\'t been researched yet — workers/researchWorker.js checks every 5 minutes, or click "Research Now" on the lead to run it immediately.',
      deferred: 'Email composition failed — it will retry automatically in 1 hour.',
      failed: 'Send failed — check the email logs for the provider error.',
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

schedule.scheduleJob('*/15 * * * *', () => runSequenceWorker('cron'));

console.log('📧 Sequence email worker started - checks every 15 minutes');

// composeEmail + the pure prompt-assembly helpers are exported for test/preview use — all
// side-effect-free (no send, no DB write).
module.exports = { runSequenceWorker, runSequenceForLead, composeEmail, selectAngleForStep, stripHtmlToText, buildPriorEmailsText };
