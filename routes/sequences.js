const express = require('express');
const SequenceService = require('../services/sequenceService');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const sequences = await SequenceService.getAll();
    res.json(sequences);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const sequence = await SequenceService.getById(req.params.id);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    res.json(sequence);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!req.body.name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    const sequence = await SequenceService.create(req.body);
    res.json({ success: true, sequence });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const sequence = await SequenceService.update(req.params.id, req.body);
    if (!sequence) return res.status(404).json({ success: false, error: 'Sequence not found' });
    res.json({ success: true, sequence });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Enroll leads into this sequence — the email equivalent of launching a WhatsApp campaign.
router.post('/:id/enroll', async (req, res) => {
  const { leadIds } = req.body;
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return res.status(400).json({ success: false, error: 'leadIds is required' });
  }
  try {
    const result = await SequenceService.enrollLeads(req.params.id, leadIds);
    if (!result.success) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await SequenceService.delete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
