const { getSetting } = require('../services/settingsService');
const pool = require('../config/db');

// WHATSAPP_OUTREACH_ENABLED (Settings, default on). Owner 2026-11-22: "false" stops ALL WhatsApp we start
// ourselves: directory cadence templates, 12 pm follow-ups, campaigns, agent-task sends, Dream Stay
// pipeline touches, redirect-contact templates. NOT affected: AI/staff replies to someone who messaged
// us first (free text inside the 24h window) and owner alerts (owner_alert template).
// Each job checks this and skips quietly (no lead is marked failed); WABAService.sendPersonalizedTemplate
// (the one function every cold template goes through) refuses as a backstop.
async function whatsappOutreachOn() {
  return String((await getSetting('WHATSAPP_OUTREACH_ENABLED')) ?? '').trim().toLowerCase() !== 'false';
}

// WA_COLD_TEMPLATES_PER_LEAD (Settings, default 1). Owner 2026-11-24: Meta charges ~₹0.86 + GST per
// marketing template, and 83% of replies came on the first message — so a lead gets ONE cold template,
// no template follow-ups. If they reply, the AI agent carries on (free inside the 24h window); if not,
// nothing more is sent. Used by the 12 pm follow-up job and the directory cadence.
async function coldTemplatesPerLead() {
  const n = Number.parseInt(await getSetting('WA_COLD_TEMPLATES_PER_LEAD'), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

async function coldTemplatesSent(leadId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM outreach_logs WHERE lead_id = $1 AND message_type = 'template'`,
    [leadId]
  );
  return r.rows[0].n;
}

module.exports = { whatsappOutreachOn, coldTemplatesPerLead, coldTemplatesSent };
