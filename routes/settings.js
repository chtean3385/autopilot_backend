const express = require('express');
const { getAllSettings, setSetting, SETTINGS_DEFS } = require('../services/settingsService');
const router = express.Router();

// Get all settings (sensitive values masked)
router.get('/', async (req, res) => {
  try {
    const settings = await getAllSettings();
    const show = req.query.reveal === '1';
    const masked = settings.map(s => ({
      ...s,
      value: (s.sensitive && !show && s.value)
        ? s.value.slice(0, 8) + '••••••••'
        : s.value,
    }));
    res.json(masked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk update settings
router.put('/', async (req, res) => {
  try {
    const updates = req.body; // { KEY: value, ... }
    const allowed = new Set(SETTINGS_DEFS.map(d => d.key));
    for (const [key, value] of Object.entries(updates)) {
      if (!allowed.has(key)) continue;
      if (value === null || value === undefined) continue;
      await setSetting(key, String(value).trim());
    }
    const settings = await getAllSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
