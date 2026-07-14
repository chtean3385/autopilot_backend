const express = require('express');
const pool = require('../config/db');

const router = express.Router();
const SCORE_MATCH_WINDOW_MS = 5 * 60 * 1000; // agent_actions and email_logs are written moments apart

// Best-effort match of each sent message to the agent_actions row that scored it (no FK between
// the two tables — they're joined by lead_id + how close in time they were written).
function attachScores(messages, scoredActions) {
  const used = new Set();
  for (const msg of messages) {
    if (msg.direction !== 'outgoing' || !msg.timestamp) continue;
    const msgTime = new Date(msg.timestamp).getTime();
    let best = null;
    let bestDiff = Infinity;
    for (let i = 0; i < scoredActions.length; i++) {
      if (used.has(i)) continue;
      const diff = Math.abs(new Date(scoredActions[i].created_at).getTime() - msgTime);
      if (diff <= SCORE_MATCH_WINDOW_MS && diff < bestDiff) {
        best = i;
        bestDiff = diff;
      }
    }
    if (best !== null) {
      used.add(best);
      msg.score = scoredActions[best].score;
      msg.decision = scoredActions[best].decision;
    }
  }
  return messages;
}

// GET /api/email-conversations — one row per lead with at least one email, newest first
router.get('/', async (req, res) => {
  try {
    const conversations = await pool.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (el.lead_id)
          el.lead_id, el.direction, el.subject, el.body,
          COALESCE(el.sent_at, el.created_at) AS last_at,
          hl.hotel_name, hl.email, hl.city, hl.email_status
        FROM email_logs el
        JOIN hotel_leads hl ON hl.id = el.lead_id
        ORDER BY el.lead_id, COALESCE(el.sent_at, el.created_at) DESC
      ) sub
      ORDER BY last_at DESC
    `);

    const leadIds = conversations.rows.map(r => r.lead_id);
    let statusByLead = {};
    if (leadIds.length > 0) {
      const seqRes = await pool.query(`
        SELECT DISTINCT ON (lead_id) lead_id, status
        FROM lead_sequences
        WHERE lead_id = ANY($1)
        ORDER BY lead_id, updated_at DESC
      `, [leadIds]);
      statusByLead = Object.fromEntries(seqRes.rows.map(r => [r.lead_id, r.status]));
    }

    res.json(conversations.rows.map(row => ({ ...row, sequence_status: statusByLead[row.lead_id] || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/email-conversations/thread/:leadId — full thread + agent scores + sequence status
router.get('/thread/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;

    const [leadRes, logsRes, seqRes, scoredActionsRes] = await Promise.all([
      pool.query('SELECT * FROM hotel_leads WHERE id = $1', [leadId]),
      pool.query(
        `SELECT * FROM email_logs WHERE lead_id = $1 ORDER BY COALESCE(sent_at, created_at) ASC`,
        [leadId]
      ),
      pool.query(
        `SELECT * FROM lead_sequences WHERE lead_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        [leadId]
      ),
      pool.query(
        `SELECT created_at, score, decision FROM agent_actions
         WHERE lead_id = $1 AND action IN ('draft_sent', 'portfolio_sent', 'estimate_sent') AND score IS NOT NULL
         ORDER BY created_at ASC`,
        [leadId]
      ),
    ]);

    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const messages = logsRes.rows.map(log => ({
      id: log.id,
      direction: log.direction === 'out' ? 'outgoing' : 'incoming',
      subject: log.subject,
      text: log.body,
      timestamp: log.sent_at || log.created_at,
      opened_at: log.opened_at,
      clicked_at: log.clicked_at,
      bounced_at: log.bounced_at,
      error: log.error,
    }));
    attachScores(messages, scoredActionsRes.rows);

    res.json({ lead, messages, sequence: seqRes.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email-conversations/:leadId/pause — stop follow-ups until reactivated
router.post('/:leadId/pause', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE lead_sequences SET status = 'paused', paused_reason = 'manual_pause', updated_at = NOW()
       WHERE id = (SELECT id FROM lead_sequences WHERE lead_id = $1 ORDER BY updated_at DESC LIMIT 1)
       RETURNING *`,
      [req.params.leadId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'No sequence found for this lead' });
    res.json({ success: true, sequence: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/email-conversations/:leadId/reactivate — resume follow-ups on the existing schedule
router.post('/:leadId/reactivate', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE lead_sequences SET status = 'active', paused_reason = NULL, updated_at = NOW()
       WHERE id = (SELECT id FROM lead_sequences WHERE lead_id = $1 ORDER BY updated_at DESC LIMIT 1)
       RETURNING *`,
      [req.params.leadId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'No sequence found for this lead' });
    res.json({ success: true, sequence: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
