const express = require('express');
const pool = require('../config/db');
const { runTask, refineInstruction } = require('../services/schedulerService');
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

// Create task — GPT refines instruction, waits for user approval before running
router.post('/tasks', async (req, res) => {
  const { instruction, template_id, lead_count, schedule, custom_time } = req.body;
  if (!instruction?.trim()) return res.status(400).json({ error: 'Instruction is required' });

  try {
    const refined = await refineInstruction(instruction.trim());

    let runAt = new Date();
    if (schedule === 'custom' && custom_time) runAt = new Date(custom_time);

    const result = await pool.query(
      `INSERT INTO agent_tasks
         (instruction, refined_instruction, refinement_note, city, lead_count,
          template_id, status, run_at, parsed_params)
       VALUES ($1, $2, $3, $4, $5, $6, 'needs_approval', $7, $8)
       RETURNING *`,
      [
        instruction.trim(),
        refined.refinedInstruction,
        refined.refinementNote,
        refined.parsed?.city || null,
        lead_count || refined.parsed?.count || 20,
        template_id || null,
        runAt,
        JSON.stringify(refined.parsed),
      ]
    );

    res.json({ success: true, task: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User approves the refined instruction — run the task
router.post('/tasks/:id/approve', async (req, res) => {
  try {
    const taskResult = await pool.query('SELECT * FROM agent_tasks WHERE id=$1', [req.params.id]);
    const task = taskResult.rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'needs_approval') return res.status(400).json({ error: 'Task is not waiting for approval' });

    const updated = await pool.query(
      `UPDATE agent_tasks SET status='pending' WHERE id=$1 RETURNING *`,
      [task.id]
    );

    const readyTask = updated.rows[0];
    runTask(readyTask).catch(e => console.error('[Agent Route] runTask error:', e.message));

    res.json({ success: true, task: readyTask });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User edits and resubmits — GPT re-refines, waits for approval again
router.post('/tasks/:id/revise', async (req, res) => {
  const { instruction } = req.body;
  if (!instruction?.trim()) return res.status(400).json({ error: 'instruction is required' });

  try {
    const taskResult = await pool.query('SELECT * FROM agent_tasks WHERE id=$1', [req.params.id]);
    const task = taskResult.rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'needs_approval') return res.status(400).json({ error: 'Task is not in approval state' });

    const refined = await refineInstruction(instruction.trim());

    const updated = await pool.query(
      `UPDATE agent_tasks
       SET instruction=$1, refined_instruction=$2, refinement_note=$3,
           city=$4, parsed_params=$5
       WHERE id=$6
       RETURNING *`,
      [
        instruction.trim(),
        refined.refinedInstruction,
        refined.refinementNote,
        refined.parsed?.city || null,
        JSON.stringify(refined.parsed),
        task.id,
      ]
    );

    res.json({ success: true, task: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single task status
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

// Delete a task
router.delete('/tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM agent_tasks WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
