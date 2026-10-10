const pool = require('../config/db');
const settingsService = require('./settingsService');
const EmailSenderService = require('./emailSenderService');
const SuppressionService = require('./suppressionService');
const WABAService = require('./wabaService');
const LeadService = require('./leadService');
const { getCachedResearch, researchSiteFor, RESEARCH_MAX_ATTEMPTS } = require('./leadResearchService');
const { isWithinSendWindow } = require('../utils/sendWindow');
const { stopCadence } = require('./cadenceReplyService');
const { WRITING_RULES } = require('../utils/humanTone');

// Directory outreach step 3 (_docs/directory-outreach-plan.md): the cross-channel cadence. The ONLY
// thing that sends cold messages to cadence_managed (directory) leads — campaigns, WhatsApp
// follow-ups and manual sequence enrollment all skip them (step 2). One channel at a time:
//
//   cycle 1:  [start channel] × N touches → switch → [other channel] × M touches → rest
//   cycle 2:  starts on the other channel, rest again … until CADENCE_MAX_CYCLES (0 = forever)
//
// Email touches go through sequenceEmailWorker.composeAndSendColdEmail() — the same writer,
// quality gate, spam lint, signature/opt-out P.S. and List-Unsubscribe headers as every other cold
// email. WhatsApp touches are approved templates only (picked by schedulerService's never-repeat
// picker in strict-industry mode). Any reply stops everything (cadenceReplyService.js).
//
// Off unless CADENCE_ENABLED=true. Cron ticks respect the IST send window; a manual run doesn't.

const DEFAULTS = {
  emailTouches: 2, waTouches: 3, emailGapDays: 4, waGapDays: 3, restDays: [30, 60, 90], maxCycles: 3,
  newEmailPerDay: 50, newWaPerDay: 20, waMaxPerDay: 100,
};
const ELIGIBLE_LEAD_STATUSES = ['new', 'no_response'];
const STOP_LEAD_STATUSES = ['not_interested', 'opted_out', 'dead'];
const MIN_HOURS_BETWEEN_TOUCHES = 20; // never two touches (on any channel) the same day
const TICK_LIMIT = 40;

async function num(key, fallback, { allowZero = false } = {}) {
  const n = Number.parseInt(await settingsService.getSetting(key), 10);
  return Number.isFinite(n) && (n > 0 || (allowZero && n === 0)) ? n : fallback;
}

async function loadConfig() {
  const restRaw = (await settingsService.getSetting('CADENCE_REST_DAYS')) || '';
  const rest = restRaw.split(',').map((d) => Number.parseInt(d, 10)).filter((d) => d > 0);
  return {
    enabled: String(await settingsService.getSetting('CADENCE_ENABLED') || '').toLowerCase() === 'true',
    emailTouches: await num('CADENCE_EMAIL_TOUCHES', DEFAULTS.emailTouches),
    waTouches: await num('CADENCE_WA_TOUCHES', DEFAULTS.waTouches),
    emailGapDays: await num('CADENCE_EMAIL_GAP_DAYS', DEFAULTS.emailGapDays),
    waGapDays: await num('CADENCE_WA_GAP_DAYS', DEFAULTS.waGapDays),
    restDays: rest.length ? rest : DEFAULTS.restDays,
    maxCycles: await num('CADENCE_MAX_CYCLES', DEFAULTS.maxCycles, { allowZero: true }),
    newEmailPerDay: await num('CADENCE_NEW_EMAIL_PER_DAY', DEFAULTS.newEmailPerDay, { allowZero: true }),
    newWaPerDay: await num('CADENCE_NEW_WA_PER_DAY', DEFAULTS.newWaPerDay, { allowZero: true }),
    waMaxPerDay: await num('CADENCE_WA_MAX_PER_DAY', DEFAULTS.waMaxPerDay, { allowZero: true }),
    emailOnlyIfVerified: String(await settingsService.getSetting('CADENCE_EMAIL_ONLY_IF_VERIFIED') ?? '').trim().toLowerCase() !== 'false',
  };
}

const other = (ch) => (ch === 'email' ? 'whatsapp' : 'email');
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------------------------
// Pure state machine: given the cadence row BEFORE a touch on `channelUsed`, and which channels
// are usable, return the row AFTER it. No I/O — unit-tested in scripts/test_cadence.js.
// ---------------------------------------------------------------------------------------------
function planAfterTouch(state, channelUsed, usable, cfg, now = new Date()) {
  const s = {
    ...state,
    touches_on_channel: (state.touches_on_channel || 0) + 1,
    total_touches: (state.total_touches || 0) + 1,
    last_touch_at: now,
    last_channel: channelUsed,
    status: 'active',
  };
  const limit = channelUsed === 'email' ? cfg.emailTouches : cfg.waTouches;
  const gapDays = channelUsed === 'email' ? cfg.emailGapDays : cfg.waGapDays;
  const next = (days) => new Date(now.getTime() + days * DAY_MS);

  if (s.touches_on_channel < limit && usable[channelUsed]) {
    return { ...s, current_channel: channelUsed, next_touch_at: next(gapDays) };
  }
  // Block on this channel done. If this was the cycle's first block and the other channel works → switch.
  const otherCh = other(channelUsed);
  if (channelUsed === (s.cycle_start_channel || channelUsed) && usable[otherCh]) {
    return { ...s, current_channel: otherCh, touches_on_channel: 0, next_touch_at: next(gapDays) };
  }
  // Cycle done.
  if (cfg.maxCycles > 0 && (s.cycle || 1) >= cfg.maxCycles) {
    return { ...s, status: 'dead', next_touch_at: null, stop_reason: 'no_response_all_cycles' };
  }
  const startNext = usable[other(s.cycle_start_channel || channelUsed)] ? other(s.cycle_start_channel || channelUsed) : (s.cycle_start_channel || channelUsed);
  const restIdx = Math.min((s.cycle || 1) - 1, cfg.restDays.length - 1);
  return {
    ...s,
    status: 'resting',
    cycle: (s.cycle || 1) + 1,
    cycle_start_channel: startNext,
    current_channel: startNext,
    touches_on_channel: 0,
    next_touch_at: next(cfg.restDays[restIdx]),
  };
}

// ---------------------------------------------------------------------------------------------
// Channel checks
// ---------------------------------------------------------------------------------------------
async function getOwnDomains() {
  const raw = (await settingsService.getSetting('OWN_EMAIL_DOMAINS')) || 'dreamstechnology.in,dreams-technology.com';
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

async function emailUsable(lead) {
  if (!lead.email || lead.email_status !== 'verified') return false; // unverified = never sent
  const domain = String(lead.email).split('@')[1]?.toLowerCase();
  if (domain && (await getOwnDomains()).includes(domain)) return false;
  // Owner's rule: no cold email without research on the lead. No site to research (no website, free-mail
  // address) or research permanently failed → email is not an option; WhatsApp only. Research still
  // pending → usable, the touch waits for it (sendEmailTouch).
  if (!researchSiteFor(lead)) return false;
  if (!(await getCachedResearch(lead.id)) && (lead.research_attempts || 0) >= RESEARCH_MAX_ATTEMPTS) return false;
  return true;
}

function waUsable(lead, row) {
  return !row?.wa_unusable && /^91[6-9]\d{9}$/.test(lead.whatsapp_number || '');
}

async function usedTemplateIds(leadId) {
  const r = await pool.query('SELECT DISTINCT template_id FROM outreach_logs WHERE lead_id = $1 AND template_id IS NOT NULL', [leadId]);
  return new Set(r.rows.map((x) => x.template_id));
}

// Required lazily: schedulerService starts its cron jobs on load.
function pickTemplate(lead, used) {
  return require('./schedulerService').pickFollowUpTemplate(lead, used, { strictIndustry: true });
}

async function istDayStart() {
  const r = await pool.query(`SELECT (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::timestamp AS t`);
  return r.rows[0].t;
}

async function waSentToday() {
  // Failed sends (Meta's async 'failed' status) don't count — they never reached anyone.
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM outreach_logs ol JOIN hotel_leads hl ON hl.id = ol.lead_id
     WHERE hl.cadence_managed AND ol.message_type = 'template' AND ol.sent_at >= $1 AND ol.error_message IS NULL`,
    [await istDayStart()]
  );
  return r.rows[0].n;
}

async function logAction(leadId, action, detail, decision, draftText = null) {
  await pool.query(
    `INSERT INTO agent_actions (lead_id, action, detail, draft_text, decision) VALUES ($1, $2, $3, $4, $5)`,
    [leadId, action, JSON.stringify(detail || {}), draftText, decision]
  ).catch((e) => console.error('[Cadence] agent_actions insert failed:', e.message));
}

async function saveState(leadId, s) {
  await pool.query(
    `UPDATE lead_cadence SET current_channel=$2, touches_on_channel=$3, total_touches=$4, cycle=$5, status=$6,
       next_touch_at=$7, last_touch_at=$8, last_channel=$9, cycle_start_channel=$10, stop_reason=$11,
       wa_unusable=$12, last_wait_reason=NULL, updated_at=NOW()
     WHERE lead_id=$1`,
    [leadId, s.current_channel, s.touches_on_channel, s.total_touches, s.cycle, s.status, s.next_touch_at,
     s.last_touch_at, s.last_channel, s.cycle_start_channel, s.stop_reason || null, Boolean(s.wa_unusable)]
  );
}

// reason is kept in last_wait_reason so Lead Sources can say why leads are waiting (cleared on a send).
async function deferTouch(leadId, hours, reason) {
  await pool.query(
    `UPDATE lead_cadence SET next_touch_at = NOW() + ($2 || ' hours')::interval, last_wait_reason = $3, updated_at = NOW()
     WHERE lead_id = $1`,
    [leadId, String(hours), String(reason).slice(0, 40)]
  );
  return `deferred:${reason}`;
}

// ---------------------------------------------------------------------------------------------
// Intake: start the cadence for new directory leads, within today's per-channel quotas.
// ---------------------------------------------------------------------------------------------
async function enrollNewLeads(cfg) {
  const today = await istDayStart();
  const counts = await pool.query(
    `SELECT first_channel, COUNT(*)::int AS n FROM lead_cadence WHERE started_at >= $1 AND first_channel IS NOT NULL GROUP BY first_channel`,
    [today]
  );
  const started = Object.fromEntries(counts.rows.map((r) => [r.first_channel, r.n]));
  const remaining = {
    email: Math.max(0, cfg.newEmailPerDay - (started.email || 0)),
    whatsapp: Math.max(0, cfg.newWaPerDay - (started.whatsapp || 0)),
  };
  if (remaining.email + remaining.whatsapp === 0) return { enrolled: 0, quotaFull: true };

  const { rows } = await pool.query(
    `SELECT hl.* FROM hotel_leads hl
     LEFT JOIN lead_cadence lc ON lc.lead_id = hl.id
     WHERE hl.cadence_managed AND lc.lead_id IS NULL
       AND hl.status = 'new' AND hl.needs_attention = FALSE AND COALESCE(hl.ai_paused, FALSE) = FALSE
       -- a mobile or an email (verified now or pending) — leads with neither (landline/website only)
       -- must not fill this window ahead of contactable ones
       AND (hl.whatsapp_number ~ '^91[6-9][0-9]{9}$' OR COALESCE(TRIM(hl.email), '') <> '')
     ORDER BY hl.lead_score DESC, hl.id -- hot leads (most complete contact data) start first
     LIMIT $1`,
    [(remaining.email + remaining.whatsapp) * 3]
  );

  const out = { enrolled: 0, email: 0, whatsapp: 0, waitingForVerification: 0 };
  for (const lead of rows) {
    // CADENCE_EMAIL_ONLY_IF_VERIFIED (default on, owner 2026-10-10): a lead with a usable, verified email is
    // contacted by email ONLY; no email / not verified (yet) → WhatsApp. If mails.so verifies it later,
    // processRow switches the next touch to email. Off → both channels, balanced by remaining quota.
    let channel;
    const emailOk = await emailUsable(lead);
    if (cfg.emailOnlyIfVerified) {
      if (emailOk && remaining.email <= 0) continue; // today's email intake is full — never falls back to WhatsApp
      channel = emailOk ? 'email' : (waUsable(lead) && remaining.whatsapp > 0 ? 'whatsapp' : null);
    } else {
      const e = emailOk && remaining.email > 0;
      const w = waUsable(lead) && remaining.whatsapp > 0;
      channel = e && w ? (remaining.email >= remaining.whatsapp ? 'email' : 'whatsapp') : (e ? 'email' : (w ? 'whatsapp' : null));
    }
    if (!channel) {
      if (lead.email && ['unknown', 'found'].includes(lead.email_status)) out.waitingForVerification++;
      continue;
    }
    const ins = await pool.query(
      `INSERT INTO lead_cadence (lead_id, current_channel, first_channel, cycle_start_channel, status, next_touch_at, started_at)
       VALUES ($1, $2, $2, $2, 'active', NOW(), NOW()) ON CONFLICT (lead_id) DO NOTHING RETURNING lead_id`,
      [lead.id, channel]
    );
    if (!ins.rows[0]) continue;
    remaining[channel]--;
    out[channel]++;
    out.enrolled++;
    if (remaining.email + remaining.whatsapp === 0) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// One touch
// ---------------------------------------------------------------------------------------------
async function priorMessagesForComposer(leadId) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT subject, body, COALESCE(sent_at, created_at) AS at FROM email_logs
       WHERE lead_id = $1 AND direction = 'out' AND error IS NULL
       UNION ALL
       SELECT '(WhatsApp message)', COALESCE(ol.message_text, wt.body_text), ol.sent_at
       FROM outreach_logs ol LEFT JOIN waba_templates wt ON wt.id = ol.template_id WHERE ol.lead_id = $1
     ) m WHERE body IS NOT NULL ORDER BY at DESC LIMIT 6`,
    [leadId]
  );
  return rows.reverse();
}

async function sendEmailTouch(lead, row, isFinalTouch) {
  // Never a generic email: wait for researchWorker (website, or the email's company domain). emailUsable()
  // already rules out leads that can't be researched; this guards a lead whose research is still running.
  const research = await getCachedResearch(lead.id);
  if (!research) return { wait: 'awaiting_research', hours: 2 };
  // Same mailbox as this lead's first email; waits if that mailbox is paused or full today.
  const sender = await EmailSenderService.getSenderForLead(lead.id);
  if (!sender) return { wait: 'no_sender_capacity', hours: 3 };

  const emailTouchesSoFar = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM email_logs WHERE lead_id = $1 AND direction = 'out' AND error IS NULL`, [lead.id]
  )).rows[0].n;
  // Composer stages: 0 = first ever email, 1 = follow-up, 2 = polite last note (only the very last touch).
  const stepNumber = isFinalTouch ? 2 : (emailTouchesSoFar === 0 ? 0 : 1);

  // Owner's bar for directory emails: personal, human, specific to their trade, never AI-sounding —
  // only >= CADENCE_EMAIL_MIN_SCORE (4.5) is sent. A draft that can't reach it is held and rewritten
  // tomorrow; after 3 held days the touch moves to the other channel rather than stalling the lead.
  const trade = lead.niche || lead.business_category || 'their line of business';
  const guidance = `${WRITING_RULES}\nThis owner's trade: ${trade}${lead.business_category && lead.niche ? ` (listed as "${lead.business_category}")` : ''}. ` +
    `Use their first name (${firstName(lead)}) and refer to something real about running a ${trade} business.` +
    (stepNumber > 0 ? ' This is not the first email: ask only ONE question, the closing yes/no one.' : '');
  const minScore = Number.parseFloat(await settingsService.getSetting('CADENCE_EMAIL_MIN_SCORE')) || 4.5;

  const { composeAndSendColdEmail } = require('../workers/sequenceEmailWorker');
  let sent;
  try {
    sent = await composeAndSendColdEmail({
      leadId: lead.id, lead, leadEmail: lead.email, stepNumber, sender, research,
      priorEmails: await priorMessagesForComposer(lead.id),
      logDetail: { cadence: true, cycle: row.cycle },
      quality: { minScore, strict: true, attempts: 3, holdIfBelow: true, guidance },
    });
  } catch (err) {
    console.error(`[Cadence] compose failed for lead ${lead.id}:`, err.message);
    return { wait: 'compose_failed', hours: 1 };
  }
  if (sent.held) {
    const heldRecently = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_actions WHERE lead_id = $1 AND action = 'cadence_email_held' AND created_at > NOW() - INTERVAL '7 days'`,
      [lead.id]
    )).rows[0].n;
    await logAction(lead.id, 'cadence_email_held', { score: sent.finalQualityScore, minScore, feedback: sent.feedback }, 'held_low_quality', sent.composed?.body);
    if (heldRecently + 1 >= 3) return { channelBroken: 'email_quality' };
    return { wait: 'email_below_quality_bar', hours: 24 };
  }
  const { sendResult, composed, html, trackingToken, finalQualityScore } = sent;

  if (!sendResult.success) {
    await pool.query(
      `INSERT INTO email_logs (lead_id, sender_id, direction, subject, body, error, sent_at) VALUES ($1,$2,'out',$3,$4,$5,NOW())`,
      [lead.id, sender.id, composed.subject, html, sendResult.error]
    );
    const invalid = sendResult.status === 400 &&
      /not valid|invalid.*(email|recipient|to\b)|does not exist|no such (user|recipient|mailbox)|mailbox.*(unavailable|not found)/i.test(sendResult.error || '');
    if (invalid) {
      await pool.query(`UPDATE hotel_leads SET email_status = 'bounced', updated_at = NOW() WHERE id = $1`, [lead.id]);
      await SuppressionService.addToSuppression(lead.email, 'invalid_email');
      return { channelBroken: 'email' };
    }
    return { wait: 'send_failed', hours: 1 };
  }

  await pool.query(
    `INSERT INTO email_logs (lead_id, sender_id, direction, subject, body, provider_message_id, tracking_token, sent_at)
     VALUES ($1, $2, 'out', $3, $4, $5, $6, NOW())`,
    [lead.id, sender.id, composed.subject, html, sendResult.messageId, trackingToken]
  );
  await logAction(lead.id, 'cadence_email_sent', { subject: composed.subject, senderId: sender.id, cycle: row.cycle, score: finalQualityScore }, 'send', composed.body);
  return { sent: true };
}

// "Maulik Patel" → "Maulik"; "Shri Girishbhai S. Shah" → "Girishbhai". When the name starts with an
// initial or a title ("R. V. Patel", "Dr. Mehta") the whole name reads better than a bare surname.
const HONORIFICS = /^(mr|mrs|ms|shri|smt|shree)\.?$/i;
const titleWord = (w) => (w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w);
function firstName(lead) {
  const parts = String(lead.owner_name || '').trim().split(/\s+/).filter((p) => p && !HONORIFICS.test(p));
  if (parts.length === 0) return 'there';
  if (/^[A-Za-z][A-Za-z'-]+$/.test(parts[0])) return titleWord(parts[0]);
  return parts.map(titleWord).join(' ').slice(0, 40);
}

async function sendWhatsappTouch(lead, row, template) {
  if (!template) return { channelBroken: 'whatsapp_no_template' };
  // Directory templates map {{1}} → owner_first_name ("Hi Maulik,"), not the full name/company.
  const res = await WABAService.sendPersonalizedTemplate({ ...lead, owner_first_name: firstName(lead) }, template);
  if (!res.success) {
    await logAction(lead.id, 'cadence_whatsapp_failed', { template: template.template_name, error: res.error }, 'error');
    // Not on WhatsApp / invalid number / blocked → this lead's WhatsApp is done; anything else retries.
    if (/not.*(valid|whatsapp)|131026|131021|recipient|blocked|undeliverable/i.test(res.error || '')) return { channelBroken: 'whatsapp' };
    return { wait: 'wa_send_failed', hours: 1 };
  }
  await LeadService.logOutreach(lead.id, null, template.id, res.messageId);
  await logAction(lead.id, 'cadence_whatsapp_sent', { template: template.template_name, cycle: row.cycle }, 'send', template.body_text);
  // Reached WA_TEMPLATE_RETIRE_AFTER sends → retired now (deleted on Meta), replaced on the next pool run.
  await require('./templatePoolService').retireUsedUp({ templateId: template.id })
    .catch((err) => console.error('[Cadence] template retire check failed:', err.message));
  return { sent: true };
}

async function processRow(row, cfg, budget) {
  const lead = (await pool.query('SELECT * FROM hotel_leads WHERE id = $1', [row.lead_id])).rows[0];
  if (!lead || !lead.cadence_managed) { await stopCadence(row.lead_id, 'stopped', 'not_cadence_managed'); return 'stopped'; }

  if (STOP_LEAD_STATUSES.includes(lead.status)) { await stopCadence(lead.id, 'stopped', `lead_${lead.status}`); return 'stopped'; }
  if (!ELIGIBLE_LEAD_STATUSES.includes(lead.status)) { await stopCadence(lead.id, 'replied', `lead_${lead.status}`); return 'stopped'; }
  if (lead.needs_attention || lead.ai_paused) return deferTouch(lead.id, 24, 'needs_attention');
  if (lead.email && await SuppressionService.isSuppressed(lead.email)) { await stopCadence(lead.id, 'stopped', 'unsubscribed'); return 'stopped'; }

  if (row.last_touch_at && Date.now() - new Date(row.last_touch_at).getTime() < MIN_HOURS_BETWEEN_TOUCHES * 3600000) {
    return deferTouch(lead.id, MIN_HOURS_BETWEEN_TOUCHES, 'same_day_guard');
  }

  // A WhatsApp touch needs an approved, not-yet-sent, industry-matched template — picked once here
  // and reused for the send (the picker may make a GPT call when several fit).
  // CADENCE_EMAIL_ONLY_IF_VERIFIED: usable email → email only, never WhatsApp (same rule as intake).
  const usable = { email: await emailUsable(lead) };
  usable.whatsapp = !(cfg.emailOnlyIfVerified && usable.email) && waUsable(lead, row);
  const template = usable.whatsapp ? await pickTemplate(lead, await usedTemplateIds(lead.id)) : null;
  if (!template) usable.whatsapp = false;

  let channel = row.current_channel || row.cycle_start_channel || 'email';
  let state = { ...row, current_channel: channel };
  if (!usable[channel]) {
    if (!usable[other(channel)]) {
      if (lead.email && ['unknown', 'found'].includes(lead.email_status)) return deferTouch(lead.id, 24, 'awaiting_verification');
      if (waUsable(lead, row)) return deferTouch(lead.id, 24, 'no_approved_template'); // templates may get approved
      await stopCadence(lead.id, 'stopped', 'no_usable_channel');
      if (lead.phone || lead.whatsapp_number) {
        await flagForCall(lead.id, row.wa_unusable ? 'WhatsApp not delivered and no usable email' : 'No WhatsApp number and no usable email');
      }
      return 'stopped';
    }
    // e.g. no approved template yet → use email this touch instead. The touch count restarts for the
    // new channel, and if nothing was sent yet in this cycle it becomes the cycle's start channel.
    const freshCycle = (row.touches_on_channel || 0) === 0 && row.current_channel === row.cycle_start_channel;
    channel = other(channel);
    state = { ...row, current_channel: channel, touches_on_channel: 0, cycle_start_channel: freshCycle ? channel : row.cycle_start_channel };
  }
  if (channel === 'whatsapp' && budget.wa <= 0) return deferTouch(lead.id, 12, 'wa_daily_cap');

  const plan = planAfterTouch(state, channel, usable, cfg);
  const result = channel === 'email'
    ? await sendEmailTouch(lead, state, plan.status === 'dead')
    : await sendWhatsappTouch(lead, state, template);

  if (result.wait) return deferTouch(lead.id, result.hours, result.wait);
  // Emails keep missing the quality bar and WhatsApp isn't an option → wait a day, don't loop every tick.
  if (result.channelBroken === 'email_quality' && !usable.whatsapp) return deferTouch(lead.id, 24, 'email_below_quality_bar');
  if (result.channelBroken) {
    const s = { ...state };
    if (result.channelBroken === 'whatsapp') s.wa_unusable = true;
    // Try the other channel on the next tick (or stop then if nothing is usable).
    await saveState(lead.id, { ...s, current_channel: other(channel), next_touch_at: new Date() });
    return `channel_broken:${result.channelBroken}`;
  }

  if (channel === 'whatsapp') budget.wa--;
  await saveState(lead.id, { ...plan, wa_unusable: row.wa_unusable });
  if (plan.status === 'dead') {
    await pool.query(`UPDATE hotel_leads SET status = 'no_response', updated_at = NOW() WHERE id = $1 AND status = 'new'`, [lead.id]);
    await logAction(lead.id, 'cadence_finished', { cycles: plan.cycle, touches: plan.total_touches }, 'no_response');
  }
  return `sent:${channel}`;
}

// ---------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------
let isRunning = false;

async function runCadence(trigger = 'cron') {
  if (isRunning) return { skipped: true, reason: 'already_running' };
  const cfg = await loadConfig();
  if (!cfg.enabled) return { skipped: true, reason: 'CADENCE_ENABLED is not true' };
  if (trigger !== 'manual') {
    const window = await isWithinSendWindow();
    if (!window.allowed) return { skipped: true, reason: 'outside_send_window' };
  }

  isRunning = true;
  const stats = { trigger, intake: null, due: 0, outcomes: {} };
  try {
    stats.intake = await enrollNewLeads(cfg);
    const budget = { wa: Math.max(0, cfg.waMaxPerDay - (await waSentToday())) };
    const { rows } = await pool.query(
      `SELECT * FROM lead_cadence WHERE status IN ('active', 'resting') AND next_touch_at <= NOW()
       ORDER BY (total_touches = 0) DESC, next_touch_at ASC LIMIT $1`,
      [TICK_LIMIT]
    );
    stats.due = rows.length;
    for (const row of rows) {
      let outcome;
      try {
        outcome = await processRow(row, cfg, budget);
      } catch (err) {
        console.error(`[Cadence] lead ${row.lead_id} failed:`, err.message);
        outcome = 'error';
        await deferTouch(row.lead_id, 1, 'error').catch(() => {});
      }
      const key = String(outcome).split(':').slice(0, 2).join(':');
      stats.outcomes[key] = (stats.outcomes[key] || 0) + 1;
    }
  } finally {
    isRunning = false;
  }
  console.log(`[Cadence] ${JSON.stringify(stats)}`);
  return stats;
}

// Meta reports a template as 'failed' asynchronously (webhook), after the cadence already counted the
// touch. Owner's rule (2026-10-10): one failed WhatsApp = never WhatsApp that lead again. Most failures
// are Meta's per-recipient marketing cap (131049 "healthy ecosystem engagement"), "undeliverable" (not
// on WhatsApp) or Meta's experiment holdout, so a retry with another template just fails again (103
// failed sends in 3 days under the old 24h-retry rule). WhatsApp goes off, the touch is undone and the
// lead moves to email; no usable email → the cadence stops and the lead lands on the Call list.
async function handleWhatsappSendFailed(leadId, errMsg) {
  const row = (await pool.query(
    `SELECT lc.* FROM lead_cadence lc JOIN hotel_leads hl ON hl.id = lc.lead_id
     WHERE lc.lead_id = $1 AND hl.cadence_managed AND lc.status IN ('active', 'resting')`,
    [leadId]
  )).rows[0];
  if (!row) return 'skipped';
  const lead = (await pool.query('SELECT * FROM hotel_leads WHERE id = $1', [leadId])).rows[0];

  // Email still being verified → switch now; processRow waits for verification, then emails or flags.
  const emailPending = Boolean(lead.email) && ['unknown', 'found'].includes(lead.email_status);
  if (!emailPending && !(await emailUsable(lead))) {
    await pool.query(`UPDATE lead_cadence SET wa_unusable = TRUE, updated_at = NOW() WHERE lead_id = $1`, [leadId]);
    await stopCadence(leadId, 'stopped', 'wa_failed_no_email');
    await flagForCall(leadId, `WhatsApp not delivered (${errMsg}) and no usable email`);
    return 'call_list';
  }

  // The failed touch never reached them, so take it back. A lead never emailed before has had no real
  // touch yet: email goes out on the next tick instead of waiting out the same-day guard or a rest.
  const reachedBefore = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM email_logs WHERE lead_id = $1 AND direction = 'out' AND error IS NULL`, [leadId]
  )).rows[0].n > 0;
  await pool.query(
    `UPDATE lead_cadence SET wa_unusable = TRUE, current_channel = 'email', touches_on_channel = 0,
       total_touches = GREATEST(total_touches - 1, 0),
       cycle_start_channel = CASE WHEN $2 THEN cycle_start_channel ELSE 'email' END,
       last_touch_at = CASE WHEN $2 THEN last_touch_at ELSE NULL END,
       next_touch_at = CASE WHEN $2 AND status = 'resting' THEN next_touch_at ELSE NOW() END,
       status = CASE WHEN $2 THEN status ELSE 'active' END,
       last_wait_reason = 'wa_failed_to_email', updated_at = NOW()
     WHERE lead_id = $1`,
    [leadId, reachedBefore]
  );
  await logAction(leadId, 'cadence_whatsapp_failed_to_email', { error: errMsg, emailPending }, 'switch_to_email');
  return 'moved_to_email';
}

// Leads only a phone call can reach — Leads → "📞 Call list" until marked called.
async function flagForCall(leadId, reason) {
  await pool.query(
    `UPDATE hotel_leads SET call_needed_at = COALESCE(call_needed_at, NOW()), call_reason = $2, updated_at = NOW()
     WHERE id = $1 AND call_done_at IS NULL`,
    [leadId, String(reason).slice(0, 300)]
  );
  await logAction(leadId, 'call_list_flagged', { reason }, 'call');
}

module.exports = { runCadence, planAfterTouch, enrollNewLeads, loadConfig, firstName, DEFAULTS, handleWhatsappSendFailed, flagForCall };
