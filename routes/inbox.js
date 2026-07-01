const express = require('express');
const pool = require('../config/db');
const WABAService = require('../services/wabaService');
const router = express.Router();

// GET /api/inbox — conversations (one per lead who replied), newest first
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (ol.lead_id)
        ol.id,
        ol.lead_id,
        ol.campaign_id,
        ol.waba_message_id,
        ol.sent_at,
        ol.delivered_at,
        ol.read_at,
        ol.response_text,
        ol.response_received_at,
        ol.qualified_for_demo,
        ol.lead_status_after,
        hl.hotel_name,
        hl.owner_name,
        hl.whatsapp_number,
        hl.city,
        hl.status AS lead_status,
        c.campaign_name,
        t.template_name
      FROM outreach_logs ol
      JOIN hotel_leads hl ON hl.id = ol.lead_id
      LEFT JOIN campaigns c ON c.id = ol.campaign_id
      LEFT JOIN waba_templates t ON t.id = ol.template_id
      WHERE ol.response_received = true
      ORDER BY ol.lead_id, ol.response_received_at DESC
    `);

    // Sort by most recent reply
    const rows = result.rows.sort((a, b) =>
      new Date(b.response_received_at) - new Date(a.response_received_at)
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inbox/thread/:leadId — full message thread for one lead
router.get('/thread/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;

    const [leadRes, logsRes] = await Promise.all([
      pool.query('SELECT * FROM hotel_leads WHERE id = $1', [leadId]),
      pool.query(`
        SELECT ol.*, t.template_name, t.body_text, c.campaign_name
        FROM outreach_logs ol
        LEFT JOIN waba_templates t ON t.id = ol.template_id
        LEFT JOIN campaigns c ON c.id = ol.campaign_id
        WHERE ol.lead_id = $1
        ORDER BY ol.sent_at ASC
      `, [leadId])
    ]);

    const lead = leadRes.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Build a flat chronological thread: each outreach_log = 1 outgoing msg + optionally 1 incoming
    const messages = [];
    for (const log of logsRes.rows) {
      // Show template name tag instead of raw body with {{1}} placeholders
      const outText = log.template_name
        ? `[Template: ${log.template_name}]`
        : (log.body_text || '[Message sent]');
      messages.push({
        id: `out-${log.id}`,
        direction: 'outgoing',
        text: outText,
        campaign: log.campaign_name,
        template: log.template_name,
        timestamp: log.sent_at,
        delivered_at: log.delivered_at,
        read_at: log.read_at,
        wamid: log.waba_message_id,
      });
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

    // Log the outbound reply
    await pool.query(
      `INSERT INTO outreach_logs (lead_id, waba_message_id, message_type, sent_at)
       VALUES ($1, $2, 'reply', NOW())`,
      [lead_id, result.messageId]
    );

    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inbox/count — unread badge count
router.get('/count', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) AS count
      FROM outreach_logs
      WHERE response_received = true
        AND (lead_status_after IS NULL OR lead_status_after = 'responded')
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
