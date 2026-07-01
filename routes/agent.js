const express = require('express');
const pool = require('../config/db');
const { runTask, parseInstruction } = require('../services/schedulerService');
const router = express.Router();

// List all tasks (newest first)
router.get('/tasks', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT at.*, t.template_name, c.campaign_name
      FROM agent_tasks at
      LEFT JOIN waba_templates t ON at.template_id = t.id
      LEFT JOIN campaigns c ON at.campaign_id = c.id
      ORDER BY at.created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new task
router.post('/tasks', async (req, res) => {
  const { instruction, template_id, lead_count, schedule, custom_time } = req.body;
  if (!instruction?.trim()) return res.status(400).json({ error: 'Instruction is required' });

  try {
    const parsed = await parseInstruction(instruction);

    let runAt = new Date();
    if (schedule === 'custom' && custom_time) {
      runAt = new Date(custom_time);
    }

    const result = await pool.query(
      `INSERT INTO agent_tasks (instruction, city, lead_count, template_id, status, run_at)
       VALUES ($1, $2, $3, $4, 'pending', $5) RETURNING *`,
      [instruction.trim(), parsed.city || null, lead_count || parsed.count || 20, template_id || null, runAt]
    );

    const task = result.rows[0];

    // If running now, kick off immediately in background
    if (schedule !== 'custom') {
      runTask(task).catch(e => console.error('[Agent Route] runTask error:', e.message));
    }

    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single task status (for polling)
router.get('/tasks/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT at.*, t.template_name, c.campaign_name
       FROM agent_tasks at
       LEFT JOIN waba_templates t ON at.template_id = t.id
       LEFT JOIN campaigns c ON at.campaign_id = c.id
       WHERE at.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a task (only pending/failed ones)
router.delete('/tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM agent_tasks WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
