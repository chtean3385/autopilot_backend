const express = require('express');
const pool = require('../config/db');
const router = express.Router();

// List all groups with member count
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.*, COUNT(m.lead_id)::int as member_count
      FROM lead_groups g
      LEFT JOIN lead_group_members m ON g.id = m.group_id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create group
router.post('/', async (req, res) => {
  const { name, description } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO lead_groups (name, description) VALUES ($1, $2) RETURNING *',
      [name, description]
    );
    res.json({ success: true, group: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete group
router.delete('/:id', async (req, res) => {
  try {
    // Detach any campaigns referencing this group before deleting
    await pool.query('UPDATE campaigns SET group_id = NULL WHERE group_id = $1', [req.params.id]);
    await pool.query('DELETE FROM lead_group_members WHERE group_id = $1', [req.params.id]);
    await pool.query('DELETE FROM lead_groups WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get leads in a group
router.get('/:id/leads', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT hl.*, m.added_at as added_to_group_at
      FROM hotel_leads hl
      JOIN lead_group_members m ON hl.id = m.lead_id
      WHERE m.group_id = $1
      ORDER BY m.added_at DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add leads to group
router.post('/:id/leads', async (req, res) => {
  const { lead_ids } = req.body;
  const groupId = req.params.id;
  try {
    let added = 0;
    for (const leadId of lead_ids) {
      const r = await pool.query(
        'INSERT INTO lead_group_members (group_id, lead_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [groupId, leadId]
      );
      if (r.rowCount > 0) added++;
    }
    res.json({ success: true, added });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Remove lead from group
router.delete('/:id/leads/:leadId', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM lead_group_members WHERE group_id = $1 AND lead_id = $2',
      [req.params.id, req.params.leadId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
