const express = require('express');
const pool = require('../config/db');
const { runTask, sendTask, refineInstruction, refineEmailInstruction, runEmailTask, runFollowUps } = require('../services/schedulerService');
const { runSequenceWorker } = require('../workers/sequenceEmailWorker');
const SchedulerStatusService = require('../services/schedulerStatusService');
const WABAService = require('../services/wabaService');
const agentService = require('../services/agentService');
const router = express.Router();

// Leads whose most recent inbound WhatsApp message never got an agent reply — the population
// stuck by the getKnowledge() json=json crash (services/salesAgentService.js) that swallowed
// every handleReply attempt silently in webhook.js's .catch(). A lead only stays a candidate
// while no 'reply' outreach_log exists after their last inbound message, so this is naturally
// safe to re-run: once a lead gets a real reply, they drop out on their own.
async function findStuckReplyCandidates() {
  const result = await pool.query(`
    SELECT DISTINCT ON (ol.lead_id) hl.*, ol.response_text, ol.response_received_at
    FROM outreach_logs ol
    JOIN hotel_leads hl ON hl.id = ol.lead_id
    WHERE ol.response_received = true
      AND ol.response_text IS NOT NULL
      AND hl.whatsapp_number IS NOT NULL
      AND hl.status NOT IN ('opted_out')
      AND hl.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM outreach_logs r
        WHERE r.lead_id = ol.lead_id
          AND r.message_type = 'reply'
          AND r.sent_at > ol.response_received_at
      )
    ORDER BY ol.lead_id, ol.response_received_at DESC
  `);
  return result.rows;
}

// Preview only — no messages sent. Call this first to see who would be contacted.
router.get('/backfill-stuck-replies', async (req, res) => {
  try {
    const candidates = await findStuckReplyCandidates();
    res.json({
      dry_run: true,
      count: candidates.length,
      leads: candidates.map(c => ({
        lead_id: c.id, hotel_name: c.hotel_name, whatsapp_number: c.whatsapp_number,
        their_message: c.response_text, received_at: c.response_received_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Actually sends. Requires ?confirm=true — this messages real customers on WhatsApp.
// Capped at a small batch per call (default 15, max 20) rather than draining the whole
// backlog at once — the WABA number is already at YELLOW quality, so a single burst of
// however many hundreds of leads piled up during the outage is exactly the kind of spike
// that risks tipping it to RED. Call this repeatedly (e.g. once every 15-30 min) to work
// through the backlog gradually; candidates who've already been answered drop out on
// their own, so re-running is always safe.
const MAX_BACKFILL_BATCH = 20;
router.post('/backfill-stuck-replies', async (req, res) => {
  if (req.query.confirm !== 'true') {
    return res.status(400).json({
      error: 'This sends real WhatsApp messages to real customers. GET this same path first to preview, then re-POST with ?confirm=true.',
    });
  }
  const batchSize = Math.min(parseInt(req.query.limit, 10) || 15, MAX_BACKFILL_BATCH);
  try {
    const allCandidates = await findStuckReplyCandidates();
    const candidates = allCandidates.slice(0, batchSize);
    const results = [];
    for (const lead of candidates) {
      try {
        await agentService.handleReply(lead, lead.response_text);
        results.push({ lead_id: lead.id, hotel_name: lead.hotel_name, status: 'sent' });
      } catch (err) {
        results.push({ lead_id: lead.id, hotel_name: lead.hotel_name, status: 'failed', error: err.message });
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    res.json({
      remaining_after_this_batch: allCandidates.length - candidates.length,
      total: candidates.length,
      sent: results.filter(r => r.status === 'sent').length,
      failed: results.filter(r => r.status === 'failed').length,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger the daily WhatsApp follow-up job (catch-up if the cron tick was
// missed — e.g. Render was asleep at the scheduled time and never woke for it).
router.post('/run-followups', async (req, res) => {
  try {
    const stats = await runFollowUps('manual');
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger the email sequence worker (same catch-up rationale as above).
router.post('/run-sequences', async (req, res) => {
  try {
    const stats = await runSequenceWorker('manual');
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Last-run status for each background job, so the UI can show "last ran: X"
// instead of relying on Render logs to prove a scheduled run actually fired.
router.get('/scheduler-status', async (req, res) => {
  try {
    const rows = await SchedulerStatusService.getAllStatus();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all tasks (newest first)
router.get('/tasks', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT at.*, t.template_name, c.campaign_name, s.name AS sequence_name
      FROM agent_tasks at
      LEFT JOIN waba_templates t ON at.template_id = t.id
      LEFT JOIN campaigns c ON at.campaign_id = c.id
      LEFT JOIN sequences s ON at.sequence_id = s.id
      ORDER BY at.created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create task(s) — GPT refines the instruction, waits for user approval before running.
// One instruction can expand into several tasks (a state/country name, or several cities named
// in one line) — refineInstruction/refineEmailInstruction return one entry per city, and each
// gets its own agent_tasks row (its own approval card, independently editable/deletable/runnable).
// channel='email' requires sequence_id (auto-enrolled into it once leads are found+verified).
router.post('/tasks', async (req, res) => {
  const { instruction, template_id, lead_count, schedule, custom_time, filters, channel, sequence_id } = req.body;
  if (!instruction?.trim()) return res.status(400).json({ error: 'Instruction is required' });
  if (channel === 'email' && !sequence_id) {
    return res.status(400).json({ error: 'sequence_id is required for email tasks' });
  }

  try {
    const refined = channel === 'email'
      ? await refineEmailInstruction(instruction.trim())
      : await refineInstruction(instruction.trim());

    let runAt = new Date();
    if (schedule === 'custom' && custom_time) runAt = new Date(custom_time);

    const tasks = [];
    for (const t of refined.tasks) {
      // Explicit UI filters always override what GPT parsed from text (WhatsApp only)
      const parsedParams = channel === 'email'
        ? { businessType: t.businessType, city: t.city, count: t.count, directUrls: t.directUrls }
        : {
            businessType: t.businessType,
            city: t.city,
            count: t.count,
            filterHasWebsite: filters?.filterHasWebsite === true ? true : (t.filterHasWebsite || false),
            maxReviews: filters?.maxReviews || null,
          };

      const result = await pool.query(
        `INSERT INTO agent_tasks
           (instruction, refined_instruction, refinement_note, city, lead_count,
            template_id, status, run_at, parsed_params, system_prompt, channel, sequence_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'needs_approval', $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          instruction.trim(),
          t.refinedInstruction,
          refined.refinementNote,
          parsedParams.city || null,
          lead_count || parsedParams.count || 20,
          template_id || null,
          runAt,
          JSON.stringify(parsedParams),
          refined.systemPrompt || null,
          channel === 'email' ? 'email' : 'whatsapp',
          channel === 'email' ? sequence_id : null,
        ]
      );
      tasks.push(result.rows[0]);
    }

    res.json({ success: true, tasks, task: tasks[0] });
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
    // Fix 1: runTask/runEmailTask uses a CAS update so even if cron fires first, only one wins
    if (new Date(readyTask.run_at) <= new Date()) {
      if (readyTask.channel === 'email') {
        runEmailTask(readyTask).catch(e => console.error('[Agent Route] runEmailTask error:', e.message));
      } else {
        runTask(readyTask).catch(e => console.error('[Agent Route] runTask error:', e.message));
      }
    }

    res.json({ success: true, task: readyTask });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User edits and resubmits — GPT re-refines, waits for approval again.
// If the edited text now expands to multiple cities (e.g. changed to name a state), this row
// keeps the first city and sibling needs_approval rows are created for the rest — same pattern
// as a fresh multi-city submission in POST /tasks.
router.post('/tasks/:id/revise', async (req, res) => {
  const { instruction } = req.body;
  if (!instruction?.trim()) return res.status(400).json({ error: 'instruction is required' });

  try {
    const taskResult = await pool.query('SELECT * FROM agent_tasks WHERE id=$1', [req.params.id]);
    const task = taskResult.rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'needs_approval') return res.status(400).json({ error: 'Task is not in approval state' });

    const refined = task.channel === 'email'
      ? await refineEmailInstruction(instruction.trim())
      : await refineInstruction(instruction.trim());

    const toParsedParams = (t) => task.channel === 'email'
      ? { businessType: t.businessType, city: t.city, count: t.count, directUrls: t.directUrls }
      : { businessType: t.businessType, city: t.city, count: t.count, filterHasWebsite: t.filterHasWebsite, maxReviews: null };

    const [first, ...rest] = refined.tasks;
    const updated = await pool.query(
      `UPDATE agent_tasks
       SET instruction=$1, refined_instruction=$2, refinement_note=$3,
           city=$4, parsed_params=$5
       WHERE id=$6
       RETURNING *`,
      [
        instruction.trim(),
        first.refinedInstruction,
        refined.refinementNote,
        first.city || null,
        JSON.stringify(toParsedParams(first)),
        task.id,
      ]
    );

    for (const t of rest) {
      await pool.query(
        `INSERT INTO agent_tasks
           (instruction, refined_instruction, refinement_note, city, lead_count,
            template_id, status, run_at, parsed_params, system_prompt, channel, sequence_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'needs_approval', $7, $8, $9, $10, $11)`,
        [
          instruction.trim(),
          t.refinedInstruction,
          refined.refinementNote,
          t.city || null,
          t.count || 20,
          task.template_id,
          task.run_at,
          JSON.stringify(toParsedParams(t)),
          task.system_prompt,
          task.channel,
          task.sequence_id,
        ]
      );
    }

    res.json({ success: true, task: updated.rows[0], additionalTasksCreated: rest.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single task status
router.get('/tasks/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT at.*, t.template_name, c.campaign_name, s.name AS sequence_name
       FROM agent_tasks at
       LEFT JOIN waba_templates t ON at.template_id = t.id
       LEFT JOIN campaigns c ON at.campaign_id = c.id
       LEFT JOIN sequences s ON at.sequence_id = s.id
       WHERE at.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List leads captured by a task — for WhatsApp's preview-state admin review before sending,
// or (for email tasks, which auto-enroll) just to see what a completed task actually found.
// WhatsApp tasks reach their group via campaigns.group_id; email tasks store group_id directly.
// Note: WhatsApp-channel leads repurpose the `email` column to hold the scraped website (legacy
// behavior in scrapeLeads/saveLeads) — COALESCE keeps that working via `website` while
// `contact_email` exposes the real address for email-channel leads without conflating the two.
// lead_research columns are only ever populated for email-channel leads (sequenceEmailWorker
// researches+caches them on first contact) — LEFT JOIN so WhatsApp-task rows just come back null.
router.get('/tasks/:id/leads', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT hl.id, hl.hotel_name, hl.whatsapp_number, hl.phone, hl.city, hl.channel,
              hl.business_category, COALESCE(NULLIF(hl.website, ''), hl.email) AS website,
              hl.email AS contact_email, hl.email_status, hl.status, hl.created_at,
              lr.pain_points, lr.recommended_services, lr.confidence,
              lr.company, lr.summary, lr.confidence_breakdown
       FROM agent_tasks at
       LEFT JOIN campaigns c ON at.campaign_id = c.id
       JOIN lead_group_members lgm ON lgm.group_id = COALESCE(c.group_id, at.group_id)
       JOIN hotel_leads hl ON lgm.lead_id = hl.id
       LEFT JOIN lead_research lr ON lr.lead_id = hl.id
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
