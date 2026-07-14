const express = require('express');
const EmailSenderService = require('../services/emailSenderService');
const router = express.Router();

function mask(sender, reveal) {
  if (reveal) return sender;
  const masked = { ...sender };
  if (masked.api_key) masked.api_key = masked.api_key.slice(0, 6) + '••••••••';
  if (masked.smtp_config && masked.smtp_config.pass) {
    masked.smtp_config = { ...masked.smtp_config, pass: '••••••••' };
  }
  if (masked.imap_config && masked.imap_config.pass) {
    masked.imap_config = { ...masked.imap_config, pass: '••••••••' };
  }
  return masked;
}

// List all senders (sensitive fields masked unless ?reveal=1), with computed warmup info
router.get('/', async (req, res) => {
  try {
    const reveal = req.query.reveal === '1';
    const senders = await EmailSenderService.getAll();
    const withWarmup = senders.map(s => ({
      ...mask(s, reveal),
      effective_daily_cap: EmailSenderService.effectiveDailyCap(s),
    }));
    res.json(withWarmup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!req.body.from_email) {
      return res.status(400).json({ success: false, error: 'from_email is required' });
    }
    const sender = await EmailSenderService.create(req.body);
    res.json({ success: true, sender });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const sender = await EmailSenderService.update(req.params.id, req.body);
    if (!sender) return res.status(404).json({ success: false, error: 'Sender not found' });
    res.json({ success: true, sender });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/pause', async (req, res) => {
  try {
    const sender = await EmailSenderService.pause(req.params.id);
    if (!sender) return res.status(404).json({ success: false, error: 'Sender not found' });
    res.json({ success: true, sender });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/activate', async (req, res) => {
  try {
    const sender = await EmailSenderService.activate(req.params.id);
    if (!sender) return res.status(404).json({ success: false, error: 'Sender not found' });
    res.json({ success: true, sender });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await EmailSenderService.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send a test email through this sender to verify credentials/config
router.post('/:id/test-send', async (req, res) => {
  try {
    const sender = await EmailSenderService.getById(req.params.id);
    if (!sender) return res.status(404).json({ success: false, error: 'Sender not found' });
    const to = req.body.to || sender.from_email;
    const result = await EmailSenderService.send(sender, {
      to,
      subject: 'Test email from ' + (sender.label || sender.from_email),
      html: '<p>This is a test email to verify your email sender configuration.</p>',
      text: 'This is a test email to verify your email sender configuration.',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
