const schedule = require('node-schedule');
const OpenAI = require('openai');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const pool = require('../config/db');
const EmailSenderService = require('../services/emailSenderService');
const ReplyQualityService = require('../services/replyQualityService');
const PortfolioReplyService = require('../services/portfolioReplyService');
const PlaybookService = require('../services/playbookService');
const { logAgentAction, notifyOwner, sendOrQueueReply } = require('../services/replyDeliveryService');
const { trackedCompletion } = require('../utils/aiUsage');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const HISTORY_LIMIT = 20;
const INTENTS = ['not_interested', 'wants_estimate', 'wants_portfolio', 'question', 'auto_reply'];
const AUTO_REPLY_ADDRESS = /mailer-daemon|postmaster/i;

let isRunning = false;

async function findLeadByEmail(email) {
  const result = await pool.query('SELECT * FROM hotel_leads WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
  return result.rows[0] || null;
}

async function getActiveLeadSequence(leadId) {
  const result = await pool.query(
    `SELECT ls.*, s.initial_gaps, s.recurring_interval_days
     FROM lead_sequences ls
     JOIN sequences s ON s.id = ls.sequence_id
     WHERE ls.lead_id = $1
     ORDER BY ls.updated_at DESC
     LIMIT 1`,
    [leadId]
  );
  return result.rows[0] || null;
}

async function getConversationHistory(leadId) {
  const result = await pool.query(
    `SELECT direction, subject, body
     FROM email_logs
     WHERE lead_id = $1
     ORDER BY COALESCE(sent_at, created_at) ASC
     LIMIT $2`,
    [leadId, HISTORY_LIMIT]
  );
  return result.rows;
}

function buildReplySubject(subject) {
  const trimmed = (subject || '').trim();
  if (!trimmed) return 'Re: your message';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

async function classifyIntent({ lead, incomingMessage, conversationHistory }) {
  const historyText = ReplyQualityService.buildHistoryText(conversationHistory);
  const userContent = `${ReplyQualityService.buildLeadContext(lead)}${historyText ? `\n\nConversation so far:\n${historyText}` : ''}\n\nLead's latest message:\n${incomingMessage}`;

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 60,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Classify the intent of an inbound email reply to a cold sales outreach email from Dreams Technology. ' +
          'Respond with ONLY a JSON object: {"intent": "..."} where intent is exactly one of: ' +
          '"not_interested" (says no, uninterested, or asks to stop/unsubscribe/opt out), ' +
          '"wants_estimate" (asks for pricing, a quote, or a cost estimate), ' +
          '"wants_portfolio" (asks to see past work, examples, case studies, or a portfolio), ' +
          '"auto_reply" (an automated out-of-office / vacation responder, not a real reply from the person), ' +
          'or "question" (anything else — a question, interest, or general reply that needs a human-crafted response).',
      },
      { role: 'user', content: userContent },
    ],
  }, { purpose: 'email_intent', leadId: lead?.id ?? null });

  const parsed = JSON.parse(response.choices[0].message.content);
  return INTENTS.includes(parsed.intent) ? parsed.intent : 'question';
}

async function handleNotInterested(lead, leadSeq) {
  await pool.query(`UPDATE hotel_leads SET status = 'not_interested', updated_at = NOW() WHERE id = $1`, [lead.id]);
  if (leadSeq) {
    await pool.query(
      `UPDATE lead_sequences SET status = 'dead', paused_reason = 'not_interested', updated_at = NOW() WHERE id = $1`,
      [leadSeq.id]
    );
  }
  await logAgentAction(lead.id, 'sequence_stopped', { detail: { reason: 'not_interested' }, decision: 'not_interested' });
}

async function handleWantsEstimate(lead, leadSeq, sender, incomingText, subject, conversationHistory, messageId) {
  await pool.query(
    `INSERT INTO pending_approvals (type, lead_id, payload, status) VALUES ('estimate', $1, $2, 'pending')`,
    [lead.id, JSON.stringify({ incomingMessage: incomingText, subject, inReplyTo: messageId || null })]
  );
  if (leadSeq) {
    await pool.query(
      `UPDATE lead_sequences SET status = 'waiting_estimate', paused_reason = 'estimate_requested', updated_at = NOW() WHERE id = $1`,
      [leadSeq.id]
    );
  }
  await logAgentAction(lead.id, 'estimate_flagged', { detail: { incomingMessage: incomingText }, decision: 'wants_estimate' });

  // Asking for an estimate is the funnel's win condition. The reply the lead is now
  // responding to is the approach that worked — pair it with whatever it was responding
  // to (the actual "situation -> good reply" lesson), not with this current message.
  const history = conversationHistory || [];
  const lastOutboundIdx = history.map(m => m.direction).lastIndexOf('out');
  if (lastOutboundIdx !== -1) {
    const lastOutbound = history[lastOutboundIdx];
    const precedingInbound = [...history.slice(0, lastOutboundIdx)].reverse().find(m => m.direction === 'in');
    await PlaybookService.captureWonExample({
      leadId: lead.id,
      context: precedingInbound ? precedingInbound.body : 'Initial cold outreach email (no prior reply from lead)',
      example: lastOutbound.body,
    });
  }

  await notifyOwner(
    sender,
    lead,
    'Action pending on dashboard',
    `${lead.hotel_name} asked for an estimate. Review and send it from the dashboard.`
  );
}

async function handleQuestion(lead, leadSeq, sender, incomingText, subject, conversationHistory, messageId) {
  const { fewShotExamples, notes } = await PlaybookService.getPlaybookContext();
  const result = await ReplyQualityService.draftAndScore({
    leadId: lead.id, lead, incomingMessage: incomingText, conversationHistory,
    playbookExamples: fewShotExamples, playbookNotes: notes,
  });
  await sendOrQueueReply({ lead, leadSeq, sender, result, subject, sentActionLabel: 'draft_sent', inReplyTo: messageId });
}

async function handleIncomingMessage(sender, { fromAddress, subject, text, messageId, date }) {
  if (!fromAddress || AUTO_REPLY_ADDRESS.test(fromAddress)) {
    console.log(`[ReplyWorker] Skipping non-lead sender ${fromAddress}`);
    return;
  }

  if (messageId) {
    const dupe = await pool.query('SELECT 1 FROM email_logs WHERE provider_message_id = $1', [messageId]);
    if (dupe.rows.length > 0) return;
  }

  const lead = await findLeadByEmail(fromAddress);
  if (!lead) {
    console.log(`[ReplyWorker] No matching lead for ${fromAddress} — skipping`);
    return;
  }

  const leadSeq = await getActiveLeadSequence(lead.id);
  const conversationHistory = await getConversationHistory(lead.id);

  await pool.query(
    `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, provider_message_id, sent_at)
     VALUES ($1, $2, $3, 'in', $4, $5, $6, $7)`,
    [lead.id, sender.id, leadSeq?.sequence_id || null, subject, text, messageId, date || new Date()]
  );

  const intent = await classifyIntent({ lead, incomingMessage: text, conversationHistory });
  await logAgentAction(lead.id, 'reply_analyzed', { detail: { intent, subject } });

  const replySubject = buildReplySubject(subject);

  switch (intent) {
    case 'not_interested':
      await handleNotInterested(lead, leadSeq);
      break;
    case 'wants_estimate':
      await handleWantsEstimate(lead, leadSeq, sender, text, subject, conversationHistory, messageId);
      break;
    case 'wants_portfolio':
      await PortfolioReplyService.sendPortfolioReply({
        lead, leadSeq, sender, incomingMessage: text, subject: replySubject, conversationHistory, inReplyTo: messageId,
      });
      break;
    case 'auto_reply':
      console.log(`[ReplyWorker] Auto-reply detected from lead ${lead.id} — ignoring`);
      break;
    case 'question':
    default:
      await handleQuestion(lead, leadSeq, sender, text, replySubject, conversationHistory, messageId);
      break;
  }

  console.log(`[ReplyWorker] Lead ${lead.id} reply classified as "${intent}"`);
}

function parseImapConfig(sender) {
  const cfg = typeof sender.imap_config === 'string' ? JSON.parse(sender.imap_config || '{}') : (sender.imap_config || {});
  return cfg.host ? cfg : null;
}

// We track a per-sender UID watermark (persisted in imap_config.lastUid) instead of
// filtering on the \Seen flag. \Seen is set by anything that opens the message — the
// owner checking a test reply in webmail, a preview pane, a phone notification fetch —
// which silently hid it from a seen:false search forever. A UID watermark only advances
// when *this worker* has actually processed a message, so it can't be stolen from us.
async function pollSenderMailbox(sender) {
  const cfg = parseImapConfig(sender);
  if (!cfg) return;

  const imapClient = new ImapFlow({
    host: cfg.host,
    port: cfg.port || 993,
    secure: cfg.secure ?? cfg.port !== 143,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  try {
    await imapClient.connect();
    const lock = await imapClient.getMailboxLock('INBOX');
    let maxUidSeen = cfg.lastUid || 0;
    try {
      const range = `${maxUidSeen + 1}:*`;
      for await (const message of imapClient.fetch(range, { source: true, envelope: true }, { uid: true })) {
        if (message.uid <= maxUidSeen) continue; // IMAP returns the last existing message when the range matches nothing new
        maxUidSeen = message.uid;
        try {
          if (!message.source) continue;

          const parsed = await simpleParser(message.source);
          const fromAddress = (parsed.from?.value?.[0]?.address || '').toLowerCase().trim();
          const subject = parsed.subject || '';
          const text = (parsed.text || '').trim();
          const messageId = parsed.messageId || null;
          const date = parsed.date || new Date();

          await handleIncomingMessage(sender, { fromAddress, subject, text, messageId, date });
        } catch (err) {
          console.error(`[ReplyWorker] Failed to process message uid=${message.uid} for sender ${sender.id}:`, err.message);
        }
      }
    } finally {
      lock.release();
    }
    await imapClient.logout();

    if (maxUidSeen > (cfg.lastUid || 0)) {
      await EmailSenderService.update(sender.id, { imap_config: { ...cfg, lastUid: maxUidSeen } });
    }
  } catch (err) {
    console.error(`[ReplyWorker] IMAP error for sender ${sender.id} (${sender.label}):`, err.message);
    try { await imapClient.close(); } catch { /* already closed */ }
  }
}

async function runReplyWorker() {
  if (isRunning) {
    console.log('[ReplyWorker] Previous run still in progress — skipping this tick');
    return;
  }
  isRunning = true;

  try {
    const senders = await EmailSenderService.getAll();
    const active = senders.filter(s => s.status === 'active');
    const pollable = active.filter(s => parseImapConfig(s));
    const skipped = active.filter(s => !parseImapConfig(s));
    if (skipped.length > 0) {
      console.warn(`[ReplyWorker] ${skipped.length} active sender(s) have no imap_config — replies to them will never be picked up: ${skipped.map(s => s.label).join(', ')}`);
    }
    if (pollable.length === 0) return;

    for (const sender of pollable) {
      await pollSenderMailbox(sender);
    }
  } catch (err) {
    console.error('[ReplyWorker] Error in reply worker:', err.message);
  } finally {
    isRunning = false;
  }
}

schedule.scheduleJob('*/3 * * * *', runReplyWorker);

console.log('📥 Email reply worker started - checks every 3 minutes');
