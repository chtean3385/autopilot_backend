const cronParser = require('cron-parser');
const pool = require('../config/db');
const { getSetting } = require('./settingsService');
const { isWithinSendWindow } = require('../utils/sendWindow');
const { getRunning } = require('../utils/jobTracker');

// Live Pipeline view (Analytics → Live Pipeline, Live Feed page): one card per background job —
// what it does, its queue (due now / scheduled later / next due), when it runs next, whether it
// is running this second (utils/jobTracker.js), and what its last run did (scheduler_status).
//
// The cron strings below MUST match the scheduleJob() calls in workers/*.js and
// services/schedulerService.js — they only drive the "next run" clock shown in the UI.
const IST = 'Asia/Kolkata';
const JOBS = [
  { key: 'cadence', cron: '*/15 * * * *', every: 'Every 15 min' },
  { key: 'email_sequences', cron: '*/15 * * * *', every: 'Every 15 min' },
  { key: 'whatsapp_followups', cron: '0 12 * * *', tz: IST, every: 'Daily 12:00 pm' },
  { key: 'campaigns', cron: '*/5 * * * *', every: 'Every 5 min' },
  { key: 'agent_tasks', cron: '* * * * *', every: 'Every minute' },
  { key: 'email_replies', cron: '*/3 * * * *', every: 'Every 3 min' },
  { key: 'email_verification', cron: '5 * * * *', every: 'Hourly at :05' },
  { key: 'research', cron: '*/5 * * * *', every: 'Every 5 min' },
  { key: 'directory_crawl', cron: '*/10 * * * *', every: 'Every 10 min' },
  { key: 'template_pool', cron: '5 10 * * *', tz: IST, every: 'Daily 10:05 am' },
  { key: 'template_sync', cron: '17 * * * *', every: 'Hourly at :17' },
];

function nextRun(job) {
  try {
    return cronParser.parseExpression(job.cron, job.tz ? { tz: job.tz } : {}).next().toDate().toISOString();
  } catch {
    return null;
  }
}

const n = (v) => Number(v) || 0;
const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || {};

// "Today" = IST calendar day. Timestamps are stored as UTC wall-clock (TIMESTAMP without tz).
const IST_TODAY = `(date_trunc('day', NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${IST}') AT TIME ZONE '${IST}' AT TIME ZONE 'UTC')`;

async function getPipeline() {
  const [
    cadenceEnabled, windowOpen, lastRuns,
    cadenceQ, seqQ, emailToday, waToday, senders, followQ, campaignQ, taskQ,
    verifyQ, researchQ, crawlQ, templateQ, imapSenders,
  ] = await Promise.all([
    getSetting('CADENCE_ENABLED'),
    isWithinSendWindow().then((w) => (w && typeof w === 'object' ? !!w.allowed : !!w)).catch(() => null),
    pool.query(`SELECT job_name, last_ran_at, last_trigger, last_summary FROM scheduler_status WHERE job_name NOT LIKE 'health:%'`),
    pool.query(`
      SELECT current_channel AS channel,
             COUNT(*) FILTER (WHERE status = 'active' AND next_touch_at <= NOW())::int AS due,
             COUNT(*) FILTER (WHERE status = 'active' AND next_touch_at > NOW())::int AS later,
             COUNT(*) FILTER (WHERE status = 'active' AND last_wait_reason IS NOT NULL)::int AS held,
             COUNT(*) FILTER (WHERE status = 'resting')::int AS resting,
             COUNT(*) FILTER (WHERE status = 'replied')::int AS replied,
             MIN(next_touch_at) FILTER (WHERE status = 'active' AND next_touch_at > NOW()) AS next_due
      FROM lead_cadence GROUP BY current_channel`),
    one(`
      SELECT COUNT(*) FILTER (WHERE status = 'active' AND next_run_at <= NOW())::int AS due,
             COUNT(*) FILTER (WHERE status = 'active' AND next_run_at > NOW())::int AS later,
             COUNT(*) FILTER (WHERE status = 'dead')::int AS dead,
             MIN(next_run_at) FILTER (WHERE status = 'active' AND next_run_at > NOW()) AS next_due
      FROM lead_sequences`),
    one(`
      SELECT COUNT(*) FILTER (WHERE direction = 'out' AND sequence_id IS NOT NULL AND error IS NULL)::int AS seq_sent,
             COUNT(*) FILTER (WHERE direction = 'out' AND sequence_id IS NULL AND error IS NULL)::int AS other_sent,
             COUNT(*) FILTER (WHERE direction = 'out' AND error IS NOT NULL)::int AS failed,
             COUNT(*) FILTER (WHERE direction = 'in')::int AS replies
      FROM email_logs WHERE COALESCE(sent_at, created_at) >= ${IST_TODAY}`),
    one(`
      SELECT COUNT(*) FILTER (WHERE error_message IS NULL)::int AS sent,
             COUNT(*) FILTER (WHERE error_message IS NOT NULL)::int AS failed,
             COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
             COUNT(*) FILTER (WHERE campaign_id IS NOT NULL)::int AS campaign_sent,
             (SELECT COUNT(*)::int FROM outreach_logs r WHERE r.response_received_at >= ${IST_TODAY}) AS replies
      FROM outreach_logs WHERE sent_at >= ${IST_TODAY}`),
    pool.query(`SELECT id, label, from_email, status, daily_cap, sent_today, last_reset_date,
                       (last_reset_date = (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${IST}')::date) AS reset_today
                FROM email_senders ORDER BY id`),
    one(`
      SELECT COUNT(*)::int AS waiting FROM hotel_leads hl
      WHERE hl.status = 'new' AND hl.needs_attention = FALSE AND hl.cadence_managed = FALSE
        AND hl.whatsapp_number IS NOT NULL
        AND EXISTS (SELECT 1 FROM outreach_logs ol WHERE ol.lead_id = hl.id)
        AND NOT EXISTS (SELECT 1 FROM outreach_logs r WHERE r.lead_id = hl.id AND r.response_received = TRUE)`),
    one(`
      SELECT COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_start <= NOW() AND scheduled_end > NOW())::int AS live,
             COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_start > NOW())::int AS upcoming,
             COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_end <= NOW())::int AS stuck,
             MIN(scheduled_start) FILTER (WHERE status = 'scheduled' AND scheduled_start > NOW()) AS next_due
      FROM campaigns`),
    one(`
      SELECT COUNT(*) FILTER (WHERE status IN ('pending','scheduled_send') AND run_at <= NOW())::int AS due,
             COUNT(*) FILTER (WHERE status IN ('pending','scheduled_send') AND run_at > NOW())::int AS later,
             COUNT(*) FILTER (WHERE status = 'running')::int AS running,
             MIN(run_at) FILTER (WHERE status IN ('pending','scheduled_send') AND run_at > NOW()) AS next_due
      FROM agent_tasks`),
    one(`
      SELECT COUNT(*) FILTER (WHERE COALESCE(email_verify_attempts, 0) < 3)::int AS waiting,
             COUNT(*) FILTER (WHERE COALESCE(email_verify_attempts, 0) >= 3)::int AS stuck
      FROM hotel_leads
      WHERE channel = 'email' AND email IS NOT NULL AND email <> '' AND email_status IN ('unknown', 'found')`),
    one(`
      SELECT COUNT(DISTINCT hl.id)::int AS waiting
      FROM hotel_leads hl
      LEFT JOIN lead_research lr ON lr.lead_id = hl.id
      WHERE (EXISTS (SELECT 1 FROM lead_sequences ls WHERE ls.lead_id = hl.id AND ls.status = 'active')
             OR EXISTS (SELECT 1 FROM lead_cadence lc WHERE lc.lead_id = hl.id AND lc.status IN ('active', 'resting')))
        AND hl.website IS NOT NULL AND hl.website <> '' AND lr.lead_id IS NULL
        AND COALESCE(hl.research_attempts, 0) < 3`),
    one(`
      SELECT COUNT(*) FILTER (WHERE p.status = 'pending')::int AS pending,
             COUNT(*) FILTER (WHERE p.status = 'needs_ai')::int AS needs_ai,
             COUNT(DISTINCT p.source_id) FILTER (WHERE p.status = 'pending')::int AS sources
      FROM directory_crawl_pages p
      JOIN directory_sources s ON s.id = p.source_id AND s.status IN ('approved', 'crawling')`),
    one(`
      SELECT COUNT(*) FILTER (WHERE status = 'pending_approval' AND meta_template_id IS NOT NULL)::int AS at_meta,
             COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
             COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
      FROM waba_templates WHERE auto_generated = TRUE`),
    one(`SELECT COUNT(*) FILTER (WHERE status = 'active' AND imap_config IS NOT NULL)::int AS mailboxes FROM email_senders`),
  ]);

  const runs = Object.fromEntries(lastRuns.rows.map((r) => [r.job_name, {
    at: r.last_ran_at,
    trigger: r.last_trigger,
    summary: typeof r.last_summary === 'string' ? safeJson(r.last_summary) : r.last_summary,
  }]));
  const running = getRunning();
  const cad = Object.fromEntries(cadenceQ.rows.map((r) => [r.channel || 'none', r]));
  const cadWa = cad.whatsapp || {};
  const cadEmail = cad.email || {};
  const cadenceOn = String(cadenceEnabled).toLowerCase() === 'true';

  const activeSenders = senders.rows.filter((s) => s.status === 'active');
  const capacityLeft = activeSenders.reduce((sum, s) => sum + Math.max(0, n(s.daily_cap) - (s.reset_today ? n(s.sent_today) : 0)), 0);

  const base = (key) => {
    const job = JOBS.find((j) => j.key === key);
    return {
      key, every: job.every, nextRunAt: nextRun(job),
      running: !!running[key], runningSince: running[key]?.since || null,
      lastRun: runs[key] || null,
    };
  };

  const pipelines = [
    {
      ...base('cadence'), id: 'cadence_whatsapp', group: 'whatsapp',
      name: 'Directory leads — WhatsApp', what: 'Sends the next approved WhatsApp template to directory leads whose turn is on WhatsApp.',
      enabled: cadenceOn, disabledReason: cadenceOn ? null : 'CADENCE_ENABLED is off',
      queue: { due: n(cadWa.due), later: n(cadWa.later), nextDueAt: cadWa.next_due || null, held: n(cadWa.held) },
      today: { done: n(waToday.sent) - n(waToday.campaign_sent), failed: n(waToday.failed) },
    },
    {
      ...base('cadence'), id: 'cadence_email', group: 'email',
      name: 'Directory leads — Email', what: 'Writes and sends a personal email (AI, must score 4.5+) to directory leads whose turn is on email.',
      enabled: cadenceOn, disabledReason: cadenceOn ? null : 'CADENCE_ENABLED is off',
      queue: { due: n(cadEmail.due), later: n(cadEmail.later), nextDueAt: cadEmail.next_due || null, held: n(cadEmail.held), heldLabel: 'drafts below quality bar' },
      today: { done: n(emailToday.other_sent), failed: null },
    },
    {
      ...base('email_sequences'), id: 'email_sequences', group: 'email',
      name: 'Email sequences', what: 'Sends the next step of each email sequence, rotating across your sender mailboxes.',
      enabled: activeSenders.length > 0, disabledReason: activeSenders.length ? null : 'no active sender',
      sendWindowOpen: windowOpen,
      queue: { due: n(seqQ.due), later: n(seqQ.later), nextDueAt: seqQ.next_due || null },
      today: { done: n(emailToday.seq_sent), failed: n(emailToday.failed) },
      extra: { capacityLeft, activeSenders: activeSenders.length },
    },
    {
      ...base('whatsapp_followups'), id: 'whatsapp_followups', group: 'whatsapp',
      name: 'WhatsApp follow-ups', what: 'Leads who never replied get follow-up #1 and #2 (2+ days apart), then are marked no-response.',
      enabled: true,
      queue: { due: null, later: n(followQ.waiting), laterLabel: 'leads in follow-up cycle', nextDueAt: null },
      today: null,
    },
    {
      ...base('campaigns'), id: 'campaigns', group: 'whatsapp',
      name: 'Scheduled campaigns', what: 'Sends scheduled WhatsApp campaigns, 10 leads per tick, inside their time window.',
      enabled: true,
      queue: { due: n(campaignQ.live), dueLabel: 'campaigns live', later: n(campaignQ.upcoming), laterLabel: 'upcoming', nextDueAt: campaignQ.next_due || null, held: n(campaignQ.stuck), heldLabel: 'missed their window' },
      today: { done: n(waToday.campaign_sent), failed: null },
    },
    {
      ...base('agent_tasks'), id: 'agent_tasks', group: 'system',
      name: 'Agent tasks', what: 'Runs the tasks you give the agent (find leads in a city, send to them) at their scheduled time.',
      enabled: true,
      queue: { due: n(taskQ.due), later: n(taskQ.later), nextDueAt: taskQ.next_due || null, held: n(taskQ.running), heldLabel: 'in progress' },
      today: null,
    },
    {
      ...base('email_replies'), id: 'email_replies', group: 'email',
      name: 'Reply checking', what: 'Reads every sender mailbox for replies; the AI answers, stops the sequence, or flags you.',
      enabled: n(imapSenders.mailboxes) > 0, disabledReason: n(imapSenders.mailboxes) ? null : 'no mailbox has IMAP set',
      queue: { due: null, later: n(imapSenders.mailboxes), laterLabel: 'mailboxes watched', nextDueAt: null },
      today: { done: n(emailToday.replies), doneLabel: 'replies today', failed: null },
    },
    {
      ...base('email_verification'), id: 'email_verification', group: 'email',
      name: 'Email verification', what: 'Checks new email addresses with mails.so before anything is sent to them.',
      enabled: true,
      queue: { due: n(verifyQ.waiting), dueLabel: 'waiting to verify', later: null, nextDueAt: null, held: n(verifyQ.stuck), heldLabel: 'used 3 tries (weekly retry)' },
      today: null,
    },
    {
      ...base('research'), id: 'research', group: 'email',
      name: 'Website research', what: "Reads each lead's website so emails can mention real details about their business.",
      enabled: true,
      queue: { due: n(researchQ.waiting), dueLabel: 'websites to read', later: null, nextDueAt: null },
      today: null,
    },
    {
      ...base('directory_crawl'), id: 'directory_crawl', group: 'system',
      name: 'Directory crawl', what: 'Reads approved directories page by page and turns businesses into leads.',
      enabled: true,
      queue: { due: n(crawlQ.pending), dueLabel: 'pages to read', later: null, nextDueAt: null, held: n(crawlQ.needs_ai), heldLabel: 'pages need AI' },
      today: null,
    },
    {
      ...base('template_pool'), id: 'template_pool', group: 'whatsapp',
      name: 'WhatsApp templates', what: 'Writes new message templates per niche, scores them, submits the best to Meta.',
      enabled: true,
      queue: { due: n(templateQ.at_meta), dueLabel: 'waiting for Meta', later: n(templateQ.approved), laterLabel: 'approved', nextDueAt: null, held: n(templateQ.rejected), heldLabel: 'rejected' },
      today: null,
    },
  ];

  return {
    now: new Date().toISOString(),
    sendWindowOpen: windowOpen,
    cadenceEnabled: cadenceOn,
    today: {
      whatsappSent: n(waToday.sent), whatsappDelivered: n(waToday.delivered), whatsappFailed: n(waToday.failed), whatsappReplies: n(waToday.replies),
      emailSent: n(emailToday.seq_sent) + n(emailToday.other_sent), emailFailed: n(emailToday.failed), emailReplies: n(emailToday.replies),
    },
    queues: {
      whatsappDue: n(cadWa.due), emailDue: n(cadEmail.due) + n(seqQ.due),
      whatsappLater: n(cadWa.later), emailLater: n(cadEmail.later) + n(seqQ.later),
    },
    senders: senders.rows.map((s) => ({
      id: s.id, label: s.label, email: s.from_email, status: s.status, cap: n(s.daily_cap),
      sentToday: s.reset_today ? n(s.sent_today) : 0,
    })),
    pipelines,
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Unified, time-ordered stream of everything the system did: agent decisions (agent_actions),
// WhatsApp sends and inbound replies (outreach_logs), email sends/replies (email_logs).
async function getActivityStream({ limit = 120, since = null } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 120, 1), 300);
  const params = [lim];
  const sinceSql = since ? `AND ts > $2` : '';
  if (since) params.push(since);
  const { rows } = await pool.query(`
    SELECT * FROM (
      SELECT 'agent' AS kind, 'aa-' || aa.id AS id, aa.created_at AS ts, aa.lead_id, hl.hotel_name, hl.city,
             COALESCE(hl.channel, 'whatsapp') AS channel, aa.action AS action, aa.decision, aa.score::text AS score,
             aa.detail::text AS detail, LEFT(aa.draft_text, 600) AS text
      FROM agent_actions aa LEFT JOIN hotel_leads hl ON hl.id = aa.lead_id
      UNION ALL
      SELECT 'wa_out', 'wo-' || ol.id, ol.sent_at, ol.lead_id, hl.hotel_name, hl.city, 'whatsapp',
             CASE WHEN ol.error_message IS NOT NULL THEN 'wa_failed' WHEN ol.read_at IS NOT NULL THEN 'wa_read'
                  WHEN ol.delivered_at IS NOT NULL THEN 'wa_delivered' ELSE 'wa_sent' END,
             ol.message_type, NULL, json_build_object('template', t.template_name, 'error', ol.error_message)::text, NULL
      FROM outreach_logs ol LEFT JOIN hotel_leads hl ON hl.id = ol.lead_id LEFT JOIN waba_templates t ON t.id = ol.template_id
      UNION ALL
      SELECT 'wa_in', 'wi-' || ol.id, ol.response_received_at, ol.lead_id, hl.hotel_name, hl.city, 'whatsapp',
             CASE WHEN ol.is_auto_reply THEN 'wa_auto_reply' ELSE 'wa_reply' END, NULL, NULL, NULL, LEFT(ol.response_text, 600)
      FROM outreach_logs ol LEFT JOIN hotel_leads hl ON hl.id = ol.lead_id
      WHERE ol.response_received = TRUE AND ol.response_received_at IS NOT NULL
      UNION ALL
      SELECT CASE WHEN el.direction = 'in' THEN 'email_in' ELSE 'email_out' END, 'el-' || el.id, COALESCE(el.sent_at, el.created_at),
             el.lead_id, hl.hotel_name, hl.city, 'email',
             CASE WHEN el.direction = 'in' THEN 'email_reply' WHEN el.error IS NOT NULL THEN 'email_failed'
                  WHEN el.bounced_at IS NOT NULL THEN 'email_bounced' WHEN el.opened_at IS NOT NULL THEN 'email_opened' ELSE 'email_sent' END,
             NULL, NULL, json_build_object('subject', el.subject, 'sender', es.label, 'error', el.error, 'sequence', s.name)::text, NULL
      FROM email_logs el LEFT JOIN hotel_leads hl ON hl.id = el.lead_id
      LEFT JOIN email_senders es ON es.id = el.sender_id LEFT JOIN sequences s ON s.id = el.sequence_id
    ) x
    WHERE ts IS NOT NULL ${sinceSql}
    ORDER BY ts DESC
    LIMIT $1`, params);
  return rows.map((r) => ({ ...r, detail: r.detail ? safeJson(r.detail) : null, score: r.score == null ? null : Number(r.score) }));
}

module.exports = { getPipeline, getActivityStream, JOBS };
