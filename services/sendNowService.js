const pool = require('../config/db');
const SuppressionService = require('./suppressionService');
const FreshResend = require('./freshResendService');
const { getCachedResearch, getOrCreateResearch, researchSiteFor, RESEARCH_MAX_ATTEMPTS } = require('./leadResearchService');
const { getFreshStartAt } = require('../utils/freshStart');
const { isAiAvailable } = require('../utils/aiUsage');

// Leads page → "Send now" (POST /api/leads/:id/send-now). Sends this lead's next EMAIL right now and
// answers in plain English, so the owner always sees what happened:
//   { sent: true,  channel: 'email', to, subject, sender, message }
//   { sent: false, reason, cooldown? }
//
// Email only, never WhatsApp: the button lives on the Email tab, and with WHATSAPP_OUTREACH_ENABLED=false
// nothing may start a WhatsApp chat. A directory lead whose automatic schedule is on WhatsApp gets its
// email instead (cadenceService.sendEmailNow).
// Skipped on purpose (a deliberate human click): the 9–18 IST send window and the mailbox spacing gap.
// Never skipped: opt-outs/suppression/bounces, replied leads, verified address, research, the AI quality
// bar, paused mailboxes and daily caps — and never two emails to the same lead within COOLDOWN_MINUTES
// (repeat clicks) or SAME_DAY_HOURS (one email a day at most).
//
// Order: 1. original first email waiting for its fresh-start re-send → that email, same mailbox;
//        2. active email sequence → its next step;  3. directory lead → its next email touch;
//        otherwise → why not.

const COOLDOWN_MINUTES = 10;
const SAME_DAY_HOURS = 20;
const inFlight = new Set(); // double-click while the first request is still running

function ago(seconds) {
  if (seconds < 60) return 'just now';
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'} ago`;
}
function inAbout(seconds) {
  const m = Math.max(1, Math.ceil(seconds / 60));
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  return `about ${Math.round(m / 60)} hours`;
}

async function mailboxStatusText() {
  const EmailSenderService = require('./emailSenderService');
  await EmailSenderService.resetStaleCounters();
  const excluded = await EmailSenderService.coldExcludedIds();
  const rows = (await pool.query('SELECT * FROM email_senders ORDER BY id')).rows.filter((s) => !excluded.has(s.id));
  if (!rows.length) return 'no mailbox is set up for cold email (Settings → Email Senders)';
  return rows.map((s) => {
    const cap = EmailSenderService.effectiveDailyCap(s);
    return `${s.from_name || s.label} ${s.status !== 'active' ? 'is paused' : `${s.sent_today}/${cap} today`}`;
  }).join(', ');
}

async function leadMailboxText(leadId) {
  const EmailSenderService = require('./emailSenderService');
  await EmailSenderService.resetStaleCounters();
  const priorId = await EmailSenderService.getPriorSenderId(leadId);
  const p = priorId ? await EmailSenderService.getById(priorId) : null;
  if (p) {
    const name = p.from_name || p.label;
    return p.status !== 'active'
      ? `its mailbox (${name}) is paused, and follow-ups always go from the mailbox that sent the first email`
      : `its mailbox (${name}) has reached today's cap of ${EmailSenderService.effectiveDailyCap(p)}, and follow-ups always go from the mailbox that sent the first email`;
  }
  return `every mailbox is paused or full for today (${await mailboxStatusText()})`;
}

// Research must exist before an AI-written email (owner's rule). The worker only runs every few minutes,
// so a manual send researches the lead itself (same bookkeeping as workers/researchWorker.js).
async function ensureResearch(lead) {
  const site = researchSiteFor(lead);
  if (!site) return { ok: true }; // nothing to research; the composer decides whether a no-website email is allowed
  if (await getCachedResearch(lead.id)) return { ok: true };
  if ((lead.research_attempts || 0) >= RESEARCH_MAX_ATTEMPTS) return { ok: false, reason: `Not sent: we could not research their website (${site}) after ${RESEARCH_MAX_ATTEMPTS} tries, and we never send a generic email.` };
  if (!isAiAvailable()) return { ok: false, reason: 'Not sent: the AI (OpenAI) is unavailable right now, so the email cannot be written. Check the OpenAI key / credit.' };
  await pool.query(`UPDATE hotel_leads SET research_attempts = COALESCE(research_attempts, 0) + 1, last_research_attempt_at = NOW() WHERE id = $1`, [lead.id]);
  let research = null;
  try {
    ({ research } = await getOrCreateResearch({ ...lead, website: site }));
  } catch (err) {
    console.error(`[SendNow] research failed for lead ${lead.id}:`, err.message);
  }
  if (!research) return { ok: false, reason: `Not sent: we could not read their website (${site}) to write a personal email. It will be tried again automatically.` };
  if (!lead.website) await pool.query(`UPDATE hotel_leads SET website = $2 WHERE id = $1 AND COALESCE(website, '') = ''`, [lead.id, site]);
  return { ok: true };
}

async function lastEmail(leadId) {
  const since = await getFreshStartAt(); // mail before the fresh start never arrived
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(COALESCE(sent_at, created_at))))::int AS age
     FROM email_logs WHERE lead_id = $1 AND direction = 'out' AND error IS NULL
       AND ($2::timestamp IS NULL OR COALESCE(sent_at, created_at) >= $2::timestamp)`, [leadId, since]);
  return r.rows[0]?.age ?? null;
}

async function sentResult(leadId, fallback = {}) {
  const r = (await pool.query(
    `SELECT l.subject, l.lead_id, es.from_name, es.label, es.from_email, hl.email AS to_email
     FROM email_logs l LEFT JOIN email_senders es ON es.id = l.sender_id JOIN hotel_leads hl ON hl.id = l.lead_id
     WHERE l.lead_id = $1 AND l.direction = 'out' AND l.error IS NULL
     ORDER BY COALESCE(l.sent_at, l.created_at) DESC, l.id DESC LIMIT 1`, [leadId])).rows[0] || {};
  const sender = r.from_name || r.label || fallback.sender || '';
  const out = {
    sent: true, channel: 'email', to: r.to_email || fallback.to, subject: r.subject || fallback.subject || null,
    sender, sender_email: r.from_email || null, ...(fallback.extra || {}),
  };
  out.message = `Email sent to ${out.to}${sender ? ` from ${sender}` : ''}${out.subject ? ` — "${out.subject}"` : ''}.`;
  return out;
}

const no = (reason, extra = {}) => ({ sent: false, reason, ...extra });

const CADENCE_REASONS = {
  in_flight: 'Not sent: the automatic sender is emailing this lead right now. Check again in a minute.',
  replied: 'Not sent: they already replied. Answer them from the Inbox.',
  lead_status: 'Not sent: this lead is already in a conversation (status is not "new"), so no cold email goes out.',
  email_not_usable: 'Not sent: this lead cannot get a cold email — no website to research (we never send generic emails), its research failed, or the address is on our own domain.',
  awaiting_research: 'Not sent: their website research is not ready yet. Try again in a few minutes.',
  fresh_resend_own: 'Not sent: this lead is waiting for its original first email to be re-sent.',
  email_below_quality_bar: 'Not sent: the AI draft did not reach the 4.5 quality bar, so nothing went out. Try again later; it is also retried automatically tomorrow.',
  email_quality: 'Not sent: the AI drafts for this lead keep missing the 4.5 quality bar, so nothing went out.',
  compose_failed: 'Not sent: the AI could not write the email (OpenAI error). Try again in a few minutes.',
  send_failed: 'Not sent: the mail server refused the email. It will be retried automatically.',
  email: 'Not sent: the mail server says this address does not exist. It is now marked bounced.',
};

async function sendNow(leadId) {
  if (inFlight.has(leadId)) return no('Already sending this lead — wait for the first click to finish.', { cooldown: true });
  inFlight.add(leadId);
  try {
    return await sendNowLocked(leadId);
  } finally {
    inFlight.delete(leadId);
  }
}

async function sendNowLocked(leadId) {
  const lead = (await pool.query('SELECT * FROM hotel_leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) return no('Lead not found.', { notFound: true });
  if (!lead.email) return no('Not sent: this lead has no email address.');
  if (lead.pipeline) return no(`Not sent: this lead belongs to the ${lead.pipeline} pipeline, which sends its own messages.`);
  if (['not_interested', 'opted_out', 'dead'].includes(lead.status)) return no(`Not sent: the lead is marked "${lead.status.replace('_', ' ')}".`);
  if (['bounced', 'unsubscribed'].includes(lead.email_status)) return no(`Not sent: this address is ${lead.email_status}.`);
  if (await SuppressionService.isSuppressed(lead.email)) return no('Not sent: this address unsubscribed or bounced.');
  const replied = (await pool.query(`SELECT 1 FROM email_logs WHERE lead_id = $1 AND direction = 'in' LIMIT 1`, [leadId])).rows[0];
  if (replied) return no('Not sent: they already replied by email. Answer them from the Inbox.');

  const age = await lastEmail(leadId);
  if (age !== null && age < COOLDOWN_MINUTES * 60) {
    return no(`Already sent ${ago(age)} — not sending again. Send now can be used again in ${inAbout(COOLDOWN_MINUTES * 60 - age)}.`, { cooldown: true });
  }
  if (age !== null && age < SAME_DAY_HOURS * 3600) {
    return no(`Not sent: this lead was already emailed ${ago(age)}. To avoid two emails the same day, the next one can go in ${inAbout(SAME_DAY_HOURS * 3600 - age)}.`, { cooldown: true });
  }

  // 1. Fresh start: its original first email never arrived → re-send that exact email.
  const [resendRow] = await FreshResend.listEligible({ leadId });
  if (resendRow) {
    const r = await FreshResend.resendOne(resendRow, { manual: true });
    if (r.ok) return sentResult(leadId, { to: lead.email, subject: resendRow.subject, extra: { kind: 'original_resend', dryRun: r.dryRun } });
    const why = {
      mailbox_paused: 'its original mailbox is paused (the re-send must come from the same mailbox)',
      mailbox_full_today: "its original mailbox reached today's cap",
      send_failed: `the mail server refused it (${r.error})`,
      suppressed: 'the address is suppressed',
      original_mailbox_missing: 'its original mailbox no longer exists',
      recently_sent: 'it was emailed in the last 10 minutes',
    };
    return no(`Not sent: ${why[r.reason] || r.reason}.`);
  }

  if (lead.email_status !== 'verified') return no(`Not sent: the email address is "${lead.email_status || 'not checked'}", not verified. Only verified addresses are emailed.`);

  // 2. Active email sequence → its next step.
  const seq = (await pool.query(`SELECT id FROM lead_sequences WHERE lead_id = $1 AND status = 'active' LIMIT 1`, [leadId])).rows[0];
  if (seq) {
    const research = await ensureResearch(lead);
    if (!research.ok) return no(research.reason);
    const { runSequenceForLead } = require('../workers/sequenceEmailWorker');
    const r = await runSequenceForLead(leadId);
    if (r.outcome === 'sent') return sentResult(leadId, { to: lead.email, extra: { kind: 'sequence', step: r.step } });
    if (r.outcome === 'no_sender') return no(`Not sent: ${await leadMailboxText(leadId)}.`);
    if (r.outcome === 'busy') return no('Not sent: the automatic email sender is mid-run. Try again in a minute.');
    return no(`Not sent: ${r.message || r.outcome}`);
  }

  // 3. Directory lead → its next email touch, even if its automatic schedule is on WhatsApp.
  if (lead.cadence_managed) {
    const research = await ensureResearch(lead);
    if (!research.ok) return no(research.reason);
    const { sendEmailNow } = require('./cadenceService');
    const r = await sendEmailNow(leadId);
    if (r.sent) return sentResult(leadId, { to: lead.email, subject: r.subject, extra: { kind: 'cadence', dryRun: r.dryRun } });
    if (r.code === 'no_sender_capacity') return no(`Not sent: ${await leadMailboxText(leadId)}.`);
    if (r.code === 'stopped_optout') return no(`Not sent: its automatic outreach was stopped (${String(r.stopReason).replace(/_/g, ' ')}).`);
    return no(CADENCE_REASONS[r.code] || `Not sent: ${r.code}.`);
  }

  return no('Not sent: this lead is not in any email sequence. Enroll it in a sequence first (select it → "Enroll in Sequence").');
}

module.exports = { sendNow, COOLDOWN_MINUTES, SAME_DAY_HOURS };
