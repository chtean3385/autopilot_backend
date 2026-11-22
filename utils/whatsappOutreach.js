const { getSetting } = require('../services/settingsService');

// WHATSAPP_OUTREACH_ENABLED (Settings, default on). Owner 2026-11-22: "false" stops ALL WhatsApp we start
// ourselves: directory cadence templates, 12 pm follow-ups, campaigns, agent-task sends, Dream Stay
// pipeline touches, redirect-contact templates. NOT affected: AI/staff replies to someone who messaged
// us first (free text inside the 24h window) and owner alerts (owner_alert template).
// Each job checks this and skips quietly (no lead is marked failed); WABAService.sendPersonalizedTemplate
// (the one function every cold template goes through) refuses as a backstop.
async function whatsappOutreachOn() {
  return String((await getSetting('WHATSAPP_OUTREACH_ENABLED')) ?? '').trim().toLowerCase() !== 'false';
}

module.exports = { whatsappOutreachOn };
