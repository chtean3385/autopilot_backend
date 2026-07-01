const OpenAI = require('openai');
const WABAService = require('./wabaService');
const pool = require('../config/db');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a friendly sales assistant for Dreams Technology, a hotel management & booking software company in India. You talk to hotel owners on WhatsApp to qualify them for a product demo.

Your goals:
1. Understand if they are the decision maker (owner/manager vs. staff)
2. Find out if they need hotel management or online booking software
3. Get them interested in a free demo

Rules:
- Keep replies SHORT — 1-3 sentences max. This is WhatsApp, not email.
- Be warm, conversational. Mix Hindi words naturally if they write in Hindi/Hinglish.
- Don't be pushy. Don't repeat their words back.
- After 3-4 exchanges, make a decision.
- NEVER mention you are an AI.

After your reply message, on a new line write exactly one of:
[CONTINUE] - still in conversation, need more exchanges
[QUALIFIED] - they want a demo or are clearly interested
[NOT_INTERESTED] - they said no, not relevant, wrong number, etc.`;

async function getConversationHistory(leadId) {
  const result = await pool.query(
    `SELECT
       message_type,
       message_text,
       response_text,
       sent_at
     FROM outreach_logs
     WHERE lead_id = $1
     ORDER BY sent_at ASC`,
    [leadId]
  );

  const messages = [];
  for (const row of result.rows) {
    // Outgoing template/reply we sent
    if (row.message_text) {
      messages.push({ role: 'assistant', content: row.message_text });
    }
    // Incoming reply from lead
    if (row.response_text) {
      messages.push({ role: 'user', content: row.response_text });
    }
  }
  return messages;
}

async function handleReply(lead, incomingText) {
  try {
    console.log(`[Agent] Processing reply from lead ${lead.id}: "${incomingText}"`);

    // Build conversation history
    const history = await getConversationHistory(lead.id);

    // Make sure the latest incoming message is at the end
    if (history.length === 0 || history[history.length - 1].content !== incomingText) {
      history.push({ role: 'user', content: incomingText });
    }

    // Call OpenAI
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + `\n\nLead info:\nHotel: ${lead.hotel_name}\nOwner: ${lead.owner_name}\nCity: ${lead.city}` },
        ...history,
      ],
    });

    const fullReply = response.choices[0].message.content.trim();

    // Parse out the status tag
    const tagMatch = fullReply.match(/\[(QUALIFIED|NOT_INTERESTED|CONTINUE)\]\s*$/m);
    const status = tagMatch ? tagMatch[1] : 'CONTINUE';
    const replyText = fullReply.replace(/\[(QUALIFIED|NOT_INTERESTED|CONTINUE)\]\s*$/m, '').trim();

    console.log(`[Agent] Reply to ${lead.hotel_name}: "${replyText}" [${status}]`);

    // Send the reply via WhatsApp
    const sendResult = await WABAService.sendTextMessage(lead.whatsapp_number, replyText);

    if (!sendResult.success) {
      console.error(`[Agent] Failed to send reply to ${lead.id}:`, sendResult.error);
      return;
    }

    // Log agent reply to outreach_logs
    await pool.query(
      `INSERT INTO outreach_logs (lead_id, campaign_id, template_id, waba_message_id, message_type, message_text, sent_at)
       SELECT $1, campaign_id, template_id, $2, 'reply', $3, NOW()
       FROM outreach_logs WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 1`,
      [lead.id, sendResult.messageId, replyText]
    );

    // Update lead status based on AI decision
    if (status === 'QUALIFIED') {
      await pool.query(
        `UPDATE hotel_leads SET status = 'demo_qualified', updated_at = NOW() WHERE id = $1`,
        [lead.id]
      );
      await notifyOwner(lead, incomingText);
      console.log(`[Agent] Lead ${lead.id} QUALIFIED — owner notified`);
    } else if (status === 'NOT_INTERESTED') {
      await pool.query(
        `UPDATE hotel_leads SET status = 'not_interested', updated_at = NOW() WHERE id = $1`,
        [lead.id]
      );
      console.log(`[Agent] Lead ${lead.id} marked NOT_INTERESTED`);
    }

  } catch (err) {
    console.error('[Agent] Error in handleReply:', err.message);
  }
}

async function notifyOwner(lead, lastMessage) {
  const ownerNumber = process.env.OWNER_WHATSAPP;
  if (!ownerNumber) {
    console.log('[Agent] OWNER_WHATSAPP not set — skipping personal notification');
    return;
  }

  const msg =
    `🎯 *New Qualified Lead!*\n\n` +
    `🏨 *${lead.hotel_name}*\n` +
    `👤 ${lead.owner_name}\n` +
    `📍 ${lead.city}\n` +
    `📱 ${lead.whatsapp_number}\n\n` +
    `💬 Their last message:\n"${lastMessage}"\n\n` +
    `Open CRM: https://resort.dreamstechnology.in`;

  await WABAService.sendTextMessage(ownerNumber, msg);
}

module.exports = { handleReply };
