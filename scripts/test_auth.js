// Test for authenticator-app login (utils/totp.js + services/authService.js + routes/auth.js).
// No database: a tiny express app wired exactly like server.js (requireAuth on /api, public paths).
// Run: node scripts/test_auth.js
const path = require('path');
const B = path.join(__dirname, '..') + '/';
const express = require(B + 'node_modules/express');
const totp = require(B + 'utils/totp');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };

(async () => {
  // 1. RFC 6238 Appendix B (SHA1, secret "12345678901234567890"): T=59 → 94287082, T=1111111109 → 07081804
  const rfc = totp.base32Encode(Buffer.from('12345678901234567890'));
  check(totp.codeAt(rfc, Math.floor(59 / 30)) === '287082', 'RFC 6238 vector T=59 (last 6 digits)');
  check(totp.codeAt(rfc, Math.floor(1111111109 / 30)) === '081804', 'RFC 6238 vector T=1111111109 (last 6 digits)');
  check(totp.base32Decode(rfc).toString() === '12345678901234567890', 'base32 round trip');

  const secret = totp.generateSecret();
  check(/^[A-Z2-7]{32}$/.test(secret), 'generated secret is 32 base32 chars (160 bits)');
  const now = totp.counterNow();
  check(totp.verify(secret, totp.codeAt(secret, now)) === now, 'current code accepted');
  check(totp.verify(secret, totp.codeAt(secret, now - 1)) === now - 1, 'previous 30 s code accepted (clock drift)');
  check(totp.verify(secret, totp.codeAt(secret, now - 3)) === null, 'a 90 s old code is refused');
  check(totp.verify(secret, 'abcdef') === null && totp.verify(secret, '12345') === null, 'non-6-digit input refused');
  check(totp.otpauthUrl(secret).startsWith('otpauth://totp/Dreams%20CRM') && totp.otpauthUrl(secret).includes(`secret=${secret}`), 'otpauth link for the QR code');

  // 2. HTTP: wired like server.js
  process.env.TOTP_SECRET = secret;
  process.env.AUTH_SESSION_SECRET = 'test-session-secret-' + Date.now();
  delete process.env.AUTH_DISABLED;
  const Auth = require(B + 'services/authService');
  const app = express();
  app.use(express.json());
  app.post('/webhook', (req, res) => res.json({ ok: 'webhook' }));
  app.set('trust proxy', 'loopback');
  app.use('/api', Auth.requireAuth);
  app.use('/api/auth', require(B + 'routes/auth'));
  app.get('/api/leads', (req, res) => res.json({ leads: [] }));
  app.get('/api/settings', (req, res) => res.json({ secret: 'x' }));
  app.get('/api/templates/media/:id', (req, res) => res.send('img'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = 'GET', body, token } = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  check((await call('/api/leads')).status === 401, 'no login → /api/leads 401');
  check((await call('/api/settings')).status === 401, 'no login → /api/settings 401 (keys no longer readable)');
  check((await call('/api/templates/media/abc')).status === 200, 'template images stay public (Meta downloads them)');
  check((await call('/webhook', { method: 'POST' })).status === 200, 'WhatsApp webhook stays public');
  check((await call('/api/leads', { token: 'forged.token' })).status === 401, 'forged token refused');

  const wrong = String((Number(totp.codeAt(secret, now)) + 1) % 1000000).padStart(6, '0');
  check((await call('/api/auth/login', { method: 'POST', body: { code: wrong } })).status === 401, 'wrong code → 401');
  const good = await call('/api/auth/login', { method: 'POST', body: { code: totp.codeAt(secret, totp.counterNow()) } });
  check(good.status === 200 && good.body.token && good.body.expiresAt, 'right code → session token');
  check((await call('/api/leads', { token: good.body.token })).status === 200, 'with token → /api/leads 200');
  check((await call('/api/auth/me', { token: good.body.token })).status === 200, '/api/auth/me confirms the session');
  check((await call('/api/auth/login', { method: 'POST', body: { code: totp.codeAt(secret, totp.counterNow()) } })).status === 401, 'same code cannot be used twice');

  // expired token
  const realNow = Date.now;
  Date.now = () => realNow() + 8 * 86400000;
  check((await call('/api/leads', { token: good.body.token })).status === 401, 'token expires after 7 days');
  Date.now = realNow;

  // brute force lockout: 5 wrong codes per IP → 429, even for a right code
  Auth._reset();
  for (let i = 0; i < 5; i++) await call('/api/auth/login', { method: 'POST', body: { code: wrong } });
  check((await call('/api/auth/login', { method: 'POST', body: { code: totp.codeAt(secret, totp.counterNow()) } })).status === 429, '5 wrong codes → locked for 15 min (429)');

  // not configured → closed, not open
  Auth._reset();
  delete process.env.TOTP_SECRET;
  check((await call('/api/leads', { token: good.body.token })).status === 503, 'server without TOTP_SECRET stays closed (503), never open');

  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
