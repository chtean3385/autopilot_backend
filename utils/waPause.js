// Kill switch for every outbound WhatsApp message (templates, text, images). Added 2026-10-21 when
// the number's quality rating dropped and Meta began rejecting sends ("not delivered to maintain
// healthy ecosystem engagement") — further sends make it worse.
// Paused by default; set WHATSAPP_PAUSED=false in backend/.env (then pm2 restart) to resume.
function isWhatsappPaused() {
  return String(process.env.WHATSAPP_PAUSED || 'true').toLowerCase() !== 'false';
}

const PAUSED_RESULT = { success: false, paused: true, error: 'WHATSAPP_PAUSED: outbound WhatsApp is switched off' };

module.exports = { isWhatsappPaused, PAUSED_RESULT };
