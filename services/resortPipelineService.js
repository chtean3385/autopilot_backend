// Resort CRM pipeline, tasks 5+6 (_docs/resort-crm/plan.md): the ONLY thing that sends cold-start
// WhatsApp templates to pipeline = 'resort_crm' leads (Meta-ad leads for our own hotel CRM, Dream Stay).
//
// Per lead: intro (day 0) → follow-up picked from their ad-form answers (+2 days) → "should I close your
// enquiry?" (+4 days) → status 'no_response'. Any reply stops it for good — from then on the Dream Stay
// agent (resortReplyService.js) owns the chat. Nothing is sent unless RESORT_PIPELINE_ENABLED=true, and
// only inside the IST send window (a manual run skips the window, never the switch). Catch-up safe:
// due = next_touch_at <= NOW(), so missed ticks just send on the next one.
//
// Templates are hand-written in data/resort-crm-templates.json, kept in waba_templates with
// industry = 'resort_crm' and a template_group, which keeps them out of every generic template picker.
const pool = require('../config/db');
const WABAService = require('./wabaService');
const { getSetting } = require('./settingsService');
const { isWithinSendWindow } = require('../utils/sendWindow');
const TEMPLATE_FILE = require('../data/resort-crm-templates.json');

const PIPELINE = 'resort_crm';
const MAX_TOUCHES = 3;
const FRESH_DAYS = 7; // form filled within this many days → "thanks for asking" intro, else "sorry it took a while"
const PARAM_MAPPING = { 1: 'rc_first_name', 2: 'rc_property' };
const TYPE_WORD = { hotel: 'hotel', resort: 'resort', guest_house: 'guest house' };

async function loadConfig() {
  const [enabled, perDay, gaps] = await Promise.all(
    ['RESORT_PIPELINE_ENABLED', 'RESORT_NEW_PER_DAY', 'RESORT_GAP_DAYS'].map(getSetting));
  const gapList = String(gaps || '2,4').split(',').map((n) => Number(n.trim())).filter((n) => n > 0);
  return {
    enabled: String(enabled).toLowerCase() === 'true',
    newPerDay: Math.max(0, Number.parseInt(perDay, 10) || 20),
    gaps: [gapList[0] || 2, gapList[1] || gapList[0] || 4],
  };
}

// ── Templates ──────────────────────────────────────────────────────────────────────────────────────

// Insert any template from the JSON file that isn't in waba_templates yet, as a draft. Never touches
// existing rows (their status comes from Meta).
async function ensureTemplates() {
  let added = 0;
  for (const t of TEMPLATE_FILE.templates) {
    // category / buttons / no_footer come from the JSON (the UTILITY follow-up has quick-reply buttons, no footer).
    const r = await pool.query(
      `INSERT INTO waba_templates (template_name, template_category, body_text, footer_text, status, industry,
         template_group, parameter_mapping, examples, created_by, auto_generated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'resort_crm_pipeline', FALSE)
       ON CONFLICT (template_name) DO NOTHING RETURNING id`,
      [t.template_name, t.category || 'MARKETING', t.body, t.no_footer ? null : TEMPLATE_FILE.footer,
       'draft', PIPELINE, `dreamstay_${t.role}`,
       JSON.stringify(PARAM_MAPPING), JSON.stringify(t.examples)]);
    added += r.rowCount;
  }
  return added;
}

// Submit every draft Dream Stay template to Meta. Owner-triggered (POST /api/resort-crm/templates/submit).
async function submitTemplates() {
  await ensureTemplates();
  const drafts = (await pool.query(
    `SELECT * FROM waba_templates WHERE industry = $1 AND status = 'draft' ORDER BY id`, [PIPELINE])).rows;
  const results = [];
  for (const t of drafts) {
    const res = await WABAService.submitTemplateToMeta({
      template_name: t.template_name, body_text: t.body_text, footer_text: t.footer_text,
      template_category: (t.template_category || 'MARKETING').toUpperCase(), language: 'en_US',
      examples: typeof t.examples === 'string' ? JSON.parse(t.examples) : t.examples,
      buttons: TEMPLATE_FILE.templates.find((x) => x.template_name === t.template_name)?.buttons,
    });
    if (res.success) {
      await pool.query(
        `UPDATE waba_templates SET status = $2, meta_template_id = $3, submitted_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [t.id, WABAService.localStatus(res.data?.status || 'PENDING'), res.data?.id || null]);
    }
    results.push({ template: t.template_name, ok: res.success, error: res.error || null, status: res.data?.status || null });
  }
  return results;
}

async function templateStatus() {
  await ensureTemplates();
  return (await pool.query(
    `SELECT t.id, t.template_name, t.template_group, t.status, t.template_category, t.rejection_reason, t.submitted_at, t.body_text,
            (SELECT COUNT(*)::int FROM outreach_logs ol WHERE ol.template_id = t.id) AS sent
     FROM waba_templates t WHERE t.industry = $1 ORDER BY t.id`, [PIPELINE])).rows;
}

// ── Per-lead personalisation ───────────────────────────────────────────────────────────────────────

const form = (lead) => (typeof lead.ad_form === 'string' ? JSON.parse(lead.ad_form) : lead.ad_form) || {};

// {{1}} / {{2}} values. Meta rejects empty variables, so both always have a fallback.
function leadVars(lead) {
  const f = form(lead);
  const word = TYPE_WORD[f.business_type] || 'property';
  return {
    rc_first_name: f.first_name || 'there',
    rc_property: lead.city ? `your ${word} in ${lead.city}` : `your ${word}`,
  };
}

// Which template role the next touch (1-based) uses for this lead.
function roleForTouch(lead, touch) {
  const f = form(lead);
  if (touch === 1) {
    const submitted = f.submitted_at ? new Date(f.submitted_at) : null;
    const fresh = submitted && !Number.isNaN(submitted.getTime()) && Date.now() - submitted.getTime() < FRESH_DAYS * 86400000;
    return fresh ? 'intro_fresh' : 'intro_late';
  }
  if (touch === 2) {
    if (f.uses_software === 'no') return 'followup_no_software';
    if (['yes', 'looking_to_switch'].includes(f.uses_software)) return 'followup_has_software';
    return 'followup_direct_bookings';
  }
  return 'last';
}

async function approvedTemplate(role) {
  return (await pool.query(
    `SELECT * FROM waba_templates WHERE industry = $1 AND template_group = $2 AND status = 'approved'
       AND ($2 <> 'dreamstay_intro_utility' OR UPPER(template_category) = 'UTILITY')
     ORDER BY id DESC LIMIT 1`, [PIPELINE, `dreamstay_${role}`])).rows[0] || null;
}

// The UTILITY enquiry follow-up, only if Meta approved it AS utility. Meta's 131049 per-person cap only
// applies to MARKETING templates — if Meta re-categorised it, it's no better than the marketing intro.
const utilityIntro = () => approvedTemplate('intro_utility');

// Ask Meta for the real status + category of every Dream Stay template (the owner may have created or
// edited them in Business Manager, and Meta can re-categorise a template after approval).
async function syncFromMeta() {
  await ensureTemplates();
  const rows = (await pool.query(`SELECT id, template_name FROM waba_templates WHERE industry = $1`, [PIPELINE])).rows;
  const out = [];
  for (const r of rows) {
    const meta = await WABAService.getTemplateDetails(r.template_name);
    if (!meta) { out.push({ template: r.template_name, found: false }); continue; }
    await pool.query(
      `UPDATE waba_templates SET status = $2, template_category = COALESCE($3, template_category),
         rejection_reason = $4, meta_template_id = COALESCE(meta_template_id, $5), updated_at = NOW() WHERE id = $1`,
      [r.id, WABAService.localStatus(meta.status), meta.category || null, meta.rejected_reason && meta.rejected_reason !== 'NONE' ? meta.rejected_reason : null, meta.id || null]);
    out.push({ template: r.template_name, found: true, status: meta.status, category: meta.category });
  }
  return out;
}

// ── Sending ────────────────────────────────────────────────────────────────────────────────────────

async function logAction(leadId, action, detail, decision, draftText = null) {
  await pool.query(
    `INSERT INTO agent_actions (lead_id, action, detail, decision, draft_text) VALUES ($1, $2, $3, $4, $5)`,
    [leadId, action, JSON.stringify(detail || {}), decision, draftText]).catch(() => {});
}

async function hasReplied(leadId) {
  return (await pool.query(
    `SELECT 1 FROM outreach_logs WHERE lead_id = $1 AND response_received = TRUE LIMIT 1`, [leadId])).rowCount > 0;
}

// Send the next touch to one lead. Returns 'sent' | a reason it didn't.
async function sendNextTouch(leadId, cfg) {
  const lead = (await pool.query('SELECT * FROM hotel_leads WHERE id = $1', [leadId])).rows[0];
  const state = (await pool.query('SELECT * FROM resort_pipeline WHERE lead_id = $1', [leadId])).rows[0];
  if (!lead || lead.pipeline !== PIPELINE || !state) return 'not_in_pipeline';
  if (state.status !== 'active') return `state_${state.status}`;
  if (await hasReplied(leadId)) { await setState(leadId, { status: 'replied', next_touch_at: null }); return 'replied'; }
  if (['not_interested', 'unsubscribed', 'dead'].includes(lead.status)) { await setState(leadId, { status: 'stopped', stop_reason: `lead_${lead.status}`, next_touch_at: null }); return 'stopped'; }
  if (lead.needs_attention || lead.ai_paused) { await setState(leadId, { next_touch_at: hoursFromNow(24) }); return 'needs_attention'; }

  const touch = state.touches + 1;
  if (touch > MAX_TOUCHES) { await finishNoResponse(leadId); return 'no_response'; }
  // Past-enquiry sends: the owner picked the first-touch template themselves (state.intro_template_id).
  const picked = touch === 1 && state.intro_template_id
    ? (await pool.query(`SELECT * FROM waba_templates WHERE id = $1 AND status = 'approved'`, [state.intro_template_id])).rows[0] || null
    : null;
  if (touch === 1 && state.intro_template_id && !picked) { await setState(leadId, { next_touch_at: hoursFromNow(1) }); return 'no_approved_template:picked'; }
  const utility = !picked && touch === 1 ? await utilityIntro() : null;
  const role = picked ? 'intro_picked' : utility ? 'intro_utility' : roleForTouch(lead, touch);
  const template = picked || utility || await approvedTemplate(role);
  if (!template) {
    // Not approved by Meta yet — try again in an hour. Shows on the pipeline page as waiting.
    await setState(leadId, { next_touch_at: hoursFromNow(1) });
    return `no_approved_template:${role}`;
  }

  const res = await WABAService.sendPersonalizedTemplate({ ...lead, ...leadVars(lead) }, template);
  if (!res.success) {
    await logAction(leadId, 'resort_whatsapp_failed', { template: template.template_name, error: res.error }, 'error');
    if (/not.*(valid|whatsapp)|131026|131021|131049|recipient|blocked|undeliverable/i.test(res.error || '')) {
      await onSendFailed(leadId, res.error);
      return 'failed';
    }
    await setState(leadId, { next_touch_at: hoursFromNow(1) });
    return 'send_error_retry';
  }
  await pool.query(
    `INSERT INTO outreach_logs (lead_id, template_id, waba_message_id, message_type, message_text, sent_at)
     VALUES ($1, $2, $3, 'template', $4, NOW())`,
    [leadId, template.id, res.messageId, renderBody(template.body_text, lead)]);
  const gapDays = touch < MAX_TOUCHES ? cfg.gaps[touch - 1] : null;
  await setState(leadId, {
    touches: touch, last_touch_at: new Date(), last_template: template.template_name, queued: false,
    next_touch_at: gapDays ? hoursFromNow(gapDays * 24) : hoursFromNow(cfg.gaps[1] * 24), // after the last: wait, then no_response
  });
  await logAction(leadId, 'resort_whatsapp_sent', { template: template.template_name, touch, role }, 'send', renderBody(template.body_text, lead));
  return 'sent';
}

// What the lead actually saw — stored so the Inbox and the reply agent's "never repeat" check have it.
function renderBody(body, lead) {
  const v = leadVars(lead);
  return body.replace(/\{\{1\}\}/g, v.rc_first_name).replace(/\{\{2\}\}/g, v.rc_property);
}

const hoursFromNow = (h) => new Date(Date.now() + h * 3600000);

async function setState(leadId, fields) {
  const keys = Object.keys(fields);
  await pool.query(
    `UPDATE resort_pipeline SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE lead_id = $1`,
    [leadId, ...keys.map((k) => fields[k])]);
}

async function finishNoResponse(leadId) {
  await setState(leadId, { status: 'no_response', next_touch_at: null });
  await pool.query(`UPDATE hotel_leads SET status = 'no_response', updated_at = NOW() WHERE id = $1 AND status = 'new'`, [leadId]);
}

// Meta said the template didn't reach them (not on WhatsApp, blocked, per-recipient marketing cap…).
// WhatsApp is our only channel here, so the lead goes on the Call list instead of being retried.
async function onSendFailed(leadId, errMsg) {
  const r = await pool.query(
    `UPDATE resort_pipeline SET status = 'failed', stop_reason = $2, next_touch_at = NULL, updated_at = NOW()
     WHERE lead_id = $1 AND status = 'active' RETURNING lead_id`, [leadId, String(errMsg || '').slice(0, 300)]);
  if (!r.rowCount) return 'skipped';
  await pool.query(
    `UPDATE hotel_leads SET call_needed_at = COALESCE(call_needed_at, NOW()), call_reason = $2, updated_at = NOW()
     WHERE id = $1 AND call_done_at IS NULL`, [leadId, `Dream Stay ad lead — WhatsApp not delivered (${errMsg})`.slice(0, 300)]);
  await logAction(leadId, 'call_list_flagged', { reason: errMsg, pipeline: PIPELINE }, 'call');
  return 'call_list';
}

// Any inbound reply: templates stop for good; the Dream Stay agent owns the chat from here.
async function onReply(leadId) {
  await pool.query(
    `UPDATE resort_pipeline SET status = 'replied', next_touch_at = NULL, updated_at = NOW()
     WHERE lead_id = $1 AND status IN ('active', 'no_response')`, [leadId]);
}

// ── The tick ───────────────────────────────────────────────────────────────────────────────────────

const IST_TODAY_START_UTC = `date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC'`;

// Start today's quota of new leads — best first: wants a demo, then by how soon they want software,
// then most recent form.
async function enrollNew(cfg) {
  const startedToday = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM resort_pipeline WHERE created_at >= ${IST_TODAY_START_UTC}`)).rows[0].n;
  const room = cfg.newPerDay - startedToday;
  if (room <= 0) return 0;
  const r = await pool.query(
    `INSERT INTO resort_pipeline (lead_id, status, next_touch_at)
     SELECT hl.id, 'active', NOW() FROM hotel_leads hl
     WHERE hl.pipeline = $1 AND hl.status = 'new' AND hl.whatsapp_number IS NOT NULL
       AND hl.needs_attention = FALSE AND COALESCE(hl.ai_paused, FALSE) = FALSE
       AND COALESCE(hl.ad_form->>'past_enquiry', '') <> 'true'
       AND NOT EXISTS (SELECT 1 FROM resort_pipeline rp WHERE rp.lead_id = hl.id)
       AND NOT EXISTS (SELECT 1 FROM outreach_logs ol WHERE ol.lead_id = hl.id)
     ORDER BY (hl.ad_form->>'wants_demo' = 'yes') DESC NULLS LAST,
              CASE hl.ad_form->>'timeline' WHEN 'immediately' THEN 0 WHEN 'within_30_days' THEN 1
                   WHEN 'within_3_months' THEN 2 WHEN 'just_exploring' THEN 3 ELSE 4 END,
              hl.ad_form->>'submitted_at' DESC NULLS LAST, hl.id
     LIMIT $2
     ON CONFLICT (lead_id) DO NOTHING`, [PIPELINE, room]);
  return r.rowCount;
}

let running = false;
async function runPipeline(trigger = 'cron') {
  const cfg = await loadConfig();
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (trigger !== 'manual') {
    const win = await isWithinSendWindow();
    if (!win.allowed) return { skipped: 'outside_send_window' };
  }
  if (running) return { skipped: 'already_running' };
  running = true;
  const stats = { enrolled: 0, due: 0, sent: 0, waiting_template: 0, failed: 0, other: 0 };
  try {
    stats.enrolled = await enrollNew(cfg);
    const due = (await pool.query(
      `SELECT lead_id FROM resort_pipeline WHERE status = 'active' AND NOT queued AND next_touch_at <= NOW()
       ORDER BY next_touch_at LIMIT 50`)).rows; // queued rows belong to the one-click queue (runQueueTick)
    stats.due = due.length;
    for (const { lead_id: leadId } of due) {
      try {
        const out = await sendNextTouch(leadId, cfg);
        if (out === 'sent') stats.sent++;
        else if (out.startsWith('no_approved_template')) stats.waiting_template++;
        else if (out === 'failed') stats.failed++;
        else stats.other++;
      } catch (e) {
        stats.other++;
        console.error(`[ResortPipeline] lead ${leadId}:`, e.message);
        await setState(leadId, { next_touch_at: hoursFromNow(1) }).catch(() => {});
      }
    }
  } finally {
    running = false;
  }
  if (stats.enrolled || stats.sent || stats.failed) console.log(`[ResortPipeline] ${trigger}: ${JSON.stringify(stats)}`);
  return stats;
}

// Owner test button: put one lead in the pipeline (if needed) and send its next touch now — ignores the
// master switch and send window, still needs an approved template.
async function sendNowForLead(leadId) {
  await pool.query(
    `INSERT INTO resort_pipeline (lead_id, status, next_touch_at) SELECT id, 'active', NOW() FROM hotel_leads
     WHERE id = $1 AND pipeline = $2 ON CONFLICT (lead_id) DO NOTHING`, [leadId, PIPELINE]);
  return sendNextTouch(leadId, await loadConfig());
}

// ── One-click "send to all" queue ──────────────────────────────────────────────────────────────────
// Owner presses one button: every lead not reached yet gets the UTILITY enquiry follow-up, one at a time,
// gapMinutes apart (runQueueTick sends at most one per minute, so a restart can't burst them). Includes
// leads whose MARKETING intro Meta blocked with 131049 — the utility template isn't subject to that cap.
// Independent of RESORT_PIPELINE_ENABLED and the send window (an explicit owner action); follow-ups after
// it still need the master switch.
const QUEUE_ELIGIBLE = `
  hl.pipeline = $1 AND hl.whatsapp_number IS NOT NULL AND COALESCE(hl.ai_paused, FALSE) = FALSE
  AND hl.status NOT IN ('not_interested', 'unsubscribed', 'dead')
  AND COALESCE(hl.ad_form->>'past_enquiry', '') <> 'true' -- past enquiries are only sent via "send a template to a group"
  AND NOT EXISTS (SELECT 1 FROM outreach_logs r WHERE r.lead_id = hl.id AND r.response_received = TRUE)
  AND NOT EXISTS (SELECT 1 FROM outreach_logs u JOIN waba_templates t ON t.id = u.template_id     -- utility tried once already
                  WHERE u.lead_id = hl.id AND t.template_group = 'dreamstay_intro_utility')
  AND (rp.lead_id IS NULL
       OR (rp.status = 'failed' AND rp.touches <= 1 AND rp.stop_reason ILIKE '%ecosystem%'))`;

async function queueEligibleCount() {
  return (await pool.query(
    `SELECT COUNT(*)::int AS n FROM hotel_leads hl LEFT JOIN resort_pipeline rp ON rp.lead_id = hl.id WHERE ${QUEUE_ELIGIBLE}`,
    [PIPELINE])).rows[0].n;
}

// Leads a send of an owner-picked template would reach: this pipeline's leads in the group, not yet in the
// pipeline, never replied, never sent that template.
const PICKED_ELIGIBLE = `
  hl.pipeline = $1 AND hl.whatsapp_number IS NOT NULL AND COALESCE(hl.ai_paused, FALSE) = FALSE
  AND hl.status NOT IN ('not_interested', 'unsubscribed', 'dead')
  AND hl.id IN (SELECT lead_id FROM lead_group_members WHERE group_id = $2)
  AND NOT EXISTS (SELECT 1 FROM outreach_logs r WHERE r.lead_id = hl.id AND r.response_received = TRUE)
  AND NOT EXISTS (SELECT 1 FROM outreach_logs u WHERE u.lead_id = hl.id AND u.template_id = $3)
  AND rp.lead_id IS NULL`;

async function pickedTemplate(templateId) {
  const t = (await pool.query('SELECT * FROM waba_templates WHERE id = $1', [Number(templateId) || 0])).rows[0];
  if (!t) throw new Error('Template not found');
  if (t.status !== 'approved') throw new Error(`Template "${t.template_name}" is not approved by Meta yet (status: ${t.status})`);
  return t;
}

async function previewTemplateSend({ templateId, groupId }) {
  if (!Number(groupId)) throw new Error('Pick a group');
  const t = await pickedTemplate(templateId);
  const n = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM hotel_leads hl LEFT JOIN resort_pipeline rp ON rp.lead_id = hl.id WHERE ${PICKED_ELIGIBLE}`,
    [PIPELINE, Number(groupId), t.id])).rows[0].n;
  return { template: t.template_name, eligible: n };
}

async function queueAll({ gapMinutes = 2, templateId = null, groupId = null } = {}) {
  const gap = Math.min(Math.max(Number(gapMinutes) || 2, 1), 60);
  if (templateId) return queuePicked({ gap, templateId, groupId });
  if (!(await utilityIntro())) {
    throw new Error('The utility template "dreamstay_enquiry_followup" is not approved by Meta as UTILITY yet — press "Check Meta" after approval');
  }
  const leads = (await pool.query(
    `SELECT hl.id, rp.lead_id IS NOT NULL AS retry FROM hotel_leads hl LEFT JOIN resort_pipeline rp ON rp.lead_id = hl.id
     WHERE ${QUEUE_ELIGIBLE}
     ORDER BY (hl.ad_form->>'wants_demo' = 'yes') DESC NULLS LAST,
              CASE hl.ad_form->>'timeline' WHEN 'immediately' THEN 0 WHEN 'within_30_days' THEN 1
                   WHEN 'within_3_months' THEN 2 WHEN 'just_exploring' THEN 3 ELSE 4 END, hl.id`,
    [PIPELINE])).rows;
  // Continue after anything already queued, so pressing twice never doubles up or bunches sends.
  const lastQueued = (await pool.query(`SELECT MAX(next_touch_at) AS t FROM resort_pipeline WHERE queued AND status = 'active'`)).rows[0].t;
  const start = Math.max(Date.now(), lastQueued ? new Date(lastQueued).getTime() + gap * 60000 : 0);
  let i = 0;
  for (const l of leads) {
    const at = new Date(start + i * gap * 60000);
    if (l.retry) {
      // Blocked marketing intro → try again with the utility template; off the Call list unless already called.
      await pool.query(
        `UPDATE resort_pipeline SET status = 'active', touches = 0, queued = TRUE, next_touch_at = $2, stop_reason = NULL, updated_at = NOW()
         WHERE lead_id = $1`, [l.id, at]);
      await pool.query(
        `UPDATE hotel_leads SET call_needed_at = NULL, call_reason = NULL, updated_at = NOW()
         WHERE id = $1 AND call_done_at IS NULL AND call_reason LIKE 'Dream Stay%'`, [l.id]);
    } else {
      await pool.query(
        `INSERT INTO resort_pipeline (lead_id, status, queued, next_touch_at) VALUES ($1, 'active', TRUE, $2)
         ON CONFLICT (lead_id) DO NOTHING`, [l.id, at]);
    }
    i++;
  }
  await logAction(null, 'resort_queue_started', { leads: leads.length, gap_minutes: gap }, 'send');
  return { queued: leads.length, retries: leads.filter((l) => l.retry).length, gap_minutes: gap,
    finishes_at: leads.length ? new Date(start + (leads.length - 1) * gap * 60000) : null };
}

// Owner-picked template to a group (e.g. Ad_replied): same paced queue, first touch uses that template.
async function queuePicked({ gap, templateId, groupId }) {
  if (!Number(groupId)) throw new Error('Pick a group');
  const t = await pickedTemplate(templateId);
  const leads = (await pool.query(
    `SELECT hl.id FROM hotel_leads hl LEFT JOIN resort_pipeline rp ON rp.lead_id = hl.id WHERE ${PICKED_ELIGIBLE} ORDER BY hl.id`,
    [PIPELINE, Number(groupId), t.id])).rows;
  const lastQueued = (await pool.query(`SELECT MAX(next_touch_at) AS t FROM resort_pipeline WHERE queued AND status = 'active'`)).rows[0].t;
  const start = Math.max(Date.now(), lastQueued ? new Date(lastQueued).getTime() + gap * 60000 : 0);
  let i = 0;
  for (const l of leads) {
    await pool.query(
      `INSERT INTO resort_pipeline (lead_id, status, queued, next_touch_at, intro_template_id) VALUES ($1, 'active', TRUE, $2, $3)
       ON CONFLICT (lead_id) DO NOTHING`, [l.id, new Date(start + i * gap * 60000), t.id]);
    i++;
  }
  await logAction(null, 'resort_queue_started', { leads: leads.length, gap_minutes: gap, template: t.template_name, group_id: Number(groupId) }, 'send');
  return { queued: leads.length, retries: 0, gap_minutes: gap, template: t.template_name,
    finishes_at: leads.length ? new Date(start + (leads.length - 1) * gap * 60000) : null };
}

// Unsent queued leads go back to "not started" (retried 131049 leads back to failed would need their old
// reason — they simply stay not started, which is accurate: nothing reached them).
async function cancelQueue() {
  const r = await pool.query(`DELETE FROM resort_pipeline WHERE queued AND status = 'active' AND touches = 0 RETURNING lead_id`);
  return { cancelled: r.rowCount };
}

let queueBusy = false;
async function runQueueTick() {
  if (queueBusy) return { skipped: 'busy' };
  queueBusy = true;
  try {
    const next = (await pool.query(
      `SELECT lead_id FROM resort_pipeline WHERE queued AND status = 'active' AND next_touch_at <= NOW()
       ORDER BY next_touch_at LIMIT 1`)).rows[0];
    if (!next) return { sent: 0 };
    const out = await sendNextTouch(next.lead_id, await loadConfig());
    if (out !== 'sent') {
      // Not sent (replied meanwhile, flagged, template gone…) — leave the queue so it can't block it.
      await pool.query(`UPDATE resort_pipeline SET queued = FALSE, updated_at = NOW() WHERE lead_id = $1`, [next.lead_id]);
    }
    return { lead_id: next.lead_id, result: out };
  } finally {
    queueBusy = false;
  }
}

async function queueStatus() {
  const q = (await pool.query(
    `SELECT COUNT(*)::int AS waiting, MIN(next_touch_at) AS next_at, MAX(next_touch_at) AS last_at
     FROM resort_pipeline WHERE queued AND status = 'active'`)).rows[0];
  const utility = await utilityIntro();
  return { ...q, eligible: await queueEligibleCount(), utility_ready: Boolean(utility) };
}

async function summary() {
  const counts = (await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM hotel_leads WHERE pipeline = $1) AS leads,
      (SELECT COUNT(*)::int FROM hotel_leads hl WHERE pipeline = $1 AND NOT EXISTS (SELECT 1 FROM resort_pipeline rp WHERE rp.lead_id = hl.id)) AS not_started,
      COUNT(*) FILTER (WHERE rp.status = 'active')::int AS active,
      COUNT(*) FILTER (WHERE rp.status = 'replied')::int AS replied,
      COUNT(*) FILTER (WHERE rp.status = 'demo_booked')::int AS demo_booked,
      COUNT(*) FILTER (WHERE rp.status = 'no_response')::int AS no_response,
      COUNT(*) FILTER (WHERE rp.status IN ('failed', 'stopped'))::int AS stopped
    FROM resort_pipeline rp`, [PIPELINE])).rows[0];
  return { ...counts, config: await loadConfig(), queue: await queueStatus() };
}

module.exports = {
  previewTemplateSend,
  runPipeline, sendNowForLead, sendNextTouch, onReply, onSendFailed, ensureTemplates, submitTemplates,
  syncFromMeta, queueAll, cancelQueue, runQueueTick, queueStatus,
  templateStatus, summary, roleForTouch, leadVars, renderBody, loadConfig, setState, PIPELINE,
};
