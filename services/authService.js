const crypto = require('crypto');
const totp = require('../utils/totp');

// CRM login (owner, 2026-10-08), checked here on the server — before this the "login" was a hardcoded
// user list checked in the browser and every /api route answered anyone, incl. /api/settings?reveal=1.
//
// Two modes, one at a time:
//   password  (until the authenticator is activated)  admin@admin.com / 12345678 — temporary, by owner's call
//   code      (after Settings → Login & Security → Activate authenticator, scan QR, confirm a code)
//             the 6-digit authenticator code is the ONLY login; email/password stop working.
//
// Stored in the `settings` table (keys are NOT in SETTINGS_DEFS, so /api/settings never lists them),
// so a deploy needs no .env change:
//   AUTH_TOTP_SECRET   active authenticator key; empty = password mode
//   AUTH_TOTP_PENDING  key shown as a QR, waiting for its first code before it becomes AUTH_TOTP_SECRET
//   AUTH_SESSION_KEY   signs session tokens (auto-created). Optional AUTH_SESSION_SECRET in .env is mixed in.
// .env: AUTH_SESSION_DAYS (default 7); AUTH_DISABLED=true on local/test servers only — never on the VPS.
// Lost the phone? On the server: node scripts/auth_reset.js && pm2 restart autoagent-backend
//
// Brute force: 5 failed logins per IP per 15 min, 20 in total per 15 min → 429 until the window passes.
// An authenticator code can be used once (replay of a just-seen code is refused).

const LOGIN_EMAIL = 'admin@admin.com';
const LOGIN_PASSWORD = '12345678';
const DEFAULT_SESSION_DAYS = 7;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_TOTAL = 20;

let store = require('./settingsService'); // { getSetting, setSetting } — swapped in tests
const failsByIp = new Map(); // ip → [timestamps]
let failsTotal = [];
let lastUsedCounter = -1;
let cachedSessionKey = null;

const isDisabled = () => String(process.env.AUTH_DISABLED || '').toLowerCase() === 'true';
const get = async (key) => (await store.getSetting(key)) || null;
const set = (key, value) => store.setSetting(key, value);

function sessionDays() {
  const n = Number.parseFloat(process.env.AUTH_SESSION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_DAYS;
}

// Constant-time string compare (hash first so lengths always match).
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// ── session tokens (stateless: payload.signature) ────────────────────────────
async function sessionKey() {
  if (!cachedSessionKey) {
    let key = await get('AUTH_SESSION_KEY');
    if (!key) {
      key = crypto.randomBytes(32).toString('hex');
      await set('AUTH_SESSION_KEY', key);
    }
    cachedSessionKey = key;
  }
  return (process.env.AUTH_SESSION_SECRET || '') + cachedSessionKey;
}

async function issueToken() {
  const exp = Date.now() + sessionDays() * 86400000;
  const payload = Buffer.from(JSON.stringify({ sub: 'owner', exp, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', await sessionKey()).update(payload).digest('base64url');
  return { token: `${payload}.${sig}`, expiresAt: new Date(exp).toISOString() };
}

async function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', await sessionKey()).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

// New key → every existing login (all browsers) ends.
async function rotateSessionKey() {
  cachedSessionKey = crypto.randomBytes(32).toString('hex');
  await set('AUTH_SESSION_KEY', cachedSessionKey);
}

// ── rate limiting ────────────────────────────────────────────────────────────
const recentFails = (list, now) => list.filter((t) => now - t < WINDOW_MS);

function lockedOut(ip, now = Date.now()) {
  failsTotal = recentFails(failsTotal, now);
  const mine = recentFails(failsByIp.get(ip) || [], now);
  failsByIp.set(ip, mine);
  return mine.length >= MAX_FAILS_PER_IP || failsTotal.length >= MAX_FAILS_TOTAL;
}

function recordFail(ip, now = Date.now()) {
  failsByIp.set(ip, [...recentFails(failsByIp.get(ip) || [], now), now]);
  failsTotal.push(now);
}

// A code is good once: the same 30 s code can't be replayed.
function useCode(secret, code) {
  const counter = totp.verify(secret, code);
  if (counter === null || counter <= lastUsedCounter) return false;
  lastUsedCounter = counter;
  return true;
}

// ── login ────────────────────────────────────────────────────────────────────
// Which login screen to show. Public.
async function mode() {
  return (await get('AUTH_TOTP_SECRET')) ? 'code' : 'password';
}

// password mode: { email, password }   code mode: { code }
// → { ok: true, token, expiresAt } | { ok: false, status, error, mode }
async function login({ email, password, code } = {}, ip = 'unknown') {
  if (lockedOut(ip)) return { ok: false, status: 429, error: 'Too many failed attempts. Wait 15 minutes and try again.' };
  const secret = await get('AUTH_TOTP_SECRET');
  if (secret) {
    if (!useCode(secret, code)) {
      recordFail(ip);
      return { ok: false, status: 401, mode: 'code', error: 'Wrong or already-used code. Check your authenticator app.' };
    }
  } else {
    const ok = safeEqual(String(email || '').trim().toLowerCase(), LOGIN_EMAIL) & safeEqual(String(password || ''), LOGIN_PASSWORD);
    if (!ok) {
      recordFail(ip);
      return { ok: false, status: 401, mode: 'password', error: 'Invalid email or password.' };
    }
  }
  failsByIp.delete(ip);
  return { ok: true, ...(await issueToken()) };
}

// ── Settings → Login & Security (behind requireAuth) ─────────────────────────
// Step 1: a new key shown as a QR. Nothing changes until it is confirmed.
async function startTwoFactor() {
  const secret = totp.generateSecret();
  await set('AUTH_TOTP_PENDING', secret);
  const otpauthUrl = totp.otpauthUrl(secret);
  const qr = await require('qrcode').toDataURL(otpauthUrl, { width: 240, margin: 1 });
  return { ok: true, secret, otpauthUrl, qr };
}

// Step 2: a code from the freshly scanned app proves the phone has the key → it becomes the only login.
// Every browser is logged out (including this one) so the next login uses the app.
async function confirmTwoFactor(code) {
  const pending = await get('AUTH_TOTP_PENDING');
  if (!pending) return { ok: false, status: 400, error: 'Press "Activate authenticator" first to get a QR code.' };
  if (!useCode(pending, code)) return { ok: false, status: 400, error: 'That code does not match. Scan the QR again or wait for the next code.' };
  await set('AUTH_TOTP_SECRET', pending);
  await set('AUTH_TOTP_PENDING', '');
  await rotateSessionKey();
  return { ok: true };
}

// Back to email + password login. Needs a current code from the app.
async function disableTwoFactor(code) {
  const secret = await get('AUTH_TOTP_SECRET');
  if (!secret) return { ok: true };
  if (!useCode(secret, code)) return { ok: false, status: 400, error: 'Enter a current code from the authenticator app.' };
  await set('AUTH_TOTP_SECRET', '');
  await rotateSessionKey();
  return { ok: true };
}

// ── middleware ───────────────────────────────────────────────────────────────
// Paths under /api that stay public: the login screen's two calls, and template header images (Meta
// downloads them when a template is submitted and when it is sent, without any login).
const PUBLIC_API = [/^\/auth\/login\/?$/, /^\/auth\/mode\/?$/, /^\/templates\/media\/[^/]+\/?$/];

// Express middleware for app.use('/api', requireAuth). req.path is relative to /api here.
async function requireAuth(req, res, next) {
  if (isDisabled() || req.method === 'OPTIONS' || PUBLIC_API.some((re) => re.test(req.path))) return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  try {
    if (!(await verifyToken(token))) return res.status(401).json({ error: 'Please log in again.' });
  } catch (err) {
    console.error('[auth] session check failed:', err.message);
    return res.status(503).json({ error: 'Login check failed on the server. Try again shortly.' });
  }
  return next();
}

// Test hooks.
function _reset() { failsByIp.clear(); failsTotal = []; lastUsedCounter = -1; cachedSessionKey = null; }
function _setStore(s) { store = s; _reset(); }

module.exports = {
  mode, login, startTwoFactor, confirmTwoFactor, disableTwoFactor,
  requireAuth, verifyToken, issueToken, isDisabled, PUBLIC_API, LOGIN_EMAIL, LOGIN_PASSWORD, _reset, _setStore,
};
