const pool = require('../config/db');
const { alertOwner } = require('./ownerAlertService');
const { isAiAvailable } = require('../utils/aiUsage');
const { isWithinSendWindow } = require('../utils/sendWindow');
const { loadConfig } = require('./cadenceService');
const settingsService = require('./settingsService');
const channelHealth = require('../utils/channelHealth');

// Directory outreach step 6 — "channel health". CLAUDE.md's 2026-09-18 lesson: sending, reply
// detection and verification all died silently for 6 weeks because nothing surfaced it. These checks
// are computed live (no extra state), shown as a banner on the Lead Sources page, and pushed to the
// owner on WhatsApp once a day when anything is wrong.
async function getHealth() {
  const cfg = await loadConfig();
  const warnings = [];
  const warn = (level, area, message) => warnings.push({ level, area, message });

  await systemChecks(warn);

  const failedSources = (await pool.query(
    `SELECT name, url, last_error FROM directory_sources WHERE status = 'failed'`)).rows;
  for (const s of failedSources) warn('error', 'directory', `Crawl failed: ${s.name || s.url} — ${s.last_error || 'unknown error'}`);

  const stuckSources = (await pool.query(
    `SELECT name, url FROM directory_sources
     WHERE status IN ('approved', 'crawling') AND (last_crawled_at IS NULL OR last_crawled_at < NOW() - INTERVAL '1 day')
       AND created_at < NOW() - INTERVAL '1 hour'`)).rows;
  for (const s of stuckSources) warn('warn', 'directory', `Approved source not crawled for over a day: ${s.name || s.url}`);

  const needsAi = (await pool.query(`SELECT COUNT(*)::int AS n FROM directory_crawl_pages WHERE status = 'needs_ai'`)).rows[0].n;
  if (!isAiAvailable()) warn('error', 'ai', 'OpenAI is out of credit or over the monthly budget — reply drafts, GPT page extraction and template drafts are paused');
  if (needsAi > 0) warn('warn', 'ai', `${needsAi} directory page(s) are waiting for AI extraction (no credit when they were crawled)`);

  if (cfg.enabled) {
    const overdue = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM lead_cadence WHERE status IN ('active', 'resting') AND next_touch_at < NOW() - INTERVAL '3 hours'`)).rows[0].n;
    const window = await isWithinSendWindow();
    if (overdue > 0 && window.allowed) warn('error', 'sending', `${overdue} cadence touch(es) overdue by 3+ hours inside the send window — sending may be stuck (check Brevo authorised IPs, sender caps, pm2 logs)`);

    const approvedTpl = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM waba_templates WHERE status = 'approved' AND template_group IS NOT NULL`)).rows[0].n;
    if (approvedTpl === 0) warn('warn', 'whatsapp', 'No approved directory WhatsApp templates yet — WhatsApp touches are skipped (email only) until Meta approves one');
    const run = await require('./templatePoolService').lastRun();
    const liveTpl = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM waba_templates WHERE status IN ('approved','pending_approval','draft') AND template_group IS NOT NULL`)).rows[0].n;
    if (run && run.wrote === 0 && liveTpl === 0 && !run.aiSkipped) {
      warn('warn', 'whatsapp', `Template writer produced no usable WhatsApp template on its last run — best tone score ${run.bestScore ?? 'n/a'}, needs ${run.minScore}` +
        (run.errors?.length ? ` (errors: ${run.errors.join('; ')})` : '') + '. No WhatsApp template is available, so directory leads get email only');
    }
    const rejectedToday = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM waba_templates WHERE status = 'rejected' AND template_group IS NOT NULL AND updated_at >= NOW() - INTERVAL '1 day'`)).rows[0].n;
    if (rejectedToday >= 5) warn('warn', 'whatsapp', `Meta rejected ${rejectedToday} templates in the last day — see reasons on Lead Sources; new ones are written to avoid them`);
  }

  const stuckVerify = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM hotel_leads
     WHERE cadence_managed AND email <> '' AND email_status IN ('unknown', 'found') AND COALESCE(email_verify_attempts, 0) >= 3`)).rows[0].n;
  if (stuckVerify > 0) warn('warn', 'verification', `${stuckVerify} directory lead email(s) failed verification 3 times (mails.so credit/key?) — they won't be emailed`);

  const waitingApprovals = (await pool.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE type = 'whatsapp_low_score_reply')::int AS wa
     FROM pending_approvals
     WHERE status = 'pending' AND payload::text LIKE '%directory_cadence%' AND created_at < NOW() - INTERVAL '12 hours'`)).rows[0];
  if (waitingApprovals.n > 0) {
    warn('warn', 'replies', `${waitingApprovals.n} directory reply draft(s) waiting for your approval 12h+${waitingApprovals.wa ? ` (${waitingApprovals.wa} WhatsApp — Meta only delivers within 24h of their message)` : ''}`);
  }

  return { ok: warnings.length === 0, enabled: cfg.enabled, warnings, checkedAt: new Date() };
}

// Whole-system checks (2026-10-08) — every channel, not just directory outreach. Channel state comes
// from utils/channelHealth.js (last success / last channel-level failure, recorded at each send/poll).
const HOUR = 3600000;
const ago = (iso) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);
const since = (iso) => {
  const h = ago(iso) / HOUR;
  return h < 1 ? 'under an hour' : h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`;
};

async function systemChecks(warn) {
  const ch = await channelHealth.getAll();

  if (channelHealth.isFailing(ch.email) && ago(ch.email.lastErrorAt) < 48 * HOUR) {
    warn('error', 'email', `Email sending is failing (last success ${ch.email.lastOkAt ? since(ch.email.lastOkAt) + ' ago' : 'never'}): ${ch.email.lastError} — check Brevo → Security → Authorised IPs, the sender's API key and Brevo credit`);
  }
  const window = await isWithinSendWindow();
  const istHour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  if (window.allowed && istHour >= 12) {
    const r = (await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM lead_sequences ls JOIN sequences s ON s.id = ls.sequence_id
            WHERE ls.status = 'active' AND s.active AND ls.next_run_at < NOW() - INTERVAL '3 hours') AS due,
         (SELECT COUNT(*)::int FROM email_logs WHERE direction = 'out' AND error IS NULL
            AND sent_at >= (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::timestamp) AS sent_today`
    )).rows[0];
    if (r.due > 0 && r.sent_today === 0) {
      warn('error', 'email', `No email sent today although ${r.due} sequence email(s) are due — sending may be stuck (sender paused or at its daily cap, Brevo, pm2 logs)`);
    }
  }

  if (channelHealth.isFailing(ch.whatsapp) && ago(ch.whatsapp.lastErrorAt) < 48 * HOUR) {
    warn('error', 'whatsapp', `WhatsApp sending is failing (last success ${ch.whatsapp.lastOkAt ? since(ch.whatsapp.lastOkAt) + ' ago' : 'never'}): ${ch.whatsapp.lastError} — check the WABA token and the number's status in Meta Business Manager`);
  }

  const senders = (await pool.query(`SELECT id, label, imap_config FROM email_senders WHERE status = 'active'`)).rows;
  for (const s of senders) {
    const imap = typeof s.imap_config === 'string' ? JSON.parse(s.imap_config || '{}') : (s.imap_config || {});
    if (!imap.host) {
      warn('warn', 'replies', `Mailbox "${s.label}" has no IMAP settings — replies sent to it are never picked up (Settings → Email Senders)`);
      continue;
    }
    const h = ch[`imap:${s.id}`];
    if (channelHealth.isFailing(h)) {
      warn('error', 'replies', `Reply checking failing for "${s.label}" (last success ${h.lastOkAt ? since(h.lastOkAt) + ' ago' : 'never'}): ${h.lastError} — check its IMAP password`);
    } else if (h?.lastOkAt && ago(h.lastOkAt) > 2 * HOUR) {
      warn('warn', 'replies', `Replies for "${s.label}" last checked ${since(h.lastOkAt)} ago (normally every 3 minutes) — is the server running?`);
    }
  }

  if (channelHealth.isFailing(ch.verifier)) {
    const waiting = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM hotel_leads WHERE email <> '' AND email_status IN ('unknown', 'found')`)).rows[0].n;
    warn('error', 'verification', `Email verification (mails.so) is failing: ${ch.verifier.lastError}. ${waiting} lead(s) wait to be verified before they can be emailed — top up mails.so; they're retried every hour, nothing is lost`);
  }

  const stuckCampaigns = (await pool.query(
    `SELECT campaign_name FROM campaigns WHERE status = 'scheduled' AND scheduled_end < NOW()`)).rows;
  if (stuckCampaigns.length) {
    warn('warn', 'campaigns', `${stuckCampaigns.length} scheduled campaign(s) never started — their window passed while the server was down: ${stuckCampaigns.map((c) => c.campaign_name).slice(0, 3).join(', ')}`);
  }
}

// Hourly 08:40–22:40 IST: WhatsApp the owner as soon as something is broken (errors only), instead of
// waiting for the 18:30 daily round-up. The same problem isn't repeated within 6 hours.
const URGENT_REPEAT_MS = 6 * HOUR;
async function sendUrgentAlert() {
  const health = await getHealth();
  const errors = health.warnings.filter((w) => w.level === 'error');
  if (!errors.length) return { sent: false };
  const key = errors.map((w) => w.area).sort().join(',');
  let last = {};
  try { last = JSON.parse((await settingsService.getSetting('HEALTH_LAST_URGENT_ALERT')) || '{}'); } catch { /* first run */ }
  if (last.key === key && Date.now() - (last.at || 0) < URGENT_REPEAT_MS) return { sent: false, repeat: true };
  await alertOwner('CRM problem — needs you', errors.slice(0, 3).map((w) => w.message).join(' | '));
  await settingsService.setSetting('HEALTH_LAST_URGENT_ALERT', JSON.stringify({ key, at: Date.now() }));
  return { sent: true, count: errors.length };
}

async function sendDailyHealthAlert() {
  const health = await getHealth();
  if (health.ok) return { sent: false };
  const lines = health.warnings.slice(0, 5).map((w) => w.message).join(' | ');
  await alertOwner('Lead outreach needs attention', lines);
  return { sent: true, count: health.warnings.length };
}

// Monday summary of the last 7 days (owner_alert template, one line).
async function sendWeeklySummary() {
  const r = (await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM directory_entries WHERE imported_at >= NOW() - INTERVAL '7 days') AS found,
       (SELECT COUNT(*)::int FROM directory_entries WHERE promoted_at >= NOW() - INTERVAL '7 days' AND skip_reason IS NULL) AS promoted,
       (SELECT COUNT(*)::int FROM lead_cadence WHERE started_at >= NOW() - INTERVAL '7 days') AS started,
       (SELECT COUNT(*)::int FROM email_logs el JOIN hotel_leads hl ON hl.id = el.lead_id
          WHERE hl.cadence_managed AND el.direction = 'out' AND el.error IS NULL AND el.sent_at >= NOW() - INTERVAL '7 days') AS emails,
       (SELECT COUNT(*)::int FROM outreach_logs ol JOIN hotel_leads hl ON hl.id = ol.lead_id
          WHERE hl.cadence_managed AND ol.message_type = 'template' AND ol.sent_at >= NOW() - INTERVAL '7 days') AS whatsapp,
       (SELECT COUNT(*)::int FROM lead_cadence WHERE status = 'replied' AND updated_at >= NOW() - INTERVAL '7 days') AS replies,
       (SELECT COUNT(*)::int FROM pending_approvals WHERE status = 'pending' AND payload::text LIKE '%directory_cadence%') AS approvals`
  )).rows[0];
  if (!r.found && !r.started && !r.emails && !r.whatsapp && !r.replies) return { sent: false };
  await alertOwner(
    'Weekly lead outreach summary',
    `${r.found} businesses found, ${r.promoted} new leads, ${r.started} started outreach. Sent ${r.emails} emails + ${r.whatsapp} WhatsApp. ${r.replies} replied, ${r.approvals} reply draft(s) waiting for you.`
  );
  return { sent: true, ...r };
}

module.exports = { getHealth, sendUrgentAlert, sendDailyHealthAlert, sendWeeklySummary };
