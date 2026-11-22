const pool = require('../config/db');
const EmailSenderService = require('./emailSenderService');
const SuppressionService = require('./suppressionService');
const { getSetting } = require('./settingsService');
const { getFreshStartAt } = require('../utils/freshStart');
const { getBackendUrl } = require('../utils/backendUrlConfig');
const { generateTrackingToken, buildClickUrl, buildPixelUrl } = require('../utils/emailTracking');
const { isWithinSendWindow } = require('../utils/sendWindow');

// Fresh-start re-send (owner, 2026-11-22). Every SMTP cold email from 2026-10-07 to 2026-11-22 was
// silently dropped (EHLO [127.0.0.1], see EmailSenderService.smtpTransportOptions). Each lead that got
// ONLY those emails is sent its original FIRST email again: same subject and text, no AI, from the same
// mailbox, with a fresh tracking token. Then that lead's normal follow-ups resume (sequence or cadence),
// as if the first email had just gone out. Leads ever emailed through Brevo are left alone (it delivered).
//
// While any lead is still waiting for its re-send, brand-new first emails (sequence step 0 and cadence
// first touches) hold back (isPending), so the re-sends go first. Off unless FRESH_RESEND_ENABLED=true.

const BREVO_PROVIDER = 'brevo';

// One SQL source of truth for "who gets a re-send". $1 = fresh-start time.
const ELIGIBLE_SQL = `
  SELECT h.id AS lead_id, h.email, h.status, h.cadence_managed,
         o.id AS original_log_id, o.sender_id, o.sequence_id, o.subject, o.body, o.tracking_token
  FROM hotel_leads h
  JOIN LATERAL (
    SELECT l.* FROM email_logs l
    WHERE l.lead_id = h.id AND l.direction = 'out' AND l.error IS NULL AND l.body IS NOT NULL
      AND COALESCE(l.sent_at, l.created_at) < $1::timestamp
    ORDER BY COALESCE(l.sent_at, l.created_at) ASC LIMIT 1
  ) o ON TRUE
  WHERE COALESCE(TRIM(h.email), '') <> ''
    AND h.pipeline IS NULL
    AND COALESCE(h.email_status, '') NOT IN ('bounced', 'unsubscribed')
    AND h.status NOT IN ('not_interested', 'opted_out')
    -- never emailed through Brevo (that mail was delivered; owner: leave those as they are)
    AND NOT EXISTS (SELECT 1 FROM email_logs b JOIN email_senders s ON s.id = b.sender_id
                    WHERE b.lead_id = h.id AND b.direction = 'out' AND b.error IS NULL AND s.provider = 'brevo')
    -- not already re-sent / emailed since the fresh start
    AND NOT EXISTS (SELECT 1 FROM email_logs n WHERE n.lead_id = h.id AND n.direction = 'out' AND n.error IS NULL
                    AND COALESCE(n.sent_at, n.created_at) >= $1::timestamp)
    -- never replied by email
    AND NOT EXISTS (SELECT 1 FROM email_logs r WHERE r.lead_id = h.id AND r.direction = 'in')
    -- directory leads: not replied / opted out / not interested on any channel
    AND NOT EXISTS (SELECT 1 FROM lead_cadence c WHERE c.lead_id = h.id
                    AND (c.status = 'replied' OR c.stop_reason IN ('opted_out', 'not_interested', 'unsubscribed')))
    -- the original mailbox must be an SMTP mailbox that still exists
    AND EXISTS (SELECT 1 FROM email_senders s WHERE s.id = o.sender_id AND s.provider <> 'brevo')`;

async function enabled() {
  return String((await getSetting('FRESH_RESEND_ENABLED')) || '').trim().toLowerCase() === 'true';
}

async function listEligible({ limit = null, leadId = null } = {}) {
  const since = await getFreshStartAt();
  if (!since) return [];
  const params = [since];
  let sql = ELIGIBLE_SQL;
  if (leadId) { params.push(leadId); sql += ` AND h.id = $${params.length}`; }
  sql += ' ORDER BY h.id';
  if (limit) { params.push(limit); sql += ` LIMIT $${params.length}`; }
  return (await pool.query(sql, params)).rows;
}

// Cached for 5 minutes: called on every sequence/cadence row to decide whether first emails wait.
let pendingCache = { at: 0, value: false };
async function isPending() {
  if (!(await enabled())) return false;
  if (Date.now() - pendingCache.at < 5 * 60000) return pendingCache.value;
  const since = await getFreshStartAt();
  const value = since ? (await pool.query(`SELECT EXISTS (${ELIGIBLE_SQL}) AS p`, [since])).rows[0].p : false;
  pendingCache = { at: Date.now(), value };
  return value;
}

// The stored body is the exact HTML that was sent. Swap the old tracking token for a new one:
// - open pixel: /t/o/<old> → /t/o/<new>
// - click links are HMAC-signed over (token, url), so each is rebuilt with buildClickUrl (a plain
//   token swap would break every link's signature and 404 it).
// If the old HTML had no pixel (open tracking was off then), one is added so this send can be confirmed.
function retokenize(html, oldToken, newToken) {
  let out = String(html || '');
  if (oldToken) {
    const esc = oldToken.replace(/[^a-f0-9]/gi, '');
    out = out.replace(new RegExp(`(https?://[^"'\\s>]*?/t/c/)${esc}\\?u=([^&"'\\s>]+)&(?:amp;)?s=[a-f0-9]+`, 'gi'),
      (m, _prefix, u) => {
        let url;
        try { url = decodeURIComponent(u.replace(/&amp;/g, '&')); } catch { return m; }
        return buildClickUrl(newToken, url);
      });
    out = out.replace(new RegExp(`(https?://[^"'\\s>]*?/t/o/)${esc}`, 'gi'), `$1${newToken}`);
  }
  if (!out.includes(`/t/o/${newToken}`)) {
    const pixel = `<img src="${buildPixelUrl(newToken)}" width="1" height="1" alt="" style="display:none">`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : out + pixel;
  }
  return out;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// After the re-send: the lead's normal follow-ups continue from "first email sent just now".
async function resumeFollowUps(row, senderId) {
  const seq = (await pool.query(
    `SELECT ls.id, s.initial_gaps, s.recurring_interval_days FROM lead_sequences ls JOIN sequences s ON s.id = ls.sequence_id
     WHERE ls.lead_id = $1 ORDER BY ls.updated_at DESC LIMIT 1`, [row.lead_id])).rows[0];
  if (seq) {
    const gaps = typeof seq.initial_gaps === 'string' ? JSON.parse(seq.initial_gaps || '[]') : (seq.initial_gaps || []);
    const gapDays = Number(gaps[0] || seq.recurring_interval_days || 7);
    await pool.query(
      `UPDATE lead_sequences SET current_step = 1, status = 'active', paused_reason = NULL, sender_id = $2,
              send_fail_count = 0, next_run_at = NOW() + ($3 || ' days')::interval, updated_at = NOW()
       WHERE id = $1`, [seq.id, senderId, String(gapDays)]);
  }
  if (row.cadence_managed) {
    const gapDays = Number.parseInt(await getSetting('CADENCE_EMAIL_GAP_DAYS'), 10) || 4;
    // Only the email side restarts. A lead whose cadence is currently on WhatsApp (active/resting)
    // keeps its WhatsApp position (owner: "email only restarts").
    await pool.query(
      `UPDATE lead_cadence SET status = 'active', stop_reason = NULL, current_channel = 'email', cycle_start_channel = 'email',
              cycle = 1, touches_on_channel = 1, total_touches = 1, last_touch_at = NOW(), last_channel = 'email',
              next_touch_at = NOW() + ($2 || ' days')::interval, last_wait_reason = NULL, updated_at = NOW()
       WHERE lead_id = $1 AND NOT (current_channel = 'whatsapp' AND status IN ('active', 'resting'))`,
      [row.lead_id, String(gapDays)]);
    await pool.query(`UPDATE hotel_leads SET status = 'new', updated_at = NOW() WHERE id = $1 AND status = 'no_response'`, [row.lead_id]);
  }
}

// Re-send one lead's original first email. manual=true (Send now button) skips the send window and the
// per-mailbox spacing, but never the mailbox's daily cap, pause, or any safety check.
async function resendOne(row, { manual = false } = {}) {
  if (await SuppressionService.isSuppressed(row.email)) return { ok: false, reason: 'suppressed' };
  await EmailSenderService.resetStaleCounters();
  const sender = await EmailSenderService.getById(row.sender_id);
  if (!sender || sender.provider === BREVO_PROVIDER) return { ok: false, reason: 'original_mailbox_missing' };
  if (sender.status !== 'active') return { ok: false, reason: 'mailbox_paused', wait: true };
  if (!EmailSenderService.hasCapacity(sender)) return { ok: false, reason: 'mailbox_full_today', wait: true };
  if (!manual && !(await EmailSenderService.pacedOk(sender))) return { ok: false, reason: 'mailbox_spacing', wait: true };
  // A manual "Send now" and the tick can pick the same lead at once — never two emails within 10 minutes.
  const recent = (await pool.query(
    `SELECT 1 FROM email_logs WHERE lead_id = $1 AND direction = 'out' AND error IS NULL
       AND COALESCE(sent_at, created_at) > NOW() - INTERVAL '10 minutes' LIMIT 1`, [row.lead_id])).rows[0];
  if (recent) return { ok: false, reason: 'recently_sent', wait: true };

  const token = generateTrackingToken();
  const html = retokenize(row.body, row.tracking_token, token);
  const text = htmlToText(html);
  const unsubscribeUrl = `${getBackendUrl()}/unsubscribe?token=${SuppressionService.generateToken(row.email)}`;
  const result = await EmailSenderService.send(sender, { to: row.email, subject: row.subject, html, text, unsubscribeUrl });

  if (!result.success) {
    await pool.query(
      `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, error, sent_at)
       VALUES ($1, $2, $3, 'out', $4, $5, $6, NOW())`,
      [row.lead_id, sender.id, row.sequence_id, row.subject, html, String(result.error || 'send failed').slice(0, 1000)]);
    return { ok: false, reason: 'send_failed', error: result.error };
  }

  await pool.query(
    `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, provider_message_id, tracking_token, sent_at)
     VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, NOW())`,
    [row.lead_id, sender.id, row.sequence_id, row.subject, html, result.messageId, token]);
  await resumeFollowUps(row, sender.id);
  await pool.query(
    `INSERT INTO agent_actions (lead_id, action, detail, decision) VALUES ($1, 'fresh_resend', $2, 'send')`,
    [row.lead_id, JSON.stringify({ originalLogId: row.original_log_id, senderId: sender.id, manual, dryRun: Boolean(result.dryRun) })]);
  pendingCache.at = 0;
  return { ok: true, senderId: sender.id, from: sender.from_email, dryRun: Boolean(result.dryRun) };
}

// Cron tick: inside the send window, at most one re-send per mailbox per tick (spacing does the rest).
async function runTick() {
  if (!(await enabled())) return { skipped: 'disabled' };
  if (!(await isWithinSendWindow()).allowed) return { skipped: 'outside_window' }; // returns an object, not a boolean
  const rows = await listEligible({ limit: 500 });
  const out = { eligible: rows.length, sent: 0, waiting: 0, failed: 0, reasons: {} };
  const usedThisTick = new Set();
  for (const row of rows) {
    if (usedThisTick.has(row.sender_id)) continue;
    const r = await resendOne(row);
    usedThisTick.add(row.sender_id);
    if (r.ok) out.sent++; else if (r.wait) out.waiting++; else out.failed++;
    if (!r.ok) out.reasons[r.reason] = (out.reasons[r.reason] || 0) + 1;
  }
  pendingCache.at = 0;
  return out;
}

// True when THIS lead is still waiting for its original first email to be re-sent: nothing else
// (AI first email or AI follow-up) may go to it before that.
async function isLeadWaiting(leadId) {
  if (!(await enabled())) return false;
  return (await listEligible({ leadId })).length > 0;
}

module.exports = { listEligible, isPending, isLeadWaiting, resendOne, runTick, retokenize, htmlToText, enabled };
