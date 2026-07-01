const express = require('express');
const pool = require('../config/db');
const agentService = require('../services/agentService');
const router = express.Router();

const TEMPLATE_STATUS_MAP = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PENDING: 'pending_approval',
  PENDING_DELETION: 'pending_approval',
  DELETED: 'deleted',
  DISABLED: 'paused',
  PAUSED: 'paused',
};

// Meta webhook verification (GET)
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'dreams_hotel_webhook_2024';
  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[Webhook] Meta verification successful');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Meta webhook events (POST)
router.post('/whatsapp', async (req, res) => {
  res.sendStatus(200); // Respond immediately to Meta

  try {
    const body = req.body;
    if (!body?.entry) return;

    for (const entry of body.entry) {
      for (const change of (entry.changes || [])) {

        // ── Template approval status updates ─────────────────────────────────
        if (change.field === 'message_template_status_update') {
          const { event, message_template_name, message_template_id, reason } = change.value || {};
          const newStatus = TEMPLATE_STATUS_MAP[event] || 'pending_approval';
          console.log(`[Webhook] Template "${message_template_name}" → ${event} (${newStatus})`);

          await pool.query(
            `UPDATE waba_templates
             SET status = $1,
                 meta_template_id = COALESCE(meta_template_id, $2),
                 updated_at = NOW()
             WHERE template_name = $3`,
            [newStatus, String(message_template_id || ''), message_template_name]
          );
        }

        // ── Message delivery/read receipts + incoming replies ─────────────────
        if (change.field === 'messages') {
          const value = change.value || {};

          // Delivery/read status updates from Meta
          for (const status of (value.statuses || [])) {
            const msgId = status.id;
            const wabStatus = status.status; // 'sent', 'delivered', 'read', 'failed'

            if (wabStatus === 'delivered') {
              await pool.query(
                `UPDATE outreach_logs SET delivered_at = NOW() WHERE waba_message_id = $1`,
                [msgId]
              );
              console.log(`[Webhook] Delivery confirmed: ${msgId}`);
            } else if (wabStatus === 'read') {
              await pool.query(
                `UPDATE outreach_logs SET read_at = NOW() WHERE waba_message_id = $1`,
                [msgId]
              );
              console.log(`[Webhook] Read confirmed: ${msgId}`);
            } else if (wabStatus === 'failed') {
              await pool.query(
                `UPDATE outreach_logs SET error_message = $1 WHERE waba_message_id = $2`,
                [status.errors?.[0]?.message || 'Failed', msgId]
              );
            }
          }

          // Incoming reply messages from leads
          for (const msg of (value.messages || [])) {
            if (msg.type !== 'text') continue;

            const fromPhone = msg.from; // E.164 without +
            const msgText = msg.text?.body || '';
            console.log(`[Webhook] Incoming reply from ${fromPhone}: "${msgText}"`);

            // Find the lead by phone (strip non-digits for comparison)
            const leadResult = await pool.query(
              `SELECT id FROM hotel_leads
               WHERE REGEXP_REPLACE(whatsapp_number, '[^0-9]', '', 'g') LIKE $1
               LIMIT 1`,
              [`%${fromPhone.slice(-10)}`]
            );

            if (leadResult.rows.length === 0) {
              console.log(`[Webhook] No lead found for phone ${fromPhone}`);
              continue;
            }

            const leadId = leadResult.rows[0].id;
            const isDemo = /\bDEMO\b|interested|yes|want|need|sure/i.test(msgText);
            const newLeadStatus = isDemo ? 'demo_qualified' : 'responded';

            // Update the most recent outreach log for this lead
            await pool.query(
              `UPDATE outreach_logs
               SET response_received = true,
                   response_text = $1,
                   response_received_at = NOW(),
                   qualified_for_demo = $2,
                   lead_status_after = $3
               WHERE id = (
                 SELECT id FROM outreach_logs WHERE lead_id = $4
                 ORDER BY sent_at DESC LIMIT 1
               )`,
              [msgText, isDemo, newLeadStatus, leadId]
            );

            // Update lead status
            await pool.query(
              `UPDATE hotel_leads SET status = $1, updated_at = NOW() WHERE id = $2`,
              [newLeadStatus, leadId]
            );

            console.log(`[Webhook] Lead ${leadId} → ${newLeadStatus} (demo: ${isDemo})`);

            // AI agent auto-replies to qualify the lead
            const leadRow = await pool.query('SELECT * FROM hotel_leads WHERE id = $1', [leadId]);
            if (leadRow.rows[0]) {
              if (!process.env.OPENAI_API_KEY) {
                console.error('[Agent] ❌ OPENAI_API_KEY not set — agent cannot reply. Add it to Render env vars.');
              } else {
                agentService.handleReply(leadRow.rows[0], msgText).catch(e =>
                  console.error('[Agent] handleReply failed:', e.message)
                );
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Error processing event:', err.message);
  }
});

module.exports = router;
