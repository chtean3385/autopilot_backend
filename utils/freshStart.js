const { getSetting } = require('../services/settingsService');

// EMAIL_FRESH_START_AT (ISO time, UTC): email history before this moment is ignored by the cold-email
// writer (prior-email context), threading headers, the cadence "is this the first email?" count, and the
// email analytics. Set 2026-11-22: every SMTP email from 2026-10-07 to 2026-11-22 was silently dropped
// (EHLO [127.0.0.1], see emailSenderService.js), so those leads restart from email 1 and must not get
// "following up on my last email" about mail they never received. Blank = no cutoff (all history counts).
async function getFreshStartAt() {
  const raw = String((await getSetting('EMAIL_FRESH_START_AT')) || '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// EMAIL_ALLOW_NO_WEBSITE=true (owner 2026-11-22): a lead with nothing to research (no website and a
// free-mail address) may still get a cold email, written from its directory/CRM info (name, trade,
// city) by the composer's no-research branch. A lead whose website research FAILED is still not emailed.
async function allowNoWebsiteEmail() {
  return String((await getSetting('EMAIL_ALLOW_NO_WEBSITE')) || '').trim().toLowerCase() === 'true';
}

module.exports = { getFreshStartAt, allowNoWebsiteEmail };
