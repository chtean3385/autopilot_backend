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
const { getOrCreateResearch } = require('../services/leadResearchService');
const { trackedCompletion } = require('../utils/aiUsage');
const { renderEmailBody } = require('../utils/emailRender');
const { getBackendUrl } = require('../utils/backendUrlConfig');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const BATCH_SIZE = 50;
const SEND_DELAY_MS = 1500;

let isRunning = false;

async function fetchPortfolioItems() {
  const result = await pool.query(
    'SELECT title, url, description FROM portfolio_items ORDER BY created_at DESC LIMIT 5'
  );
  return result.rows;
}

function buildSystemPrompt(stepNumber, portfolioItems, playbookContext, research) {
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
  const researchText = (painPoints.length || recommendedServices.length || emailAngles.length)
    ? `\n\nWebsite research on THIS SPECIFIC lead (scraped from their own site — use this to make the ` +
      `email genuinely specific instead of generic; mention at least one real detail below):\n` +
      (painPoints.length ? `Pain points observed: ${painPoints.join('; ')}\n` : '') +
      (products.length ? `Products/services they offer: ${products.join('; ')}\n` : '') +
      (markets.length ? `Markets they serve: ${markets.join('; ')}\n` : '') +
      (recommendedServices.length ? `Relevant Dreams Technology services to weave in: ${recommendedServices.join('; ')}\n` : '') +
      (emailAngles.length ? `Suggested talking points: ${emailAngles.join('; ')}\n` : '') +
      `Every claim you make about their business must trace back to something in this research — never invent details beyond it.`
    : '';

  const stageNote = stepNumber === 0
    ? 'This is the FIRST email in the sequence — introduce Dreams Technology briefly and warmly.'
    : 'This is a FOLLOW-UP email — keep it short, acknowledge this is a gentle nudge, do not repeat the full pitch from scratch.';

  return `You are a sales copywriter for Dreams Technology, a business management software company in India, writing a cold outreach email to a business owner.

${stageNote}

Goals:
- Get the owner interested in a free demo of our business management software (billing, records, customer management).
- Keep it SHORT (3-6 sentences), professional, warm, no hype or spammy language.
- Never mention you are an AI.
- Do not fabricate facts about the recipient's business beyond what's given below.${portfolioText}${playbookText}${notesText}${researchText}

Respond with ONLY a JSON object: {"subject": "...", "body": "..."} where body is plain text with "\\n\\n" between paragraphs (no HTML, no signature, no unsubscribe line — those are appended separately).`;
}

// Cached per-lead (lead_research table, shared getOrCreateResearch in leadResearchService.js)
// so the site is only crawled + GPT-analyzed once per version, not once per email in the
// sequence. Returns null (silently) if there's no website to crawl or the crawl/GPT step
// fails — callers fall back to the generic prompt in that case.
async function fetchResearchForLead(lead) {
  try {
    const { research } = await getOrCreateResearch(lead);
    return research;
  } catch (err) {
    console.error(`[SequenceEmail] Research failed for lead ${lead.lead_id}:`, err.message);
    return null;
  }
}

async function composeEmail(lead, stepNumber, portfolioItems, playbookContext, research) {
  const leadContext = `Business: ${lead.hotel_name}\nOwner: ${lead.owner_name || 'Unknown'}\nCity: ${lead.city || 'Unknown'}${lead.business_category ? `\nCategory: ${lead.business_category}` : ''}${lead.website ? `\nWebsite: ${lead.website}` : ''}`;

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt(stepNumber, portfolioItems, playbookContext, research) },
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

  const [portfolioItems, playbookContext, research] = await Promise.all([
    fetchPortfolioItems(),
    PlaybookService.getPlaybookContext(),
    fetchResearchForLead(row),
  ]);
  const unsubscribeUrl = `${getBackendUrl()}/unsubscribe?token=${SuppressionService.generateToken(row.lead_email)}`;

  let composed;
  try {
    composed = await composeEmail(row, row.current_step, portfolioItems, playbookContext, research);
  } catch (err) {
    console.error(`[SequenceEmail] Compose failed for lead ${leadId}:`, err.message);
    await pool.query(
      `UPDATE lead_sequences SET next_run_at = NOW() + INTERVAL '1 hour', updated_at = NOW() WHERE id = $1`,
      [leadSequenceId]
    );
    return 'deferred';
  }

  const { html, text } = renderEmailBody(composed.body, unsubscribeUrl);
  const sendResult = await EmailSenderService.send(sender, { to: row.lead_email, subject: composed.subject, html, text });

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
    `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, provider_message_id, sent_at)
     VALUES ($1, $2, $3, 'out', $4, $5, $6, NOW())`,
    [leadId, sender.id, sequenceId, composed.subject, html, sendResult.messageId]
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
    `INSERT INTO agent_actions (lead_id, action, detail, draft_text, decision) VALUES ($1, 'draft_sent', $2, $3, 'send')`,
    [leadId, JSON.stringify({ subject: composed.subject, sequenceId, senderId: sender.id }), composed.body]
  );

  console.log(`[SequenceEmail] Sent step ${row.current_step + 1} to ${row.lead_email} via sender ${sender.id}`);
  return 'sent';
}

async function runSequenceWorker(trigger = 'cron') {
  if (isRunning) {
    console.log('[SequenceEmail] Previous run still in progress — skipping this tick');
    return { skipped: true, reason: 'already_running' };
  }
  isRunning = true;

  const stats = { due: 0, sent: 0, stopped: 0, capacitySkip: 0, noSender: 0, deferred: 0, failed: 0 };

  try {
    await SequenceService.resetStaleCounters();

    const dueResult = await pool.query(
      `SELECT ls.*, hl.email AS lead_email, hl.hotel_name, hl.owner_name, hl.city,
              hl.business_category, hl.website, hl.email_status,
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
              hl.business_category, hl.website, hl.email_status,
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
    // Empty cap tracker → processRow never sees a sequence-cap entry, so the daily cap is bypassed
    const outcome = await processRow(row, new Map());

    const stats = { due: 1, sent: 0, stopped: 0, capacitySkip: 0, noSender: 0, deferred: 0, failed: 0, leadId };
    if (outcome === 'sent') stats.sent = 1;
    else if (outcome === 'stopped') stats.stopped = 1;
    else if (outcome === 'no_sender') stats.noSender = 1;
    else if (outcome === 'deferred') stats.deferred = 1;
    else if (outcome === 'failed') stats.failed = 1;
    await SchedulerStatusService.recordRun('email_sequences', 'manual_lead', stats);

    const messages = {
      sent: `Step ${stepBefore + 1} sent to ${row.lead_email}.`,
      stopped: 'Sequence was stopped — the lead is bounced, suppressed, or has no email.',
      no_sender: 'No sender capacity right now (daily caps / warmup ramp) — try later or raise the sender cap.',
      deferred: 'Email composition failed — it will retry automatically in 1 hour.',
      failed: 'Send failed — check the email logs for the provider error.',
    };
    return { outcome, step: stepBefore + 1, email: row.lead_email, message: messages[outcome] || outcome };
  } finally {
    isRunning = false;
  }
}

schedule.scheduleJob('*/15 * * * *', () => runSequenceWorker('cron'));

console.log('📧 Sequence email worker started - checks every 15 minutes');

// composeEmail exported for test/preview use — composing is side-effect-free (no send, no DB write).
module.exports = { runSequenceWorker, runSequenceForLead, composeEmail };
