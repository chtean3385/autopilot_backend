// Resort CRM pipeline, tasks 7+8 (_docs/resort-crm/plan.md): what happens when a Dream Stay ad lead
// (hotel_leads.pipeline = 'resort_crm') replies on WhatsApp. Owner rules (2026-10-11):
//   - the AI answers questions itself, like a person, from data/resort-crm-knowledge.md — it does NOT
//     hand every question to a human the way the generic agent's safety gate does;
//   - the goal is a demo at a date + time the LEAD picks; once both are agreed the owner is alerted;
//   - never a price: price questions get the "personalised estimate" line, the owner is alerted;
//   - images: only the 3 real screenshots from the pricing page, at most one per reply, never twice.
//
// Reuses the generic agent's pieces: Dream Stay agent persona (resolveAgent), draftAndScore (draft →
// self-score → retry → queue for a human below the bar), tooSimilarToPrior (never repeat), owner alerts.
const OpenAI = require('openai');
const pool = require('../config/db');
const WABAService = require('./wabaService');
const ReplyQualityService = require('./replyQualityService');
const { trackedCompletion } = require('../utils/aiUsage');
const agentSvc = require('./salesAgentService');
const pipeline = require('./resortPipelineService');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Real screenshots (resort.dreamstechnology.in/pricing). The page's alt text swaps 01/02 — this is right.
const SCREENSHOTS = {
  dashboard: { url: 'https://resort.dreamstechnology.in/images/slider/slide-01.png', label: 'Dashboard', shows: "today's check-ins/check-outs, available and occupied rooms, today's and this month's revenue, pending payments, OTA imports, quick actions" },
  rooms: { url: 'https://resort.dreamstechnology.in/images/slider/slide-02.png', label: 'Room Management', shows: 'every room as a card: type, status (occupied/available/maintenance), rate per night, amenities' },
  bookings: { url: 'https://resort.dreamstechnology.in/images/slider/slide-03.png', label: 'Bookings', shows: 'all reservations: guest, room, dates, check-in status, payment status and amount, search and filters' },
};

const GATES = ['STOP', 'PRICE', 'HUMAN', 'UNSURE', 'CHAT'];

function istNow() {
  return new Date(Date.now() + 5.5 * 3600000); // read with getUTC* → IST wall clock
}
function istTodayText() {
  return istNow().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

async function json(messages, { leadId, purpose, maxTokens = 120 }) {
  const res = await trackedCompletion(client, {
    model: 'gpt-4o-mini', max_tokens: maxTokens, temperature: 0, response_format: { type: 'json_object' }, messages,
  }, { purpose, leadId });
  try { return JSON.parse(res.choices[0].message.content); } catch { return {}; }
}

// What to do with this message. Unlike the generic gate, questions and demo talk stay with the AI.
async function classify(lead, message, history) {
  const recent = history.slice(-8).map((t) => `${t.direction === 'in' ? 'Lead' : 'Us'}: ${t.body}`).join('\n');
  const out = await json([
    { role: 'system', content:
`A hotel/resort owner who filled our ad form for Dream Stay (hotel management software) replied on WhatsApp. Classify their LATEST message. Return only JSON {"gate":"ONE VALUE","reason":"3-6 words"}.
- STOP: a clear no — not interested, stop, don't message, wrong number, "close it"/"no" in answer to "should I close your enquiry?".
- PRICE: asks price, cost, charges, rates, plan cost, quotation, "how much", "kitna", budget numbers.
- HUMAN: something only a person can handle right now — urgent "call me now", a complaint, an existing customer needing support, partnership/reseller/job enquiries, custom development requests.
- UNSURE: you genuinely can't tell what they mean (gibberish, unknown language, only a sticker/emoji with no context).
- CHAT: everything else — questions about features, interest, a demo or call request, giving a date/time, "send details", "later", small talk, objections.` },
    { role: 'user', content: `${recent ? `Recent conversation:\n${recent}\n\n` : ''}Latest message: ${message}` },
  ], { leadId: lead.id, purpose: 'resort_reply_gate', maxTokens: 60 });
  return { gate: GATES.includes(out.gate) ? out.gate : 'UNSURE', reason: String(out.reason || '').slice(0, 80) };
}

// After the draft: did the lead (with our reply) settle a demo date AND time, and would one screenshot help?
async function extractTurn(lead, message, history, draft, sentImages) {
  const recent = history.slice(-8).map((t) => `${t.direction === 'in' ? 'Lead' : 'Us'}: ${t.body}`).join('\n');
  const available = Object.entries(SCREENSHOTS).filter(([k]) => !sentImages.includes(k))
    .map(([k, s]) => `- ${k}: ${s.shows}`).join('\n') || '(all already sent)';
  const out = await json([
    { role: 'system', content:
`Today is ${istTodayText()} (India time). Read a WhatsApp sales chat and return only JSON:
{"demo_agreed": true|false, "demo_date": "YYYY-MM-DD" or null, "demo_time": "HH:MM" (24h) or null, "demo_slot_text": "e.g. Thu 16 Oct, 4:00 pm" or null, "image": "one key or none"}
demo_agreed = true only if the LEAD has given (or clearly accepted) BOTH a specific day and a time for a demo/call. A day without a time, or "sometime next week", is false.
image: pick a screenshot key ONLY if the lead asked to see the software/screens, or asked about exactly what one of these shows, and it would genuinely help. Otherwise "none". Available:
${available}` },
    { role: 'user', content: `${recent ? `Conversation:\n${recent}\n\n` : ''}Lead's latest message: ${message}\n\nOur reply being sent now: ${draft}` },
  ], { leadId: lead.id, purpose: 'resort_reply_extract', maxTokens: 120 });
  const image = SCREENSHOTS[out.image] && !sentImages.includes(out.image) ? out.image : null;
  const agreed = Boolean(out.demo_agreed && out.demo_date && out.demo_time);
  let demoAt = null;
  if (agreed) {
    const d = new Date(`${out.demo_date}T${out.demo_time}:00+05:30`);
    demoAt = Number.isNaN(d.getTime()) ? null : d;
  }
  return { image, demo: agreed ? { slot: String(out.demo_slot_text || `${out.demo_date} ${out.demo_time}`).slice(0, 80), at: demoAt } : null };
}

async function allKnowledge(agentId) {
  return (await pool.query(
    `SELECT title, content FROM agent_knowledge WHERE agent_id = $1 AND active = TRUE ORDER BY priority DESC, id`, [agentId])).rows;
}

function formText(lead) {
  const f = (typeof lead.ad_form === 'string' ? JSON.parse(lead.ad_form) : lead.ad_form) || {};
  const say = (v) => (v ? String(v).replace(/_/g, ' ') : 'not answered');
  return `What they told us in the ad form: business type ${say(f.business_type)}; rooms ${say(f.rooms)}; uses hotel software today: ${say(f.uses_software)}; plans to start: ${say(f.timeline)}; wants a free demo: ${say(f.wants_demo)}${f.first_name ? `; first name ${f.first_name}` : ''}.`;
}

async function sentImageKeys(leadId) {
  const rows = (await pool.query(
    `SELECT message_text FROM outreach_logs WHERE lead_id = $1 AND message_type = 'image'`, [leadId])).rows;
  return Object.entries(SCREENSHOTS).filter(([, s]) => rows.some((r) => (r.message_text || '').includes(s.label))).map(([k]) => k);
}

async function logOut(leadId, type, messageId, text) {
  await pool.query(
    `INSERT INTO outreach_logs (lead_id, waba_message_id, message_type, message_text, sent_at) VALUES ($1, $2, $3, $4, NOW())`,
    [leadId, messageId, type, text]);
}

async function handleResortReply(lead, incomingText) {
  const fresh = (await pool.query('SELECT ai_paused FROM hotel_leads WHERE id = $1', [lead.id])).rows[0];
  if (fresh?.ai_paused) {
    await agentSvc.logAgentAction(lead.id, 'whatsapp_skipped_ai_paused', { detail: { message: incomingText }, decision: 'skipped' });
    return { skipped: true, reason: 'ai_paused' };
  }

  // Any reply ends the template sequence. First reply ever → tell the owner once (the AI is handling it).
  const state = (await pool.query('SELECT * FROM resort_pipeline WHERE lead_id = $1', [lead.id])).rows[0];
  const firstReply = !state || ['active', 'no_response'].includes(state.status);
  await pipeline.onReply(lead.id);

  const { agent } = await agentSvc.resolveAgent(lead.id);
  if (!agent) {
    await agentSvc.markNeedsAttention(lead.id, 'Dream Stay agent missing — needs manual reply', true);
    await agentSvc.notifyOwner(lead, incomingText, 'Dream Stay lead replied — no agent configured');
    return { handoff: true, reason: 'no_agent' };
  }

  const history = await agentSvc.getConversationHistory(lead.id);
  const priorOutbound = history.filter((t) => t.direction === 'out').map((t) => t.body);
  const { gate, reason } = await classify(lead, incomingText, history);

  if (gate === 'STOP') {
    await pool.query(`UPDATE hotel_leads SET status = 'not_interested', updated_at = NOW() WHERE id = $1`, [lead.id]);
    await pipeline.setState(lead.id, { status: 'stopped', stop_reason: 'not_interested' }).catch(() => {});
    await agentSvc.logAgentAction(lead.id, 'whatsapp_not_interested', { detail: { message: incomingText, reason }, decision: 'not_interested' });
    return { skipped: true, reason: 'not_interested' };
  }
  if (gate === 'UNSURE') {
    await agentSvc.markNeedsAttention(lead.id, 'AI could not understand — please reply');
    await agentSvc.logAgentAction(lead.id, 'whatsapp_unsure', { detail: { message: incomingText }, decision: 'queue_human' });
    await agentSvc.notifyOwner(lead, incomingText, 'Dream Stay lead — AI could not understand the reply');
    return { queued: true, reason: 'unsure' };
  }

  const memory = await agentSvc.getMemory(lead.id, agent.id);
  const knowledge = await allKnowledge(agent.id);
  const sentImages = await sentImageKeys(lead.id);
  const gateNote = {
    PRICE: `\n\nTHIS MESSAGE ASKS ABOUT PRICE. Do not give any number, range or plan price. Say we have different modules so we make a personalised estimate for their property and our team will share it, then ask which day and time suits them for a quick demo (skip that ask if a demo is already booked).`,
    HUMAN: `\n\nThis needs a person (${reason}). Reply in one or two warm sentences: acknowledge it and say Chetan will personally get back to them shortly. Do not promise anything else.`,
    CHAT: '',
  }[gate];
  const demoNote = state?.demo_slot
    ? `\n\nA demo is ALREADY BOOKED for ${state.demo_slot}. Don't ask for a slot again — answer their message; if they want to change it, ask for the new date and time.`
    : '';

  const extraContext =
    `${formText(lead)}\nToday is ${istTodayText()} (India time).` +
    `\n\nProduct knowledge — the ONLY facts you may state:\n${knowledge.map((k) => `### ${k.title}\n${k.content}`).join('\n\n')}` +
    `\n\nScreenshots we can attach separately (the system decides; you may say "sharing a screenshot" only if the lead asked to see the software): ${Object.values(SCREENSHOTS).map((s) => s.label).join(', ')}.` +
    gateNote + demoNote +
    `\n\nEVERY message already sent to this lead is below. NEVER repeat one or lightly reword it. If you have nothing new to say, return an empty "text":\n` +
    (priorOutbound.length ? priorOutbound.map((m) => `- ${m}`).join('\n') : '(none yet)');

  const result = await ReplyQualityService.draftAndScore({
    channel: 'whatsapp', leadId: lead.id, lead, agent, incomingMessage: incomingText, conversationHistory: history, extraContext,
  });
  const meta = result.meta || {};

  if (result.decision === 'queue_human') {
    await pool.query(`INSERT INTO pending_approvals (type, lead_id, payload) VALUES ('whatsapp_low_score_reply', $1, $2)`,
      [lead.id, JSON.stringify({ draftText: result.text, score: result.score })]);
    await agentSvc.markNeedsAttention(lead.id, `AI reply needs review (scored ${result.score}/5)`);
    await agentSvc.logAgentAction(lead.id, 'whatsapp_queued_for_review', { detail: { score: result.score, gate }, draftText: result.text, decision: 'queue_human' });
    await agentSvc.notifyOwner(lead, incomingText, 'Dream Stay lead — AI reply needs your review');
    return { queued: true, score: result.score };
  }
  if (!result.text?.trim() || agentSvc.tooSimilarToPrior(result.text, priorOutbound)) {
    await agentSvc.markNeedsAttention(lead.id, 'AI would only repeat itself — needs a human');
    await agentSvc.logAgentAction(lead.id, 'whatsapp_no_new_reply', { detail: { draft: result.text, gate }, decision: 'queue_human' });
    await agentSvc.notifyOwner(lead, incomingText, 'Dream Stay lead needs a human — AI has nothing new to add');
    return { queued: true, reason: 'would_repeat' };
  }

  const turn = await extractTurn(lead, incomingText, history, result.text, sentImages)
    .catch((e) => { console.error('[ResortReply] extract failed:', e.message); return { image: null, demo: null }; });

  const sent = await WABAService.sendTextMessage(lead.whatsapp_number, result.text);
  if (!sent.success) throw new Error(sent.error || 'Could not send Dream Stay reply');
  await logOut(lead.id, 'reply', sent.messageId, result.text);
  await agentSvc.saveMemory(lead.id, agent.id, { ...memory, ...meta.memory, current_stage: meta.memory?.current_stage || memory.current_stage || 'engage' });
  await agentSvc.logAgentAction(lead.id, 'whatsapp_reply_sent', { detail: { gate, pipeline: 'resort_crm', image: turn.image }, draftText: result.text, decision: gate.toLowerCase() });

  if (turn.image) {
    const shot = SCREENSHOTS[turn.image];
    const img = await WABAService.sendImageMessage(lead.whatsapp_number, shot.url, `Dream Stay — ${shot.label}`);
    if (img.success) await logOut(lead.id, 'image', img.messageId, `[Screenshot: ${shot.label}]`);
    else console.error('[ResortReply] image send failed:', img.error);
  }

  // Owner alerts: price, needs-a-person, a newly agreed demo slot, or the lead's first reply.
  let alertReason = null;
  if (turn.demo && turn.demo.slot !== state?.demo_slot) {
    await pool.query(
      `UPDATE resort_pipeline SET status = 'demo_booked', demo_slot = $2, demo_at = $3, updated_at = NOW() WHERE lead_id = $1`,
      [lead.id, turn.demo.slot, turn.demo.at]);
    await pool.query(`UPDATE hotel_leads SET status = 'demo_qualified', updated_at = NOW() WHERE id = $1`, [lead.id]);
    await agentSvc.markNeedsAttention(lead.id, `📅 Demo booked: ${turn.demo.slot}`);
    alertReason = `📅 Demo booked — ${turn.demo.slot}`;
  } else if (gate === 'PRICE') {
    await agentSvc.markNeedsAttention(lead.id, 'Asked for price — send a personalised estimate');
    alertReason = '💰 Asked for price — send a personalised estimate';
  } else if (gate === 'HUMAN') {
    await agentSvc.markNeedsAttention(lead.id, reason || 'Needs a person');
    alertReason = `🙋 Needs you: ${reason || 'asked for a person'}`;
  } else if (firstReply) {
    alertReason = 'Dream Stay lead replied — AI is chatting';
  }
  if (alertReason) {
    await agentSvc.logAgentAction(lead.id, 'whatsapp_handoff', { detail: { why: alertReason, gate }, decision: 'handoff' });
    await agentSvc.notifyOwner(lead, incomingText, alertReason);
  }
  return { sent: true, gate, image: turn.image, demo: turn.demo, text: result.text };
}

module.exports = { handleResortReply, classify, extractTurn, SCREENSHOTS };
