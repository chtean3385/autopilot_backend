const express = require('express');
const pool = require('../config/db');
const { runTask, sendTask, refineInstruction } = require('../services/schedulerService');
const WABAService = require('../services/wabaService');
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
  const { instruction, template_id, lead_count, schedule, custom_time, filters } = req.body;
  if (!instruction?.trim()) return res.status(400).json({ error: 'Instruction is required' });

  try {
    const refined = await refineInstruction(instruction.trim());

    // Explicit UI filters always override what GPT parsed from text
    const parsedParams = {
      ...refined.parsed,
      filterHasWebsite: filters?.filterHasWebsite === true ? true : (refined.parsed?.filterHasWebsite || false),
      maxReviews: filters?.maxReviews || null,
    };

    let runAt = new Date();
    if (schedule === 'custom' && custom_time) runAt = new Date(custom_time);

    const result = await pool.query(
      `INSERT INTO agent_tasks
         (instruction, refined_instruction, refinement_note, city, lead_count,
          template_id, status, run_at, parsed_params, system_prompt)
       VALUES ($1, $2, $3, $4, $5, $6, 'needs_approval', $7, $8, $9)
       RETURNING *`,
      [
        instruction.trim(),
        refined.refinedInstruction,
        refined.refinementNote,
        parsedParams.city || null,
        lead_count || parsedParams.count || 20,
        template_id || null,
        runAt,
        JSON.stringify(parsedParams),
        refined.systemPrompt || null,
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
    // Fix 6: only fire immediately if the scheduled time has passed; otherwise let cron handle it
    // Fix 1: runTask uses a CAS update so even if cron fires first, only one wins
    if (new Date(readyTask.run_at) <= new Date()) {
      runTask(readyTask).catch(e => console.error('[Agent Route] runTask error:', e.message));
    }

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

// List leads captured for a preview-state task (for admin review before sending)
router.get('/tasks/:id/leads', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT hl.id, hl.hotel_name, hl.whatsapp_number, hl.phone, hl.city,
              hl.business_category, hl.email AS website, hl.status, hl.created_at
       FROM agent_tasks at
       JOIN campaigns c ON at.campaign_id = c.id
       JOIN lead_group_members lgm ON lgm.group_id = c.group_id
       JOIN hotel_leads hl ON lgm.lead_id = hl.id
       WHERE at.id = $1
       ORDER BY hl.created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a lead from the task's campaign group (so it won't receive messages)
router.delete('/tasks/:id/leads/:leadId', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM lead_group_members
       WHERE lead_id = $1
         AND group_id = (
           SELECT c.group_id FROM agent_tasks at
           JOIN campaigns c ON at.campaign_id = c.id
           WHERE at.id = $2
         )`,
      [req.params.leadId, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin triggers send after reviewing the lead list
// Optional body: { send_at: ISO datetime } — schedules for later instead of sending immediately
router.post('/tasks/:id/send', async (req, res) => {
  try {
    // Block if WABA quality is RED
    const health = await WABAService.getAccountHealth();
    if (health.success && health.quality_rating === 'RED') {
      return res.status(403).json({
        error: 'Send blocked: your WhatsApp number quality rating is RED. Fix quality issues in Meta Business Manager before sending messages.',
        quality_rating: 'RED',
        blocked: true,
      });
    }

    const { send_at } = req.body || {};
    if (send_at) {
      const sendTime = new Date(send_at);
      if (sendTime > new Date()) {
        await pool.query(
          `UPDATE agent_tasks SET status='scheduled_send', run_at=$1 WHERE id=$2`,
          [sendTime, req.params.id]
        );
        return res.json({ success: true, scheduled: true, send_at: sendTime });
      }
    }
    const sent = await sendTask(parseInt(req.params.id));
    res.json({ success: true, messages_sent: sent });
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
