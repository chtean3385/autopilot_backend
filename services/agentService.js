const OpenAI = require('openai');
const WABAService = require('./wabaService');
const pool = require('../config/db');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildDefaultPrompt(businessCategory) {
  return `You are a friendly sales assistant for Dreams Technology, a business management software company in India. You are reaching out to ${businessCategory} owners on WhatsApp to understand their needs and qualify them for a free software demo.

Your goals:
1. Confirm they are the owner or decision maker (not a staff member)
2. Find out their current pain points — manual work, outdated systems, managing customers/records/billing
3. Get them interested in a free demo of our business management software

Rules:
- Keep replies SHORT — 1-3 sentences max. This is WhatsApp, not email.
- Be warm and conversational. Mix Hindi/Hinglish naturally if they write in Hindi.
- Don't be pushy. Don't repeat their words back to them.
- After 3-4 exchanges, make a final decision.
- NEVER mention you are an AI.

After your reply, on a new line write exactly one of:
[CONTINUE] - still in conversation, need more info
[QUALIFIED] - they want a demo or are clearly interested
[NOT_INTERESTED] - they said no, wrong number, not relevant, etc.`;
}

async function getCampaignSystemPrompt(leadId) {
  const result = await pool.query(
    `SELECT c.system_prompt, hl.business_category
     FROM hotel_leads hl
     LEFT JOIN outreach_logs ol ON ol.lead_id = hl.id AND ol.campaign_id IS NOT NULL
     LEFT JOIN campaigns c ON ol.campaign_id = c.id
     WHERE hl.id = $1
     ORDER BY ol.sent_at DESC
     LIMIT 1`,
    [leadId]
  );

  const row = result.rows[0];
  if (row?.system_prompt) return row.system_prompt;

  const cat = row?.business_category || 'businesses';
  return buildDefaultPrompt(cat);
}

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
    if (row.message_text) {
      messages.push({ role: 'assistant', content: row.message_text });
    }
    if (row.response_text) {
      messages.push({ role: 'user', content: row.response_text });
    }
  }
  return messages;
}

async function handleReply(lead, incomingText) {
  try {
    console.log(`[Agent] Processing reply from lead ${lead.id}: "${incomingText}"`);

    const [systemPrompt, history] = await Promise.all([
      getCampaignSystemPrompt(lead.id),
      getConversationHistory(lead.id),
    ]);

    if (history.length === 0 || history[history.length - 1].content !== incomingText) {
      history.push({ role: 'user', content: incomingText });
    }

    const leadContext = `\n\nLead info:\nBusiness: ${lead.hotel_name}\nOwner: ${lead.owner_name}\nCity: ${lead.city}${lead.business_category ? `\nCategory: ${lead.business_category}` : ''}`;

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt + leadContext },
        ...history,
      ],
    });

    const fullReply = response.choices[0].message.content.trim();

    const tagMatch = fullReply.match(/\[(QUALIFIED|NOT_INTERESTED|CONTINUE)\]\s*$/m);
    const status = tagMatch ? tagMatch[1] : 'CONTINUE';
    const replyText = fullReply.replace(/\[(QUALIFIED|NOT_INTERESTED|CONTINUE)\]\s*$/m, '').trim();

    console.log(`[Agent] Reply to ${lead.hotel_name}: "${replyText}" [${status}]`);

    const sendResult = await WABAService.sendTextMessage(lead.whatsapp_number, replyText);
    if (!sendResult.success) {
      console.error(`[Agent] Failed to send reply to ${lead.id}:`, sendResult.error);
      return;
    }

    await pool.query(
      `INSERT INTO outreach_logs (lead_id, campaign_id, template_id, waba_message_id, message_type, message_text, sent_at)
       SELECT $1, campaign_id, template_id, $2, 'reply', $3, NOW()
       FROM outreach_logs WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 1`,
      [lead.id, sendResult.messageId, replyText]
    );

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
  let ownerNumber = process.env.OWNER_WHATSAPP;
  if (!ownerNumber) {
    console.log('[Agent] OWNER_WHATSAPP not set — skipping personal notification');
    return;
  }
  ownerNumber = ownerNumber.replace(/\D/g, '');
  if (ownerNumber.length === 10) ownerNumber = '91' + ownerNumber;

  const businessLabel = lead.business_category
    ? `${lead.hotel_name} (${lead.business_category})`
    : lead.hotel_name;

  const msg =
    `🎯 *New Qualified Lead!*\n\n` +
    `🏢 *${businessLabel}*\n` +
    `👤 ${lead.owner_name}\n` +
    `📍 ${lead.city}\n` +
    `📱 ${lead.whatsapp_number}\n\n` +
    `💬 Their last message:\n"${lastMessage}"\n\n` +
    `Open CRM: https://resort.dreamstechnology.in`;

  await WABAService.sendTextMessage(ownerNumber, msg);
}

module.exports = { handleReply };
