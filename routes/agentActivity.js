const express = require('express');
const pool = require('../config/db');
const router = express.Router();

// GET /api/agent-activity — cross-lead, cross-channel feed of everything the agent has done,
// newest first. Sourced from agent_actions, written by both the email pipeline
// (cold_email_scored, draft_sent, sequence_stopped, etc. — workers/sequenceEmailWorker.js,
// services/replyDeliveryService.js, services/replyQualityService.js, services/leadResearchService.js)
// and the WhatsApp pipeline (whatsapp_reply_sent, whatsapp_demo_qualified, whatsapp_reply_failed,
// etc. — services/salesAgentService.js, routes/webhook.js). hl.channel on each row tells the
// frontend which channel a given action belongs to.
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
    const { lead_id, action } = req.query;

    const conditions = [];
    const params = [];
    if (lead_id) { params.push(lead_id); conditions.push(`aa.lead_id = $${params.length}`); }
    if (action) { params.push(action); conditions.push(`aa.action = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit);
    const result = await pool.query(
      `SELECT aa.id, aa.lead_id, aa.action, aa.detail, aa.draft_text, aa.score, aa.decision, aa.created_at,
              hl.hotel_name, hl.city, hl.channel
       FROM agent_actions aa
       LEFT JOIN hotel_leads hl ON hl.id = aa.lead_id
       ${where}
       ORDER BY aa.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
