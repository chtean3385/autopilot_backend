const express = require('express');
const pool = require('../config/db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM portfolio_items ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk-add project links pasted in Settings: [{title, url, description, tags}]
router.post('/bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const valid = items.filter(it => it.title && it.title.trim());
    if (valid.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid items — each needs at least a title' });
    }

    const inserted = [];
    for (const it of valid) {
      const result = await pool.query(
        `INSERT INTO portfolio_items (title, url, description, tags) VALUES ($1, $2, $3, $4) RETURNING *`,
        [it.title.trim(), it.url || null, it.description || null, it.tags || null]
      );
      inserted.push(result.rows[0]);
    }
    res.json({ success: true, items: inserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM portfolio_items WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
