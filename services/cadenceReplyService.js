const pool = require('../config/db');
const ReplyQualityService = require('./replyQualityService');
const PlaybookService = require('./playbookService');
const EmailSenderService = require('./emailSenderService');
const WABAService = require('./wabaService');
const settingsService = require('./settingsService');
const { sendOrQueueReply, logAgentAction } = require('./replyDeliveryService');
const { alertOwner } = require('./ownerAlertService');
const { classifyReplyIntent, tooSimilarToPrior } = require('./salesAgentService');
const { escapeHtml } = require('../utils/emailRender');
const { WRITING_RULES } = require('../utils/humanTone');

// Directory outreach step 5 (_docs/directory-outreach-plan.md): what happens when a cadence_managed
// (directory) lead replies, on EITHER channel. Called from emailReplyWorker.js and routes/webhook.js
// in place of their normal handlers for these leads only — every other lead is unaffected.
//
//   1. The cadence stops on BOTH channels immediately (before any AI call can fail).
//   2. The owner is told on WhatsApp (owner_alert template) + email: who, which channel, what they said.
//   3. The existing safety gate (salesAgentService.classifyReplyIntent) decides:
//        HANDOFF / UNSURE  → send NOTHING, flag needs_attention, alert. Pricing, calls, demos,
//                            complaints and anything unclear are always a human's call here.
//        NOT_INTERESTED    → stop permanently, alert (FYI).
//        AUTO_REPLY (email)→ out-of-office: ignored, cadence NOT stopped.
//        ROUTINE           → draft + self-score (one-decimal, existing ReplyQualityService).
//   4. A ROUTINE draft goes to the existing Pending Actions approval queue — unless the owner has
//      switched on CADENCE_AUTO_SEND_REPLIES and it scored >= AUTO_SEND_MIN_SCORE (4.5).
//   A classifier/AI failure falls to UNSURE: nothing is sent and the owner is alerted.

const DEFAULT_MIN_SCORE = 4.5;

function stripHtml(html) {
  return String(html || '')
    .replace(/<img[^>]*>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&middot;/gi, '·')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
    .split(' Dreams Technology · ')[0]; // drop the unsubscribe footer
}

// Both channels, oldest first — the drafter and the never-repeat check must see every touch,
// whichever channel it went out on.
async function getCrossChannelHistory(leadId) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT 'email' AS channel, direction, body, COALESCE(sent_at, created_at) AS at
       FROM email_logs WHERE lead_id = $1 AND error IS NULL
       UNION ALL
       SELECT 'whatsapp', 'out', COALESCE(ol.message_text, wt.body_text), ol.sent_at
       FROM outreach_logs ol LEFT JOIN waba_templates wt ON wt.id = ol.template_id WHERE ol.lead_id = $1
       UNION ALL
       SELECT 'whatsapp', 'in', ol.response_text, COALESCE(ol.response_received_at, ol.sent_at)
       FROM outreach_logs ol WHERE ol.lead_id = $1 AND ol.response_text IS NOT NULL
     ) h WHERE body IS NOT NULL AND body <> ''
     ORDER BY at ASC
     LIMIT 30`,
    [leadId]
  );
  return rows.map((r) => ({
    direction: r.direction,
    channel: r.channel,
    body: r.channel === 'email' && r.direction === 'out' ? stripHtml(r.body).slice(0, 600) : String(r.body).slice(0, 600),
  }));
}

// Stops the cadence for good (status replied/stopped) and parks any sequence row, so neither the
// cadence worker nor sequenceEmailWorker sends another cold touch. Upsert: a lead who replies before
// the cadence ever started still gets a row, so it can never start later.
async function stopCadence(leadId, status, reason) {
  await pool.query(
    `INSERT INTO lead_cadence (lead_id, status, stop_reason, next_touch_at, updated_at)
     VALUES ($1, $2, $3, NULL, NOW())
     ON CONFLICT (lead_id) DO UPDATE SET status = $2, stop_reason = $3, next_touch_at = NULL, updated_at = NOW()`,
    [leadId, status, String(reason).slice(0, 80)]
  );
  await pool.query(
    `UPDATE lead_sequences SET status = 'paused', paused_reason = $2, updated_at = NOW()
     WHERE lead_id = $1 AND status = 'active'`,
    [leadId, `cadence_${status}`]
  );
}

async function markNeedsAttention(leadId, reason) {
  await pool.query(
    `UPDATE hotel_leads SET needs_attention = TRUE, needs_attention_reason = $2, updated_at = NOW() WHERE id = $1`,
    [leadId, String(reason).slice(0, 255)]
  );
}

// WhatsApp via the approved owner_alert template (works outside the 24h window) + email to
// OWNER_NOTIFY_EMAIL from any active sender. Never throws — an alert failure must not lose the reply.
async function notifyOwnerBothChannels(lead, title, detail) {
  const who = `${lead.hotel_name}${lead.owner_name ? ` (${lead.owner_name})` : ''}${lead.city ? `, ${lead.city}` : ''}`;
  try {
    await alertOwner(title, `${who} — ${detail}`);
  } catch (err) {
    console.error('[CadenceReply] WhatsApp owner alert failed:', err.message);
  }
  try {
    const to = await settingsService.getSetting('OWNER_NOTIFY_EMAIL');
    const sender = to ? await EmailSenderService.pickAnyActiveSender() : null;
    if (to && sender) {
      const body = `${who}\n${lead.whatsapp_number ? `WhatsApp: +${lead.whatsapp_number}\n` : ''}${lead.email ? `Email: ${lead.email}\n` : ''}\n${detail}\n\nOpen Pending Actions / Inbox in the CRM to respond.`;
      const res = await EmailSenderService.send(sender, {
        to, subject: `[CRM] ${title}: ${lead.hotel_name}`,
        html: `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`, text: body,
      });
      if (!res.success) console.error('[CadenceReply] owner email failed:', res.error);
    }
  } catch (err) {
    console.error('[CadenceReply] owner email failed:', err.message);
  }
}

async function autoSendPolicy() {
  const on = String(await settingsService.getSetting('CADENCE_AUTO_SEND_REPLIES') || '').toLowerCase() === 'true';
  const min = Number.parseFloat(await settingsService.getSetting('AUTO_SEND_MIN_SCORE'));
  return { autoSend: on, minScore: Number.isFinite(min) && min >= 1 && min <= 5 ? min : DEFAULT_MIN_SCORE };
}

// channel: 'email' | 'whatsapp'. For email also: subject, messageId (inbound provider id), sender
// (the mailbox it arrived in). Returns a short outcome string (also logged to agent_actions).
async function handleCadenceReply({ lead, channel, text, subject = null, messageId = null, sender = null }) {
  const message = String(text || '').trim();
  const fresh = (await pool.query('SELECT * FROM hotel_leads WHERE id = $1', [lead.id])).rows[0] || lead;
  const history = await getCrossChannelHistory(fresh.id);
  const preview = message.slice(0, 200);

  // A human took this lead over in the Inbox — just make sure the cadence is off and tell the owner.
  if (fresh.ai_paused) {
    await stopCadence(fresh.id, 'replied', `${channel}_reply`);
    await logAgentAction(fresh.id, 'cadence_reply_ai_paused', { detail: { channel, message: preview }, decision: 'skipped' });
    await notifyOwnerBothChannels(fresh, `New ${channel} reply`, `"${preview}" (you've taken this lead over)`);
    return 'ai_paused';
  }

  const { gate, reason } = await classifyReplyIntent({ lead: fresh, message, conversationHistory: history, channel });

  if (gate === 'AUTO_REPLY') {
    await logAgentAction(fresh.id, 'cadence_auto_reply_ignored', { detail: { channel, message: preview }, decision: 'ignored' });
    return 'auto_reply';
  }

  if (gate === 'NOT_INTERESTED') {
    await stopCadence(fresh.id, 'stopped', 'not_interested');
    await pool.query(`UPDATE hotel_leads SET status = 'not_interested', updated_at = NOW() WHERE id = $1`, [fresh.id]);
    await logAgentAction(fresh.id, 'cadence_not_interested', { detail: { channel, message: preview }, decision: 'not_interested' });
    await notifyOwnerBothChannels(fresh, 'Lead not interested', `replied on ${channel}: "${preview}". Outreach stopped for good.`);
    return 'not_interested';
  }

  // Any real reply: cadence off on both channels, conversation now belongs to approvals/the owner.
  await stopCadence(fresh.id, 'replied', `${channel}_reply`);
  await pool.query(
    `UPDATE hotel_leads SET status = 'responded', updated_at = NOW() WHERE id = $1 AND status IN ('new', 'no_response')`,
    [fresh.id]
  );

  if (gate === 'HANDOFF' || gate === 'UNSURE') {
    const why = gate === 'HANDOFF' ? (reason || 'Needs a human') : 'AI could not understand the reply';
    await markNeedsAttention(fresh.id, why);
    await logAgentAction(fresh.id, 'cadence_reply_handoff', { detail: { channel, gate, reason, message: preview }, decision: 'handoff' });
    await notifyOwnerBothChannels(fresh, `Reply needs you (${channel})`, `${why}. They wrote: "${preview}". Nothing was sent — please reply yourself.`);
    return gate.toLowerCase();
  }

  // ROUTINE → draft on the channel they replied on, self-check at one-decimal precision.
  const { autoSend, minScore } = await autoSendPolicy();
  const { fewShotExamples, notes } = await PlaybookService.getPlaybookContext();
  const priorOutbound = history.filter((h) => h.direction === 'out').map((h) => h.body);
  const extraContext =
    'This lead was found in a business directory and contacted by short cold messages on email and WhatsApp. '
    + 'Conversation history includes both channels. Do NOT quote prices, discounts, or timelines and do NOT promise anything specific. '
    + 'EVERY message already sent to this lead is in the history — never repeat or lightly reword one. '
    + 'If there is nothing new and useful to say, return an empty string for "text".\n\n'
    + `${WRITING_RULES}\nTheir trade: ${fresh.niche || fresh.business_category || 'not known'}. This is a reply to what they just wrote — answer it like a person would.`;

  const result = await ReplyQualityService.draftAndScore({
    channel, leadId: fresh.id, lead: fresh, incomingMessage: message, conversationHistory: history,
    playbookExamples: fewShotExamples, playbookNotes: notes, extraContext,
  }, { threshold: minScore, decimal: true });

  if (!result.text?.trim() || tooSimilarToPrior(result.text, priorOutbound)) {
    await markNeedsAttention(fresh.id, 'AI has nothing new to add — needs a human');
    await logAgentAction(fresh.id, 'cadence_reply_no_new_draft', { detail: { channel, draft: result.text }, decision: 'handoff' });
    await notifyOwnerBothChannels(fresh, `Reply needs you (${channel})`, `They wrote: "${preview}". The AI had nothing new to say, so nothing was sent.`);
    return 'no_new_draft';
  }

  const canAutoSend = autoSend && result.score >= minScore;

  if (channel === 'whatsapp') {
    if (canAutoSend) {
      const sent = await WABAService.sendTextMessage(fresh.whatsapp_number, result.text);
      if (sent.success) {
        await pool.query(
          `INSERT INTO outreach_logs (lead_id, campaign_id, template_id, waba_message_id, message_type, message_text, sent_at)
           VALUES ($1, NULL, NULL, $2, 'reply', $3, NOW())`,
          [fresh.id, sent.messageId, result.text]
        );
        await logAgentAction(fresh.id, 'cadence_reply_auto_sent', { detail: { channel, score_exact: result.score }, draftText: result.text, decision: 'send' });
        await notifyOwnerBothChannels(fresh, 'Reply auto-sent (WhatsApp)', `They wrote: "${preview}". We replied (score ${result.score}/5): "${result.text.slice(0, 200)}"`);
        return 'auto_sent';
      }
      console.error('[CadenceReply] WhatsApp auto-send failed, queuing for approval:', sent.error);
    }
    await pool.query(
      `INSERT INTO pending_approvals (type, lead_id, payload, status) VALUES ('whatsapp_low_score_reply', $1, $2, 'pending')`,
      [fresh.id, JSON.stringify({ draftText: result.text, score: result.score, source: 'directory_cadence' })]
    );
  } else {
    const replySubject = subject ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : 'Re: your message';
    const mailbox = sender || await EmailSenderService.getSenderForLead(fresh.id, { strict: false });
    if (canAutoSend && mailbox) {
      // Existing shared send tail: unsubscribe link/header, tracking, threading, email_logs row.
      // agent_actions.score is INT — pass a rounded score; the exact one is logged just below.
      await sendOrQueueReply({
        lead: fresh, leadSeq: null, sender: mailbox, subject: replySubject, inReplyTo: messageId,
        result: { ...result, score: Math.round(result.score), decision: 'send' }, sentActionLabel: 'cadence_reply_auto_sent',
      });
      await logAgentAction(fresh.id, 'cadence_reply_score', { detail: { channel, score_exact: result.score }, decision: 'send' });
      await notifyOwnerBothChannels(fresh, 'Reply auto-sent (email)', `They wrote: "${preview}". We replied (score ${result.score}/5): "${result.text.slice(0, 200)}"`);
      return 'auto_sent';
    }
    await pool.query(
      `INSERT INTO pending_approvals (type, lead_id, payload, status) VALUES ('low_score_reply', $1, $2, 'pending')`,
      [fresh.id, JSON.stringify({ draftText: result.text, score: result.score, subject: replySubject, inReplyTo: messageId || null, source: 'directory_cadence' })]
    );
  }

  await logAgentAction(fresh.id, 'cadence_reply_queued', {
    detail: { channel, score_exact: result.score, autoSend, minScore }, draftText: result.text, decision: 'queue_human',
  });
  await notifyOwnerBothChannels(
    fresh,
    `Reply ready to approve (${channel})`,
    `They wrote: "${preview}". Draft (score ${result.score}/5) is waiting in Pending Actions: "${result.text.slice(0, 200)}"`
  );
  return 'queued';
}

module.exports = { handleCadenceReply, stopCadence, getCrossChannelHistory };
