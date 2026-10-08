const pool = require('../config/db');
const EmailSenderService = require('./emailSenderService');
const SuppressionService = require('./suppressionService');
const { alertOwner } = require('./ownerAlertService');
const settingsService = require('./settingsService');
const { renderEmailBody, escapeHtml } = require('../utils/emailRender');
const { getBackendUrl } = require('../utils/backendUrlConfig');
const { generateTrackingToken, buildPixelUrl, buildClickUrl } = require('../utils/emailTracking');
const { getThreadHeaders } = require('../utils/emailThreading');

async function logAgentAction(leadId, action, { detail, draftText, score, decision } = {}) {
  await pool.query(
    `INSERT INTO agent_actions (lead_id, action, detail, draft_text, score, decision)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [leadId ?? null, action, detail ? JSON.stringify(detail) : null, draftText ?? null, score ?? null, decision ?? null]
  );
}

async function notifyOwner(sender, lead, subjectLine, bodyText) {
  // Via the approved owner_alert template (ownerAlertService) — free text to the owner's number is
  // silently dropped by Meta outside a 24h window, which is how these email-channel alerts were
  // being lost (same bug fixed for the WhatsApp agent on 2026-08-29).
  const wa = await alertOwner(subjectLine, bodyText).catch((err) => ({ ok: false, error: err.message }));
  if (wa && wa.ok === false) console.error('[ReplyDelivery] WhatsApp owner notify failed:', wa.error);

  const notifyEmail = await settingsService.getSetting('OWNER_NOTIFY_EMAIL');
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
// draft, or queue it for human review if the judge scored it too low. `inReplyTo` is the raw
// provider message id of the inbound email being answered — it drives the threading headers
// and is carried in the queued payload so a later human-approved send still threads correctly.
async function sendOrQueueReply({ lead, leadSeq, sender, result, subject, sentActionLabel, inReplyTo }) {
  if (result.decision === 'send') {
    const unsubscribeUrl = `${getBackendUrl()}/unsubscribe?token=${SuppressionService.generateToken(lead.email)}`;
    const trackingToken = generateTrackingToken();
    const tracking = { pixelUrl: buildPixelUrl(trackingToken), trackUrl: (url) => buildClickUrl(trackingToken, url) };
    const thread = await getThreadHeaders(lead.id, inReplyTo);
    // Same per-mailbox sign-off as cold emails (the reply drafter is told not to write one).
    const signedText = `${result.text}\n\n${await EmailSenderService.signatureFor(sender)}`;
    const { html, text } = renderEmailBody(signedText, unsubscribeUrl, tracking);
    const sendResult = await EmailSenderService.send(sender, {
      to: lead.email, subject, html, text,
      unsubscribeUrl, inReplyTo: thread.inReplyTo, references: thread.references,
    });

    if (sendResult.success) {
      await pool.query(
        `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, provider_message_id, tracking_token, sent_at)
         VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, NOW())`,
        [lead.id, sender.id, leadSeq?.sequence_id || null, subject, html, sendResult.messageId, trackingToken]
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
    [lead.id, JSON.stringify({ draftText: result.text, score: result.score, subject, inReplyTo: inReplyTo || null })]
  );
  await notifyOwner(
    sender,
    lead,
    'Reply needs review',
    `${lead.hotel_name} — drafted reply scored ${result.score}/5 and needs your review before sending. Check the dashboard.`
  );
}

module.exports = { logAgentAction, notifyOwner, rescheduleFollowUp, sendOrQueueReply };
