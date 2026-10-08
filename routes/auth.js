const express = require('express');
const AuthService = require('../services/authService');

const router = express.Router();

const send = (res, result) => {
  const { ok, status, ...body } = result;
  return ok ? res.json(body) : res.status(status || 400).json(body);
};
const wrap = (fn) => async (req, res) => {
  try { send(res, await fn(req)); } catch (err) {
    console.error('[auth]', err.message);
    res.status(500).json({ error: 'Server error. Try again.' });
  }
};

// Public (see authService.PUBLIC_API):
// GET  /api/auth/mode  → { mode: 'password' | 'code' } — which login screen to show
// POST /api/auth/login { email, password } or { code } → { token, expiresAt } | 401 { error, mode }
router.get('/mode', wrap(async () => ({ ok: true, mode: await AuthService.mode() })));
router.post('/login', wrap((req) => AuthService.login(req.body || {}, req.ip)));

// Behind requireAuth. /me: 200 means "this login is still valid".
router.get('/me', wrap(async () => ({ ok: true, mode: await AuthService.mode() })));

// Settings → Login & Security
router.post('/2fa/start', wrap(() => AuthService.startTwoFactor()));
router.post('/2fa/confirm', wrap((req) => AuthService.confirmTwoFactor(req.body?.code)));
router.post('/2fa/disable', wrap((req) => AuthService.disableTwoFactor(req.body?.code)));

module.exports = router;
