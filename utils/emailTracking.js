const crypto = require('crypto');
const { getBackendUrl } = require('./backendUrlConfig');

// Self-hosted open/click tracking — complements the Brevo webhook (which only covers
// Brevo-provider sends; SMTP senders were blind before this). Every outbound email gets a
// random tracking_token stored on its email_logs row; the rendered HTML carries a 1x1 pixel
// (open) and rewritten links (click) pointing at routes/tracking.js, which stamps
// opened_at/clicked_at via COALESCE — so whichever source fires first (pixel or Brevo
// webhook) wins and the other is a no-op.

// Same env fallback as suppressionService.js — one secret for all signed public URLs.
const SIG_SECRET = process.env.UNSUBSCRIBE_SECRET || 'dreams_unsubscribe_secret_2024';

function generateTrackingToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Click URLs are HMAC-signed over (token, destination) so /t/c/:token can't be abused as an
// open redirect — a forged or tampered destination fails verification and 404s.
function signClickTarget(token, url) {
  return crypto.createHmac('sha256', SIG_SECRET).update(`${token}|${url}`).digest('hex').slice(0, 32);
}

function verifyClickTarget(token, url, sig) {
  const sigBuf = Buffer.from(String(sig || ''));
  const expBuf = Buffer.from(signClickTarget(token, url));
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

function buildPixelUrl(token) {
  return `${getBackendUrl()}/t/o/${token}`;
}

function buildClickUrl(token, url) {
  return `${getBackendUrl()}/t/c/${token}?u=${encodeURIComponent(url)}&s=${signClickTarget(token, url)}`;
}

module.exports = { generateTrackingToken, buildPixelUrl, buildClickUrl, verifyClickTarget };
