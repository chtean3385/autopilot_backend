const crypto = require('crypto');

// Authenticator-app codes (TOTP, RFC 6238 — what Google Authenticator / Microsoft Authenticator / Authy
// show): HMAC-SHA1 over the 30-second time step, 6 digits. Built on Node's crypto so login has no
// third-party dependency.

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// 20 random bytes = the 160-bit key length RFC 4226 recommends.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const num = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(num % 10 ** DIGITS).padStart(DIGITS, '0');
}

const counterNow = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

// Returns the matching time-step counter, or null. window=1 accepts the previous and next 30 s code
// too (phone clocks drift). Constant-time compare.
function verify(secret, code, { window = 1, nowMs = Date.now() } = {}) {
  const given = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given) || !secret) return null;
  const now = counterNow(nowMs);
  for (let c = now - window; c <= now + window; c++) {
    const expected = codeAt(secret, c);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return c;
  }
  return null;
}

// The link an authenticator app reads from the QR code.
function otpauthUrl(secret, { issuer = 'Dreams CRM', account = 'bot.dreamstechnology.in' } = {}) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { generateSecret, verify, codeAt, counterNow, otpauthUrl, base32Decode, base32Encode };
