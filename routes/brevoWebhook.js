const express = require('express');
const pool = require('../config/db');
const SuppressionService = require('../services/suppressionService');

const router = express.Router();

async function findLeadByEmail(email) {
  const result = await pool.query(
    'SELECT id, email_status FROM hotel_leads WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email]
  );
  return result.rows[0] || null;
}

// Prefer the exact message; fall back to the lead's latest outbound log (Brevo
// occasionally reformats message-ids between send response and webhook payload).
async function stampEmailLog(messageId, leadId, column, eventDate) {
  if (messageId) {
    const byId = await pool.query(
      `UPDATE email_logs SET ${column} = COALESCE(${column}, $1)
       WHERE provider_message_id = $2 AND direction = 'out' RETURNING id`,
      [eventDate, messageId]
    );
    if (byId.rowCount > 0) return;
  }
  if (leadId) {
    await pool.query(
      `UPDATE email_logs SET ${column} = COALESCE(${column}, $1)
       WHERE id = (
         SELECT id FROM email_logs
         WHERE lead_id = $2 AND direction = 'out'
         ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 1
       )`,
      [eventDate, leadId]
    );
  }
}

async function stopSequencesForLead(leadId, reason) {
  await pool.query(
    `UPDATE lead_sequences SET status = 'dead', paused_reason = $1, updated_at = NOW()
     WHERE lead_id = $2 AND status IN ('active', 'paused', 'waiting_estimate')`,
    [reason, leadId]
  );
}

// Brevo transactional webhook — configure in Brevo dashboard:
// Transactional → Settings → Webhook, URL: {BACKEND_URL}/webhooks/brevo?token={BREVO_WEBHOOK_TOKEN},
// or use Brevo's "Token" authentication method (sent as Authorization: Bearer <token>).
// Select events: delivered, hard bounce, soft bounce, blocked, invalid email, spam, opened, clicked, unsubscribed
router.post('/', async (req, res) => {
  const expectedToken = process.env.BREVO_WEBHOOK_TOKEN;
  if (expectedToken) {
    const auth = req.get('authorization') || '';
    const headerToken = auth.replace(/^Bearer\s+/i, '').trim();
    const provided = req.query.token || headerToken;
    if (provided !== expectedToken) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  // Always ack fast — Brevo retries on non-2xx, and a processing bug shouldn't
  // cause the same event to be redelivered forever.
  res.json({ received: true });

  const { event, email } = req.body || {};
  const messageId = req.body?.['message-id'] || null;
  if (!event || !email) return;

  const eventDate = req.body.date ? new Date(req.body.date) : new Date();

  try {
    const lead = await findLeadByEmail(email);
    const leadId = lead?.id || null;

    switch (event) {
      case 'delivered':
        await stampEmailLog(messageId, leadId, 'delivered_at', eventDate);
        break;

      case 'opened':
      case 'unique_opened':
        await stampEmailLog(messageId, leadId, 'opened_at', eventDate);
        break;

      case 'click':
        await stampEmailLog(messageId, leadId, 'clicked_at', eventDate);
        break;

      case 'soft_bounce':
      case 'deferred':
        // Temporary failure — record it but let the sequence keep trying
        await stampEmailLog(messageId, leadId, 'bounced_at', eventDate);
        break;

      case 'hard_bounce':
      case 'invalid_email':
      case 'blocked':
      case 'spam':
      case 'unsubscribed': {
        await stampEmailLog(messageId, leadId, 'bounced_at', eventDate);
        const reason = event === 'spam' ? 'spam_complaint'
          : event === 'unsubscribed' ? 'unsubscribed' : 'bounced';
        await SuppressionService.addToSuppression(email, reason);
        if (leadId) {
          await stopSequencesForLead(leadId, reason);
          if (event !== 'unsubscribed') {
            await pool.query(
              `UPDATE hotel_leads SET email_status = 'bounced', updated_at = NOW() WHERE id = $1`,
              [leadId]
            );
          }
          await pool.query(
            `INSERT INTO agent_actions (lead_id, action, detail, decision)
             VALUES ($1, 'sequence_stopped', $2, $3)`,
            [leadId, JSON.stringify({ source: 'brevo_webhook', event, messageId }), reason]
          );
        }
        console.log(`[BrevoWebhook] ${event} for ${email} — suppressed, sequences stopped`);
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error(`[BrevoWebhook] Failed to process ${event} for ${email}:`, err.message);
  }
});

module.exports = router;
