const express = require('express');
const AuthService = require('../services/authService');

const router = express.Router();

// POST /api/auth/login { code } → { token, expiresAt }. Public (see authService.PUBLIC_API).
router.post('/login', (req, res) => {
  const result = AuthService.login(req.body?.code, req.ip);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ token: result.token, expiresAt: result.expiresAt });
});

// GET /api/auth/me — behind requireAuth, so 200 simply means "this browser's login is still valid".
router.get('/me', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
