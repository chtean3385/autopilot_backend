const express = require('express');
const SuppressionService = require('../services/suppressionService');
const router = express.Router();

function resolveEmail(req) {
  const source = req.method === 'GET' ? req.query : { ...req.query, ...req.body };
  if (source.token) return SuppressionService.verifyToken(source.token);
  if (source.email) return String(source.email).toLowerCase().trim();
  return null;
}

function confirmationPage(message) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribe</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222}</style>
</head><body><h2>${message}</h2></body></html>`;
}

// Public, no auth — link clicked directly from an email client
router.get('/', async (req, res) => {
  const email = resolveEmail(req);
  if (!email) {
    return res.status(400).send(confirmationPage('Invalid or missing unsubscribe link.'));
  }
  try {
    await SuppressionService.addToSuppression(email, req.query.reason || 'unsubscribed');
    res.send(confirmationPage(`${email} has been unsubscribed and will not receive further emails.`));
  } catch (err) {
    res.status(500).send(confirmationPage('Something went wrong processing your request.'));
  }
});

// Public, no auth — for unsubscribe forms / programmatic calls
router.post('/', async (req, res) => {
  const email = resolveEmail(req);
  if (!email) {
    return res.status(400).json({ success: false, error: 'token or email is required' });
  }
  try {
    await SuppressionService.addToSuppression(email, req.body.reason || 'unsubscribed');
    res.json({ success: true, email, message: `${email} has been unsubscribed.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
