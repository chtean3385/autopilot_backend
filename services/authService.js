const crypto = require('crypto');
const totp = require('../utils/totp');

// Login for the CRM (owner, 2026-10-08): the only credential is the 6-digit code from an authenticator
// app — no email, no password. Before this, the "login" was a hardcoded user list checked in the browser
// and every /api route answered anyone on the internet, including /api/settings?reveal=1 (all keys).
//
//   TOTP_SECRET          base32 key shared with the authenticator app (set once on the server, .env only)
//   AUTH_SESSION_SECRET  HMAC key that signs session tokens; changing it logs every browser out
//   AUTH_SESSION_DAYS    how long a login lasts (default 7)
//   AUTH_DISABLED=true   local/test servers only (scripts/run_test_server.sh) — never on the VPS
//
// Sessions are stateless signed tokens (payload.signature), checked by requireAuth on every /api call.
// Brute force: 5 wrong codes per IP per 15 min, 20 in total per 15 min → 429 until the window passes.
// A code can be used once (replay of a just-seen code is refused).

const DEFAULT_SESSION_DAYS = 7;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_TOTAL = 20;

const failsByIp = new Map(); // ip → [timestamps]
let failsTotal = [];
let lastUsedCounter = -1;

const isDisabled = () => String(process.env.AUTH_DISABLED || '').toLowerCase() === 'true';
const isConfigured = () => Boolean(process.env.TOTP_SECRET && process.env.AUTH_SESSION_SECRET);

function sessionDays() {
  const n = Number.parseFloat(process.env.AUTH_SESSION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_DAYS;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', process.env.AUTH_SESSION_SECRET).update(data).digest('base64url');

function issueToken() {
  const exp = Date.now() + sessionDays() * 86400000;
  const payload = b64url(JSON.stringify({ sub: 'owner', exp, n: crypto.randomBytes(8).toString('hex') }));
  return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(exp).toISOString() };
}

function verifyToken(token) {
  if (!isConfigured() || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function recentFails(list, now) {
  return list.filter((t) => now - t < WINDOW_MS);
}

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

// → { ok: true, token, expiresAt } | { ok: false, status, error }
function login(code, ip = 'unknown') {
  if (!isConfigured()) return { ok: false, status: 503, error: 'Login is not set up on the server yet.' };
  if (lockedOut(ip)) return { ok: false, status: 429, error: 'Too many wrong codes. Wait 15 minutes and try again.' };
  const counter = totp.verify(process.env.TOTP_SECRET, code);
  if (counter === null || counter <= lastUsedCounter) {
    recordFail(ip);
    return { ok: false, status: 401, error: counter === null ? 'Wrong code. Check the code in your authenticator app.' : 'That code was already used. Wait for the next one.' };
  }
  lastUsedCounter = counter;
  failsByIp.delete(ip);
  return { ok: true, ...issueToken() };
}

// Paths under /api that stay public: the login itself, and template header images (Meta downloads
// them when a template is submitted and when it is sent, without any login).
const PUBLIC_API = [/^\/auth\/login\/?$/, /^\/templates\/media\/[^/]+\/?$/];

// Express middleware for app.use('/api', requireAuth). req.path is relative to /api here.
function requireAuth(req, res, next) {
  if (isDisabled()) return next();
  if (req.method === 'OPTIONS') return next();
  if (PUBLIC_API.some((re) => re.test(req.path))) return next();
  if (!isConfigured()) return res.status(503).json({ error: 'Login is not set up on the server yet.' });
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!verifyToken(token)) return res.status(401).json({ error: 'Please log in again.' });
  return next();
}

// Test hook: reset the in-memory counters.
function _reset() { failsByIp.clear(); failsTotal = []; lastUsedCounter = -1; }

module.exports = { login, requireAuth, verifyToken, issueToken, isConfigured, isDisabled, _reset, PUBLIC_API };
