const pool = require('../config/db');
const EmailSenderService = require('./emailSenderService');
const SuppressionService = require('./suppressionService');
const WABAService = require('./wabaService');
const { renderEmailBody, escapeHtml } = require('../utils/emailRender');
const { getBackendUrl } = require('../utils/backendUrlConfig');

async function logAgentAction(leadId, action, { detail, draftText, score, decision } = {}) {
  await pool.query(
    `INSERT INTO agent_actions (lead_id, action, detail, draft_text, score, decision)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [leadId ?? null, action, detail ? JSON.stringify(detail) : null, draftText ?? null, score ?? null, decision ?? null]
  );
}

async function notifyOwner(sender, lead, subjectLine, bodyText) {
  let ownerNumber = process.env.OWNER_WHATSAPP;
  if (ownerNumber) {
    ownerNumber = ownerNumber.replace(/\D/g, '');
    if (ownerNumber.length === 10) ownerNumber = '91' + ownerNumber;
    const result = await WABAService.sendTextMessage(ownerNumber, `📬 *${subjectLine}*\n\n${bodyText}`);
    if (!result.success) console.error('[ReplyDelivery] WhatsApp owner notify failed:', result.error);
  }

  const notifyEmail = process.env.OWNER_NOTIFY_EMAIL;
  if (notifyEmail && sender) {
    const html = `<p>${escapeHtml(bodyText).replace(/\n/g, '<br>')}</p>`;
    const result = await EmailSenderService.send(sender, { to: notifyEmail, subject: subjectLine, html, text: bodyText });
    if (!result.success) console.error('[ReplyDelivery] Email owner notify failed:', result.error);
  }
}

function computeNextRunAt(currentStep, leadSeq) {
  const gaps = typeof leadSeq.initial_gaps === 'string'
    ? JSON.parse(leadSeq.initial_gaps || '[]')
    : (leadSeq.initial_gaps || []);
  const gapDays = currentStep < gaps.length
    ? Number(gaps[currentStep])
    : Number(leadSeq.recurring_interval_days || 7);
  return new Date(Date.now() + gapDays * 86400000);
}

// Any reply pauses the pending follow-up and reschedules it relative to the reply, not the old schedule
async function rescheduleFollowUp(leadSeq) {
  const nextRunAt = computeNextRunAt(leadSeq.current_step, leadSeq);
  await pool.query(
    `UPDATE lead_sequences SET next_run_at = $1, updated_at = NOW() WHERE id = $2`,
    [nextRunAt, leadSeq.id]
  );
}

// Shared tail for any GPT-drafted reply (portfolio, question, etc.): send the quality-gated
// draft, or queue it for human review if the judge scored it too low.
async function sendOrQueueReply({ lead, leadSeq, sender, result, subject, sentActionLabel }) {
  if (result.decision === 'send') {
    const unsubscribeUrl = `${getBackendUrl()}/unsubscribe?token=${SuppressionService.generateToken(lead.email)}`;
    const { html, text } = renderEmailBody(result.text, unsubscribeUrl);
    const sendResult = await EmailSenderService.send(sender, { to: lead.email, subject, html, text });

    if (sendResult.success) {
      await pool.query(
        `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, provider_message_id, sent_at)
         VALUES ($1, $2, $3, 'out', $4, $5, $6, NOW())`,
        [lead.id, sender.id, leadSeq?.sequence_id || null, subject, html, sendResult.messageId]
      );
      await logAgentAction(lead.id, sentActionLabel, { detail: { subject }, draftText: result.text, score: result.score, decision: 'send' });
      if (leadSeq && leadSeq.status === 'active') {
        await rescheduleFollowUp(leadSeq);
      }
    } else {
      await pool.query(
        `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, error, sent_at)
         VALUES ($1, $2, $3, 'out', $4, $5, $6, NOW())`,
        [lead.id, sender.id, leadSeq?.sequence_id || null, subject, html, sendResult.error]
      );
      await logAgentAction(lead.id, sentActionLabel, { detail: { error: sendResult.error }, draftText: result.text, decision: 'error' });
    }
    return;
  }

  await pool.query(
    `INSERT INTO pending_approvals (type, lead_id, payload, status) VALUES ('low_score_reply', $1, $2, 'pending')`,
    [lead.id, JSON.stringify({ draftText: result.text, score: result.score, subject })]
  );
  await notifyOwner(
    sender,
    lead,
    'Reply needs review',
    `${lead.hotel_name} — drafted reply scored ${result.score}/5 and needs your review before sending. Check the dashboard.`
  );
}

module.exports = { logAgentAction, notifyOwner, rescheduleFollowUp, sendOrQueueReply };
