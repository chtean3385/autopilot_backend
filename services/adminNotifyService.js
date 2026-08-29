const { alertOwner } = require('./ownerAlertService');

// WhatsApp-only admin ping. Routes through ownerAlertService so it goes out as an approved
// template (delivers any time) instead of a free-text message that Meta drops unless the
// owner happens to be inside a 24h window — the reason these never arrived for months.
async function notifyAdmin(text) {
  const firstLine = String(text || '').split('\n').find(l => l.trim()) || 'Dreams CRM update';
  await alertOwner(firstLine.replace(/[*_`>#]/g, '').slice(0, 60), text);
}

module.exports = { notifyAdmin };
