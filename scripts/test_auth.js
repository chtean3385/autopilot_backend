// Test for CRM login (utils/totp.js + services/authService.js + routes/auth.js): email+password until the
// authenticator is activated in Settings, then the authenticator code only.
// No database: settings live in an in-memory store; a tiny express app wired exactly like server.js.
// Run: node scripts/test_auth.js
const path = require('path');
const B = path.join(__dirname, '..') + '/';
const express = require(B + 'node_modules/express');
const totp = require(B + 'utils/totp');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };

(async () => {
  // 1. TOTP — RFC 6238 Appendix B (SHA1, secret "12345678901234567890")
  const rfc = totp.base32Encode(Buffer.from('12345678901234567890'));
  check(totp.codeAt(rfc, Math.floor(59 / 30)) === '287082', 'RFC 6238 vector T=59 (last 6 digits)');
  check(totp.codeAt(rfc, Math.floor(1111111109 / 30)) === '081804', 'RFC 6238 vector T=1111111109 (last 6 digits)');
  const s0 = totp.generateSecret();
  const now = totp.counterNow();
  check(totp.verify(s0, totp.codeAt(s0, now)) === now, 'current code accepted');
  check(totp.verify(s0, totp.codeAt(s0, now - 3)) === null, 'a 90 s old code is refused');

  // 2. HTTP, wired like server.js, with an in-memory settings table
  delete process.env.AUTH_DISABLED;
  delete process.env.AUTH_SESSION_SECRET;
  const db = new Map();
  const Auth = require(B + 'services/authService');
  Auth._setStore({ getSetting: async (k) => db.get(k) || null, setSetting: async (k, v) => { db.set(k, v); } });
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
  const post = (p, body, token) => call(p, { method: 'POST', body, token });
  const nextCode = async (secret) => { // codes are single-use: wait for a fresh 30 s window if needed
    const c = totp.counterNow();
    return totp.codeAt(secret, c);
  };

  // Locked down
  check((await call('/api/leads')).status === 401, 'no login → /api/leads 401');
  check((await call('/api/settings')).status === 401, 'no login → /api/settings 401 (keys not readable)');
  check((await call('/api/templates/media/abc')).status === 200, 'template images stay public (Meta downloads them)');
  check((await post('/webhook')).status === 200, 'WhatsApp webhook stays public');
  check((await call('/api/leads', { token: 'forged.token' })).status === 401, 'forged token refused');
  check((await post('/api/auth/2fa/start')).status === 401, 'cannot start authenticator setup without login');

  // Password mode (fresh deploy, nothing in the DB)
  check((await call('/api/auth/mode')).body.mode === 'password', 'fresh server → password login screen');
  check((await post('/api/auth/login', { email: 'admin@admin.com', password: 'wrong' })).status === 401, 'wrong password → 401');
  check((await post('/api/auth/login', { email: 'admin@admin.com', password: '123456' })).status === 401, 'old browser-only password 123456 no longer works');
  const pw = await post('/api/auth/login', { email: ' Admin@Admin.com ', password: '12345678' });
  check(pw.status === 200 && pw.body.token, 'admin@admin.com / 12345678 → session token');
  const t1 = pw.body.token;
  check((await call('/api/leads', { token: t1 })).status === 200, 'with token → /api/leads 200');
  check((await call('/api/auth/me', { token: t1 })).body.mode === 'password', '/api/auth/me reports password mode');
  check(/^[0-9a-f]{64}$/.test(db.get('AUTH_SESSION_KEY') || ''), 'session key auto-created and stored in settings');

  // Activate the authenticator from Settings
  check((await post('/api/auth/2fa/confirm', { code: '123456' }, t1)).status === 400, 'confirm before start → 400');
  const st = await post('/api/auth/2fa/start', {}, t1);
  check(st.status === 200 && /^[A-Z2-7]{32}$/.test(st.body.secret) && st.body.qr?.startsWith('data:image/png;base64,') && st.body.otpauthUrl?.includes(st.body.secret), 'start → QR image + key');
  check((await call('/api/auth/mode')).body.mode === 'password', 'QR shown but not confirmed → still password login');
  const secret = st.body.secret;
  const bad = String((Number(totp.codeAt(secret, totp.counterNow())) + 1) % 1000000).padStart(6, '0');
  check((await post('/api/auth/2fa/confirm', { code: bad }, t1)).status === 400, 'wrong confirm code → 400, not activated');
  check((await call('/api/auth/mode')).body.mode === 'password', '…still password login');
  const conf = await post('/api/auth/2fa/confirm', { code: await nextCode(secret) }, t1);
  check(conf.status === 200, 'right code → authenticator activated');
  check((await call('/api/auth/mode')).body.mode === 'code', 'login screen now asks for the code only');
  check((await call('/api/leads', { token: t1 })).status === 401, 'activation logs out the existing session');

  // Code-only mode
  check((await post('/api/auth/login', { email: 'admin@admin.com', password: '12345678' })).status === 401, 'email + password no longer log in');
  Auth._reset(); Auth._setStore({ getSetting: async (k) => db.get(k) || null, setSetting: async (k, v) => { db.set(k, v); } }); // clear rate-limit + replay memory
  const reused = await post('/api/auth/login', { code: totp.codeAt(secret, totp.counterNow()) });
  // (after _reset the replay memory is clear, so the same 30 s code is accepted once)
  check(reused.status === 200 && reused.body.token, 'authenticator code → session token');
  const t2 = reused.body.token;
  check((await call('/api/leads', { token: t2 })).status === 200, 'with token → /api/leads 200');
  check((await post('/api/auth/login', { code: totp.codeAt(secret, totp.counterNow()) })).status === 401, 'same code cannot be used twice');

  // Turning it off needs a current code
  check((await post('/api/auth/2fa/disable', { code: '000000' }, t2)).status === 400, 'disable with a wrong code → 400');
  check((await call('/api/auth/mode')).body.mode === 'code', '…still code login');

  // Expiry + lockout
  const realNow = Date.now;
  Date.now = () => realNow() + 8 * 86400000;
  check((await call('/api/leads', { token: t2 })).status === 401, 'token expires after 7 days');
  Date.now = realNow;
  for (let i = 0; i < 5; i++) await post('/api/auth/login', { code: '000000' });
  check((await post('/api/auth/login', { code: totp.codeAt(secret, totp.counterNow() + 1) })).status === 429, '5 failed logins → locked for 15 min (429)');

  // Reset script path: authenticator key removed → back to password
  Auth._reset(); db.delete('AUTH_TOTP_SECRET');
  check((await call('/api/auth/mode')).body.mode === 'password', 'after auth_reset.js → password login again');

  // AUTH_DISABLED (test servers)
  process.env.AUTH_DISABLED = 'true';
  check((await call('/api/leads')).status === 200, 'AUTH_DISABLED=true → open (test server only)');
  delete process.env.AUTH_DISABLED;

  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
