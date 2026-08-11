const express = require('express');
const pool = require('../config/db');
const WABAService = require('../services/wabaService');
const router = express.Router();

// GET /api/inbox — conversations (one per lead who replied), sorted like a real messaging app:
// by whichever happened most recently, their reply OR our own last outbound touch (not just
// "latest reply" — a lead we followed up with after their last message would otherwise get
// stuck showing as if nothing happened since). unread_count is genuine unread-message tracking:
// replies received after hotel_leads.inbox_last_read_at (stamped when the thread is opened
// below), the same mechanism a real WhatsApp/Gmail read receipt uses.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH latest_reply AS (
        SELECT DISTINCT ON (lead_id)
          id, lead_id, campaign_id, template_id, waba_message_id,
          sent_at, delivered_at, read_at, response_text, response_received_at,
          qualified_for_demo, lead_status_after
        FROM outreach_logs
        WHERE response_received = true
        ORDER BY lead_id, response_received_at DESC
      ),
      last_outbound AS (
        SELECT lead_id, MAX(sent_at) AS last_sent_at FROM outreach_logs GROUP BY lead_id
      ),
      unread AS (
        SELECT ol.lead_id, COUNT(*) AS unread_count
        FROM outreach_logs ol
        JOIN hotel_leads hl ON hl.id = ol.lead_id
        WHERE ol.response_received = true
          AND ol.response_received_at > COALESCE(hl.inbox_last_read_at, '-infinity'::timestamp)
        GROUP BY ol.lead_id
      )
      SELECT
        lr.id, lr.lead_id, lr.campaign_id, lr.waba_message_id,
        lr.sent_at, lr.delivered_at, lr.read_at, lr.response_text, lr.response_received_at,
        lr.qualified_for_demo, lr.lead_status_after,
        hl.hotel_name, hl.owner_name, hl.whatsapp_number, hl.city,
        hl.status AS lead_status, hl.archived_at,
        c.campaign_name, t.template_name,
        GREATEST(lr.response_received_at, lo.last_sent_at) AS last_activity_at,
        COALESCE(u.unread_count, 0)::int AS unread_count
      FROM latest_reply lr
      JOIN hotel_leads hl ON hl.id = lr.lead_id
      LEFT JOIN campaigns c ON c.id = lr.campaign_id
      LEFT JOIN waba_templates t ON t.id = lr.template_id
      LEFT JOIN last_outbound lo ON lo.lead_id = lr.lead_id
      LEFT JOIN unread u ON u.lead_id = lr.lead_id
      ORDER BY last_activity_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inbox/thread/:leadId — full message thread for one lead. Opening the thread is the
// "read receipt" moment — stamping inbox_last_read_at here is what clears this lead's unread
// badge in GET /api/inbox above, mirroring how opening a chat marks it read in a real app.
router.get('/thread/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;

    const [leadRes, logsRes] = await Promise.all([
      pool.query(
        `UPDATE hotel_leads SET inbox_last_read_at = NOW() WHERE id = $1 RETURNING *`,
        [leadId]
      ),
      pool.query(`
        SELECT ol.id, ol.lead_id, ol.campaign_id, ol.template_id,
               ol.message_type, ol.message_text,
               ol.waba_message_id, ol.sent_at, ol.delivered_at, ol.read_at,
               ol.response_received, ol.response_text, ol.response_received_at,
               ol.qualified_for_demo, ol.lead_status_after,
               t.template_name, t.body_text, c.campaign_name
        FROM outreach_logs ol
        LEFT JOIN waba_templates t ON t.id = ol.template_id
        LEFT JOIN campaigns c ON c.id = ol.campaign_id
        WHERE ol.lead_id = $1
        ORDER BY ol.sent_at ASC
      `, [leadId])
    ]);

    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Build flat chronological thread
    const messages = [];
    for (const log of logsRes.rows) {
      if (log.message_type === 'reply' && log.message_text) {
        // Agent or manual text reply we sent
        messages.push({
          id: `out-${log.id}`,
          direction: 'outgoing',
          text: log.message_text,
          message_type: 'reply',
          timestamp: log.sent_at,
          wamid: log.waba_message_id,
        });
      } else {
        // Template outreach message — show the actual body (with the {{1}} name variable filled
        // in) instead of just "[template_name]", so a thread with several template touches reads
        // like a real conversation instead of a wall of identical bracket tags.
        const outText = log.template_name
          ? (log.body_text
              ? log.body_text.replace(/\{\{1\}\}/g, lead.owner_name || lead.hotel_name || 'there')
              : `[${log.template_name}]`)
          : (log.message_text || '[Message sent]');
        messages.push({
          id: `out-${log.id}`,
          direction: 'outgoing',
          text: outText,
          message_type: 'template',
          campaign: log.campaign_name,
          template: log.template_name,
          timestamp: log.sent_at,
          delivered_at: log.delivered_at,
          read_at: log.read_at,
          wamid: log.waba_message_id,
        });
      }

      // Incoming reply from the lead
      if (log.response_received && log.response_text) {
        messages.push({
          id: `in-${log.id}`,
          direction: 'incoming',
          text: log.response_text,
          timestamp: log.response_received_at,
          qualified_for_demo: log.qualified_for_demo,
        });
      }
    }

    res.json({ lead, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/inbox/reply — send a free-text reply to a lead
router.post('/reply', async (req, res) => {
  const { lead_id, message } = req.body;
  if (!lead_id || !message?.trim()) return res.status(400).json({ error: 'lead_id and message required' });

  try {
    const leadRes = await pool.query('SELECT * FROM hotel_leads WHERE id = $1', [lead_id]);
    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const result = await WABAService.sendTextMessage(lead.whatsapp_number, message.trim());
    if (!result.success) return res.status(502).json({ error: result.error });

    // Log the outbound reply — message_text is what the thread view actually renders, without
    // it a manual reply shows as a blank "[Message sent]" placeholder instead of what was typed.
    await pool.query(
      `INSERT INTO outreach_logs (lead_id, waba_message_id, message_type, message_text, sent_at)
       VALUES ($1, $2, 'reply', $3, NOW())`,
      [lead_id, result.messageId, message.trim()]
    );

    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/inbox/:leadId/archive — archive/unarchive a conversation.
// UI organization only: does not touch lead status, sending, or follow-ups.
router.put('/:leadId/archive', async (req, res) => {
  const { archived } = req.body;
  try {
    const result = await pool.query(
      `UPDATE hotel_leads SET archived_at = ${archived ? 'NOW()' : 'NULL'} WHERE id = $1 RETURNING id, archived_at`,
      [req.params.leadId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true, archived_at: result.rows[0].archived_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inbox/count — unread badge count (archived conversations don't count)
router.get('/count', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) AS count
      FROM outreach_logs ol
      JOIN hotel_leads hl ON hl.id = ol.lead_id
      WHERE ol.response_received = true
        AND (ol.lead_status_after IS NULL OR ol.lead_status_after = 'responded')
        AND hl.archived_at IS NULL
    `);
    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inbox/all — all sent messages (outreach history)
router.get('/all', async (req, res) => {
  try {
    const { campaign_id } = req.query;
    let query = `
      SELECT ol.id, ol.lead_id, ol.campaign_id, ol.waba_message_id,
        ol.sent_at, ol.delivered_at, ol.read_at,
        ol.response_received, ol.response_text, ol.response_received_at,
        ol.qualified_for_demo, ol.error_message,
        hl.hotel_name, hl.owner_name, hl.whatsapp_number, hl.city,
        c.campaign_name
      FROM outreach_logs ol
      JOIN hotel_leads hl ON hl.id = ol.lead_id
      LEFT JOIN campaigns c ON c.id = ol.campaign_id
    `;
    const params = [];
    if (campaign_id) { query += ' WHERE ol.campaign_id = $1'; params.push(campaign_id); }
    query += ' ORDER BY ol.sent_at DESC LIMIT 500';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
