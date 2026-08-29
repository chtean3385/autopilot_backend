const express = require('express');
const pool = require('../config/db');
const WABAService = require('../services/wabaService');
const router = express.Router();

// GET /api/inbox — one row per lead we've contacted on WhatsApp (NOT only leads who replied —
// a messaging inbox shows every thread you've started). Newest activity first (their reply OR
// our last send). Each row carries the last outbound message + its Meta delivery state
// (error_message → failed, read_at → read, delivered_at → delivered, else sent) and, if any,
// the latest inbound reply. Capped at 400 threads. unread_count counts replies that landed
// after hotel_leads.inbox_last_read_at (stamped when the thread is opened).
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH threads AS (
        SELECT lead_id,
               MAX(sent_at)               AS last_sent_at,
               MAX(response_received_at)  AS last_reply_at,
               bool_or(response_received) AS has_replied
        FROM outreach_logs
        GROUP BY lead_id
      ),
      last_out AS (
        SELECT DISTINCT ON (lead_id)
          lead_id, id, campaign_id, template_id, waba_message_id,
          message_type, message_text, sent_at, delivered_at, read_at, error_message
        FROM outreach_logs
        ORDER BY lead_id, sent_at DESC
      ),
      last_reply AS (
        SELECT DISTINCT ON (lead_id)
          lead_id, response_text, response_received_at, qualified_for_demo, lead_status_after
        FROM outreach_logs
        WHERE response_received = true
        ORDER BY lead_id, response_received_at DESC
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
        lo.id, t.lead_id, lo.campaign_id, lo.waba_message_id,
        lo.sent_at, lo.delivered_at, lo.read_at, lo.error_message,
        lo.message_type AS last_out_type,
        left(CASE WHEN lo.message_type = 'template'
             THEN COALESCE(NULLIF(lo.message_text, ''), wt.body_text)
             ELSE lo.message_text END, 200) AS last_out_text,
        lr.response_text, lr.response_received_at, lr.qualified_for_demo, lr.lead_status_after,
        COALESCE(t.has_replied, false) AS has_replied,
        hl.hotel_name, hl.owner_name, hl.whatsapp_number, hl.city,
        hl.status AS lead_status, hl.archived_at,
        hl.needs_attention, hl.needs_attention_reason, hl.ai_paused,
        c.campaign_name,
        GREATEST(t.last_reply_at, t.last_sent_at) AS last_activity_at,
        COALESCE(u.unread_count, 0)::int AS unread_count
      FROM threads t
      JOIN hotel_leads hl   ON hl.id = t.lead_id
      JOIN last_out lo      ON lo.lead_id = t.lead_id
      LEFT JOIN last_reply lr    ON lr.lead_id = t.lead_id
      LEFT JOIN waba_templates wt ON wt.id = lo.template_id
      LEFT JOIN campaigns c      ON c.id = lo.campaign_id
      LEFT JOIN unread u         ON u.lead_id = t.lead_id
      WHERE (hl.channel = 'whatsapp' OR hl.channel IS NULL)
      ORDER BY last_activity_at DESC NULLS LAST
      LIMIT 400
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

    // A staff member replying by hand = taking the lead over. Pause the AI and flag the
    // thread; the "Return to AI" button clears both. Without this the bot would keep
    // replying alongside the human and the follow-up job would still chase the lead.
    await pool.query(
      `UPDATE hotel_leads
       SET needs_attention = TRUE,
           ai_paused = TRUE,
           needs_attention_reason = COALESCE(NULLIF(needs_attention_reason, ''), 'Staff replied — you are handling this'),
           updated_at = NOW()
       WHERE id = $1`,
      [lead_id]
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

// PUT /api/inbox/:leadId/attention — manual "Take over" / "Return to AI".
//   needs_attention=true  → flag the thread AND pause the AI (a human is taking it).
//   needs_attention=false → clear the flag, un-pause the AI, and put the lead back in a
//                           status the follow-up job / agent will pick up again.
router.put('/:leadId/attention', async (req, res) => {
  const { needs_attention, reason } = req.body;
  const flag = !!needs_attention;
  try {
    if (flag) {
      const result = await pool.query(
        `UPDATE hotel_leads
         SET needs_attention = TRUE, ai_paused = TRUE,
             needs_attention_reason = $1, updated_at = NOW()
         WHERE id = $2 RETURNING id, needs_attention, ai_paused, needs_attention_reason`,
        [reason || 'You are handling this lead', req.params.leadId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
      return res.json({ success: true, ...result.rows[0] });
    }

    const result = await pool.query(
      `UPDATE hotel_leads
       SET needs_attention = FALSE, ai_paused = FALSE, needs_attention_reason = NULL,
           status = CASE
             WHEN status IN ('demo_qualified','not_interested','opted_out','converted','needs_review') THEN status
             WHEN EXISTS (SELECT 1 FROM outreach_logs o WHERE o.lead_id = hotel_leads.id AND o.response_received = TRUE) THEN 'responded'
             ELSE 'new' END,
           updated_at = NOW()
       WHERE id = $1 RETURNING id, needs_attention, ai_paused, needs_attention_reason, status`,
      [req.params.leadId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true, ...result.rows[0] });
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
