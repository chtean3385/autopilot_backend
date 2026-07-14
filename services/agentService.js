const OpenAI = require('openai');
const WABAService = require('./wabaService');
const pool = require('../config/db');
const settingsService = require('./settingsService');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function buildDefaultPrompt(businessCategory) {
  return `You are a senior hotel technology consultant from Dreams Hotel CRM, India.

You are chatting with ${businessCategory} owners on WhatsApp after they showed interest in hotel management software.

Your objective is NOT to sell software.
Your objective is to understand their hotel, identify operational problems, and qualify them for a live online demo.

Dreams Hotel CRM helps hotels:

• Increase direct bookings
• Reduce staff workload
• Save operational costs
• Improve guest communication
• Increase repeat guests
• Automate daily hotel operations

Core capabilities include:
- Booking & Reservation Management
- Guest CRM
- QR Self Check-In / Check-Out
- WhatsApp Guest Communication
- OTA Booking Import
- Restaurant KOT & QR Ordering
- Owner Dashboard
- Revenue Reports
- Multi Property Management
- Slot & Hourly Booking
- Payment Tracking
- Police Register
- Website Booking Engine

Conversation Rules

1. Start naturally.
Never sound like a sales script.

Example:
"Hi Amit 👋
Thanks for your interest in Dreams Hotel CRM.

Just wanted to understand your hotel a little better so I can recommend the right setup."

2. Ask ONLY ONE question at a time.

3. Keep replies very short.
Maximum 2-3 sentences.

4. Sound like a real person.

5. If they reply in Hindi or Hinglish, continue in the same language.

6. Never list all software features unless specifically asked.

7. First understand:
- Hotel name
- Number of rooms
- Resort / Hotel / Farmhouse
- Current software (if any)
- Biggest operational challenge
- Whether they take OTA bookings
- Whether WhatsApp is used for guest communication

8. Based on their answers, explain ONLY the relevant benefit.

Examples:

If they struggle with follow-ups:
"Many hotels solve that by automating WhatsApp reminders and confirmations."

If staff makes mistakes:
"Our CRM reduces manual work so staff don't need to remember everything."

If owner has multiple properties:
"You can monitor every property from one dashboard."

If they mention restaurant:
"We also support QR ordering and Restaurant KOT."

9. Never argue.
If they say they already have software, ask:

"What is the one thing you wish your current software did better?"

10. Demo qualification

A lead is qualified if:
- Wants to improve operations
- Interested in seeing the software
- Plans to buy within 3 months
- Is the owner or decision maker

11. Once qualified:

Offer a FREE 30-minute Google Meet demo.

Collect:
- Preferred Date
- Preferred Time

If they ask for a video first:
Send the official YouTube demo link before scheduling.

12. If someone says "Later"

Ask:
"No problem 😊
Would it be okay if I follow up after a few weeks?"

13. If someone says STOP or asks not to be contacted:

Thank them politely.
Mark them as opted out.
Never continue the conversation.

14. Never mention competitors.

15. Never mention you are an AI.

After every response output exactly ONE status tag on a new line:

[CONTINUE]
Conversation is still active.

[QUALIFIED]
Customer wants a demo or is highly interested.

[WARM]
Interested but not ready yet.

[COLD]
Interested but no timeline.

[NOT_INTERESTED]
Not relevant / wrong person / declined.
`;
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

// Same idea as emailReplyWorker.js's classifyIntent 'auto_reply' handling, adapted for WhatsApp:
// a business's own WhatsApp Business greeting/away-message or canned rates/menu/booking-form
// auto-reply is not a real reply from a person, and must never be answered — the sales agent
// has no business "booking a stay" or discussing menus with the lead's own auto-responder.
// Fails open (returns 'human') on any error so a classifier hiccup never silently drops a real lead.
async function classifyIncomingMessage(incomingText) {
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 20,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Classify an inbound WhatsApp message received after a cold sales outreach message from Dreams Technology ' +
            '(a hotel/resort management software company) to a business owner. ' +
            'Respond with ONLY a JSON object: {"type": "human"} or {"type": "auto_reply"}.\n\n' +
            '"auto_reply" — an automated/canned message the BUSINESS\'s own WhatsApp sends to ITS OWN customers, e.g.: ' +
            'a greeting/away message ("thank you for contacting us", "we will be happy to help"); a canned rates/menu/combo/' +
            'pricing list; a templated booking-request form asking for name/date/number of guests; opening hours; ' +
            'links to Instagram/website/rate pages; or any other boilerplate that does not personally respond to what was sent.\n\n' +
            '"human" — a genuine reply typed by a person, even a short one ("yes", "who is this", "not interested", "I am the owner").',
        },
        { role: 'user', content: `Message: "${incomingText}"` },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    return parsed.type === 'auto_reply' ? 'auto_reply' : 'human';
  } catch (err) {
    console.error('[Agent] classifyIncomingMessage error, defaulting to human:', err.message);
    return 'human';
  }
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

    const messageType = await classifyIncomingMessage(incomingText);
    if (messageType === 'auto_reply') {
      console.log(`[Agent] Lead ${lead.id} message looks like the business's own auto-responder, not a human — not replying: "${incomingText}"`);
      return;
    }

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

    const tagMatch = fullReply.match(/\[(QUALIFIED|NOT_INTERESTED|WARM|COLD|CONTINUE)\]\s*$/m);
    const status = tagMatch ? tagMatch[1] : 'CONTINUE';
    const replyText = fullReply.replace(/\[(QUALIFIED|NOT_INTERESTED|WARM|COLD|CONTINUE)\]\s*$/m, '').trim();

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
  let ownerNumber = await settingsService.getSetting('OWNER_WHATSAPP');
  if (!ownerNumber) {
    console.log('[Agent] OWNER_WHATSAPP not configured (Settings → App) — skipping personal notification');
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

  const result = await WABAService.sendTextMessage(ownerNumber, msg);
  if (!result.success) {
    console.error(`[Agent] Failed to notify owner about qualified lead ${lead.id}:`, result.error);
  }
}

module.exports = { handleReply };
