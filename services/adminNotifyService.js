const WABAService = require('./wabaService');
const settingsService = require('./settingsService');

// WhatsApp-only admin ping — reuses the same OWNER_WHATSAPP setting (Settings → App)
// as the "qualified lead" alert in agentService.js, so no new config is needed.
async function notifyAdmin(text) {
  let ownerNumber = await settingsService.getSetting('OWNER_WHATSAPP');
  if (!ownerNumber) {
    console.log('[AdminNotify] OWNER_WHATSAPP not configured (Settings → App) — skipping notification');
    return;
  }
  ownerNumber = ownerNumber.replace(/\D/g, '');
  if (ownerNumber.length === 10) ownerNumber = '91' + ownerNumber;

  const result = await WABAService.sendTextMessage(ownerNumber, text);
  if (!result.success) console.error('[AdminNotify] Failed to send:', result.error);
}

module.exports = { notifyAdmin };
