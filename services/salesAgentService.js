const OpenAI = require('openai');
const pool = require('../config/db');
const WABAService = require('./wabaService');
const settingsService = require('./settingsService');
const { trackedCompletion } = require('../utils/aiUsage');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_INTENT = 'UNKNOWN';

function json(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function findCampaignContext(leadId) {
  const result = await pool.query(
    `SELECT c.*, hl.hotel_name, hl.owner_name, hl.city, hl.business_category, hl.source
     FROM hotel_leads hl
     LEFT JOIN outreach_logs ol ON ol.lead_id = hl.id AND ol.campaign_id IS NOT NULL
     LEFT JOIN campaigns c ON c.id = ol.campaign_id
     WHERE hl.id = $1 ORDER BY ol.sent_at DESC NULLS LAST LIMIT 1`, [leadId]
  );
  return result.rows[0] || null;
}

async function resolveAgent(leadId) {
  const context = await findCampaignContext(leadId);
  if (context?.agent_id) {
    const result = await pool.query(`SELECT * FROM sales_agents WHERE id = $1 AND active = TRUE AND channel = 'whatsapp'`, [context.agent_id]);
    if (result.rows[0]) return { agent: result.rows[0], campaign: context };
  }
  // No usable campaign lineage (no agent_id attached — including campaigns from before
  // sales_agents existed, which used to spin up a throwaway one-off agent here; we only ever
  // want the hand-configured agents, never an auto-created duplicate per campaign). Fall back to
  // a real agent — but ONLY one that actually fits: an industry match (business_category is a
  // free-text search term like "hotels or resorts", so this is a substring match, not exact), or
  // an agent explicitly marked generic (industry NULL/'All'). Never guess by handing a mismatched
  // lead to an unrelated industry-specific agent — a logistics company getting a hotel-specific
  // pitch is worse than the reply simply failing loudly and showing up for manual review.
  const fallback = await pool.query(
    `SELECT sa.* FROM sales_agents sa
     LEFT JOIN hotel_leads hl ON hl.id = $1
     WHERE sa.active = TRUE AND sa.auto_generated = FALSE AND sa.channel = 'whatsapp'
       AND (sa.industry IS NULL OR LOWER(sa.industry) = 'all'
            OR (sa.industry IS NOT NULL AND hl.business_category ILIKE '%' || sa.industry || '%'))
     ORDER BY (sa.industry IS NOT NULL AND LOWER(sa.industry) != 'all'
               AND hl.business_category ILIKE '%' || sa.industry || '%') DESC,
              sa.created_at ASC
     LIMIT 1`,
    [leadId]
  );
  if (fallback.rows[0]) return { agent: fallback.rows[0], campaign: context };
  return { agent: null, campaign: context };
}

async function getMemory(leadId, agentId) {
  const result = await pool.query(
    `SELECT * FROM conversation_memories WHERE lead_id = $1 AND agent_id IS NOT DISTINCT FROM $2 LIMIT 1`,
    [leadId, agentId]
  );
  return result.rows[0] || { lead_id: leadId, agent_id: agentId, current_stage: null, summary: null, lead_score: 0, pain_points: [], interested_features: [], objections: [], decision_maker: null, budget: null, timeline: null, next_objective: null };
}

async function getIntentRules(agentId) {
  const result = await pool.query(
    `SELECT intent, description, examples FROM agent_intent_rules
     WHERE active = TRUE AND (agent_id = $1 OR agent_id IS NULL)
     ORDER BY agent_id NULLS LAST, priority DESC, id ASC`, [agentId]
  );
  return result.rows;
}

async function detectIntent({ agent, leadId, message, memory }) {
  const rules = await getIntentRules(agent.id);
  if (!rules.length) return { intent: DEFAULT_INTENT, confidence: 0 };
  const choices = rules.map(r => `- ${r.intent}: ${r.description || 'No description'}${r.examples ? ` (examples: ${Array.isArray(r.examples) ? r.examples.join('; ') : r.examples})` : ''}`).join('\n');
  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini', max_tokens: 80, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `Classify this inbound B2B sales message. Return only JSON: {"intent":"one allowed value","confidence":0-1}.\nAllowed intents:\n${choices}\nUse ${DEFAULT_INTENT} when none fit. Do not draft a reply.` },
      { role: 'user', content: `Current stage: ${memory.current_stage || 'unqualified'}\nMessage: ${message}` },
    ],
  }, { purpose: 'sales_agent_intent', leadId });
  const parsed = json(response.choices[0].message.content, {});
  const allowed = new Set([...rules.map(r => r.intent), DEFAULT_INTENT]);
  return { intent: allowed.has(parsed.intent) ? parsed.intent : DEFAULT_INTENT, confidence: Number(parsed.confidence) || 0 };
}

async function getStage(agentId, memory, intent) {
  const result = await pool.query(
    `SELECT * FROM agent_stage_rules WHERE agent_id = $1 AND active = TRUE ORDER BY stage_order`, [agentId]
  );
  const stages = result.rows;
  if (!stages.length) return null;
  const current = stages.find(s => s.stage_key === memory.current_stage);
  if (current) return current;
  // First configured stage is the safe initial state; stage advancement is a structured model output.
  return stages[0];
}

async function getKnowledge(agentId, stageKey, intent) {
  const result = await pool.query(
    `SELECT title, content, tags FROM agent_knowledge
     WHERE agent_id = $1 AND active = TRUE
       AND (stage_keys IS NULL OR stage_keys::jsonb = '[]'::jsonb OR stage_keys::jsonb ? $2)
       AND (intent_keys IS NULL OR intent_keys::jsonb = '[]'::jsonb OR intent_keys::jsonb ? $3)
     ORDER BY priority DESC, id ASC LIMIT 12`, [agentId, stageKey || '', intent]);
  return result.rows;
}

function buildContext({ lead, campaign, memory, intent, stage, knowledge }) {
  const knowledgeText = knowledge.map(k => `- ${k.title}: ${k.content}`).join('\n') || 'No product knowledge is configured for this situation.';
  return `Campaign: ${campaign?.campaign_name || 'Unassigned'}\nIndustry: ${campaign?.business_type || lead.business_category || 'Unknown'}\nLead: ${lead.hotel_name || 'Unknown'}\nContact: ${lead.owner_name || 'Unknown'}\nSource: ${lead.source || 'Unknown'}\nDetected intent: ${intent}\nCurrent stage: ${stage?.stage_name || memory.current_stage || 'Unqualified'}\nCurrent objective: ${stage?.objective || memory.next_objective || 'Understand the lead and progress the sale'}\nPrevious structured summary: ${memory.summary || 'None'}\nKnown decision maker: ${memory.decision_maker || 'Unknown'}\nPain points: ${(memory.pain_points || []).join('; ') || 'Unknown'}\nObjections: ${(memory.objections || []).join('; ') || 'None'}\nBudget: ${memory.budget || 'Unknown'}\nTimeline: ${memory.timeline || 'Unknown'}\nRelevant knowledge:\n${knowledgeText}`;
}

function agentInstructions(agent) {
  return [
    agent.system_prompt,
    agent.sales_strategy,
    agent.qualification_logic,
    agent.demo_process,
    agent.closing_strategy,
    agent.product_knowledge && `Product knowledge:\n${agent.product_knowledge}`,
    agent.objection_handling && `Objection handling:\n${agent.objection_handling}`,
    agent.response_rules && `Response rules:\n${agent.response_rules}`,
  ].filter(Boolean).join('\n\n');
}

function normalizeIndianMobile(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? '91' + digits : null;
}

async function draftReply({ agent, lead, campaign, memory, intent, stage, knowledge, message }) {
  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini', max_tokens: 380, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${agentInstructions(agent)}\n\nYou are an experienced human B2B sales executive. Use only the supplied context and knowledge. Never mention AI. Keep the reply to 2-3 short sentences, ask at most one question, and move toward the current objective. Never answer a business's customer booking request; ask for the owner or operations manager instead.\n\nRedirect handling: if the contact tells you to reach someone else — a different phone number, another branch, or a head/main office — read carefully whether they gave you a phone number for that contact.\n- If they DID give a number for that other contact, set redirect_phone to it (digits, any format they used) and redirect_label to a short 2-4 word description of who it is (e.g. "Head Office", "Rajkot Branch", "Manager Direct"), and mention in your reply that you'll also reach out there.\n- If they mention another branch/head office/person but do NOT give a number, do not end the conversation — ask them for that contact's phone number in your reply, and leave redirect_phone/redirect_label null.\nOnly set redirect_phone when a real phone number is actually present in their message.\n\nReturn only JSON: {"reply":"...","status":"CONTINUE|WARM|COLD|QUALIFIED|NOT_INTERESTED","redirect_phone":"digits or null","redirect_label":"short label or null","memory":{"summary":"...","current_stage":"configured stage key or current key","lead_score":0-100,"pain_points":[],"interested_features":[],"decision_maker":"...","objections":[],"budget":"...","timeline":"...","next_objective":"..."}}` },
      { role: 'user', content: `${buildContext({ lead, campaign, memory, intent, stage, knowledge })}\n\nLatest inbound message: ${message}` },
    ],
  }, { purpose: 'sales_agent_reply', leadId: lead.id });
  const parsed = json(response.choices[0].message.content, {});
  const reply = String(parsed.reply || '').trim().replace(/\s+/g, ' ');
  if (!reply) throw new Error('Sales agent returned no reply');
  return {
    reply: reply.slice(0, 1000),
    status: ['CONTINUE', 'WARM', 'COLD', 'QUALIFIED', 'NOT_INTERESTED'].includes(parsed.status) ? parsed.status : 'CONTINUE',
    memory: parsed.memory || {},
    redirectPhone: normalizeIndianMobile(parsed.redirect_phone),
    redirectLabel: (parsed.redirect_label && String(parsed.redirect_label).trim().slice(0, 40)) || null,
  };
}

// A redirect ("call our head office on 9876543210") means a second decision-maker exists at a
// number that's never messaged us — WhatsApp only allows free-form replies within an existing
// customer-initiated session, so we can't just text them. Instead: create a new lead (same
// business, suffixed name so it's clearly linked) and kick it off the normal template-send path,
// same as any other first contact. Never touch the original conversation on failure.
async function handleRedirectContact(lead, redirectPhone, redirectLabel, campaign) {
  try {
    const existing = await pool.query('SELECT id FROM hotel_leads WHERE whatsapp_number = $1', [redirectPhone]);
    if (existing.rows.length > 0) return { created: false, reason: 'already exists' };

    const suffix = redirectLabel || 'Alt Contact';
    const newLead = await pool.query(
      `INSERT INTO hotel_leads (hotel_name, owner_name, whatsapp_number, city, source, status, channel, business_category)
       VALUES ($1, $2, $3, $4, 'agent_redirect', 'new', 'whatsapp', $5) RETURNING *`,
      [`${lead.hotel_name} (${suffix})`, lead.owner_name || '', redirectPhone, lead.city || '', lead.business_category || null]
    );
    const created = newLead.rows[0];

    const templateResult = await pool.query(
      campaign?.template_id
        ? `SELECT * FROM waba_templates WHERE id = $1 AND status = 'approved'`
        : `SELECT * FROM waba_templates WHERE status = 'approved' ORDER BY created_at DESC LIMIT 1`,
      campaign?.template_id ? [campaign.template_id] : []
    );
    const template = templateResult.rows[0];
    if (template) {
      const wabaResult = await WABAService.sendPersonalizedTemplate(created, template);
      if (wabaResult.success) {
        await pool.query(
          `INSERT INTO outreach_logs (lead_id, campaign_id, template_id, waba_message_id, message_type, sent_at)
           VALUES ($1, $2, $3, $4, 'template', NOW())`,
          [created.id, campaign?.id || null, template.id, wabaResult.messageId]
        );
      }
    }
    await logAgentAction(lead.id, 'whatsapp_redirect_lead_created', {
      detail: { new_lead_id: created.id, new_hotel_name: created.hotel_name, phone: redirectPhone, label: suffix },
      decision: 'created',
    });
    return { created: true, leadId: created.id };
  } catch (err) {
    console.error('[Agent] handleRedirectContact failed:', err.message);
    return { created: false, reason: err.message };
  }
}

async function saveMemory(leadId, agentId, update) {
  const clean = { ...update, pain_points: Array.isArray(update.pain_points) ? update.pain_points : [], interested_features: Array.isArray(update.interested_features) ? update.interested_features : [], objections: Array.isArray(update.objections) ? update.objections : [] };
  await pool.query(
    `INSERT INTO conversation_memories (lead_id, agent_id, summary, current_stage, lead_score, pain_points, interested_features, decision_maker, objections, budget, timeline, next_objective, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (lead_id, agent_id) DO UPDATE SET summary=EXCLUDED.summary, current_stage=EXCLUDED.current_stage, lead_score=EXCLUDED.lead_score, pain_points=EXCLUDED.pain_points, interested_features=EXCLUDED.interested_features, decision_maker=EXCLUDED.decision_maker, objections=EXCLUDED.objections, budget=EXCLUDED.budget, timeline=EXCLUDED.timeline, next_objective=EXCLUDED.next_objective, updated_at=NOW()`,
    [leadId, agentId, clean.summary || null, clean.current_stage || null, Number(clean.lead_score) || 0, JSON.stringify(clean.pain_points), JSON.stringify(clean.interested_features), clean.decision_maker || null, JSON.stringify(clean.objections), clean.budget || null, clean.timeline || null, clean.next_objective || null]
  );
}

// Mirrors the email pipeline's agent_actions logging (services/replyDeliveryService.js,
// workers/sequenceEmailWorker.js) so the Live Feed can show WhatsApp activity too, not just
// email. Never let a logging failure break the actual reply — this is purely observational.
async function logAgentAction(leadId, action, { detail, draftText, decision } = {}) {
  try {
    await pool.query(
      `INSERT INTO agent_actions (lead_id, action, detail, draft_text, decision) VALUES ($1,$2,$3,$4,$5)`,
      [leadId, action, detail ? JSON.stringify(detail) : null, draftText ?? null, decision ?? null]
    );
  } catch (err) {
    console.error('[Agent] logAgentAction failed:', err.message);
  }
}

async function notifyOwner(lead, lastMessage, reason = 'New qualified lead') {
  let phone = await settingsService.getSetting('OWNER_WHATSAPP');
  if (!phone) return;
  phone = phone.replace(/\D/g, ''); if (phone.length === 10) phone = `91${phone}`;
  await WABAService.sendTextMessage(phone, `${reason}: ${lead.hotel_name}\n${lead.owner_name || ''} ${lead.city || ''} · +${lead.whatsapp_number}\n\nLast message: ${lastMessage}`).catch(() => {});
}

async function markNeedsAttention(leadId, reason) {
  await pool.query(
    `UPDATE hotel_leads SET needs_attention = TRUE, needs_attention_reason = $1, updated_at = NOW() WHERE id = $2`,
    [reason, leadId]
  );
}

// Requests the bot has no business improvising an answer to — a callback or a portfolio are
// things only a human can actually deliver on WhatsApp (no calendar/booking action, no
// document-send capability here). Matched deterministically so this doesn't depend on the
// per-agent GPT intent rules being configured at all. Checked BEFORE the GPT reply draft so
// these leads never get another generic pitch instead of an answer to what they actually asked.
const CALLBACK_RE = /\bcall\s*(me|him|her|us|back)\b|\bcallback\b|\bplease\s*call\b|\bgive.*\bcall\b|\bcall\s*on\b/i;
const PORTFOLIO_RE = /\bportfolio\b|\bpast\s*work\b|\bprevious\s*work\b|\bcase\s*stud(y|ies)\b|\bsample\s*work\b|\bwork\s*samples?\b|\bexamples?\s*of\s*(your\s*)?work\b/i;

function detectHandoffReason(message) {
  if (CALLBACK_RE.test(message)) return 'Asked for a callback';
  if (PORTFOLIO_RE.test(message)) return 'Asked for portfolio';
  return null;
}

async function handleReply(lead, incomingText) {
  // Already flagged (callback/portfolio/qualified) — a human took this over, the bot stays
  // silent until they clear it from the Inbox "Needs Attention" tab. Re-checked fresh from the
  // DB rather than trusting the passed-in `lead` (webhook.js fetches it once per inbound message,
  // which can be stale if a flag was set moments earlier in the same burst).
  const fresh = await pool.query('SELECT needs_attention FROM hotel_leads WHERE id = $1', [lead.id]);
  if (fresh.rows[0]?.needs_attention) {
    await logAgentAction(lead.id, 'whatsapp_skipped_needs_attention', { detail: { message: incomingText }, decision: 'skipped' });
    return { skipped: true, reason: 'needs_attention' };
  }

  // Deterministic handoff — bypasses the GPT pitch entirely for these, so the lead gets an
  // honest holding reply instead of another "could you connect me with the owner" loop.
  const handoffReason = detectHandoffReason(incomingText);
  if (handoffReason) {
    await markNeedsAttention(lead.id, handoffReason);
    const holdingReply = handoffReason === 'Asked for a callback'
      ? "Thanks! I'll pass this to our team and someone will call you shortly."
      : "Thanks for asking! I'll have our team send that over to you directly.";
    const sent = await WABAService.sendTextMessage(lead.whatsapp_number, holdingReply);
    if (sent.success) {
      await pool.query(`INSERT INTO outreach_logs (lead_id, campaign_id, template_id, waba_message_id, message_type, message_text, sent_at)
        SELECT $1, campaign_id, template_id, $2, 'reply', $3, NOW() FROM outreach_logs WHERE lead_id=$1 ORDER BY sent_at DESC LIMIT 1`, [lead.id, sent.messageId, holdingReply]);
    }
    await logAgentAction(lead.id, 'whatsapp_needs_attention', { detail: { reason: handoffReason, message: incomingText }, draftText: holdingReply, decision: 'handoff' });
    await notifyOwner(lead, incomingText, handoffReason);
    return { skipped: false, handoff: true, reason: handoffReason };
  }

  const { agent, campaign } = await resolveAgent(lead.id);
  if (!agent) {
    // Don't leave the lead sitting at 'new'/'responded' — runFollowUps() treats those as
    // "still in play" and would keep re-sending the same (likely mismatched) template every
    // 2 days until the 6-touch cap, even though this reply already went unanswered. Surface
    // it for a human instead, per the no-guessing rule in resolveAgent() above.
    await pool.query(
      `UPDATE hotel_leads SET status='needs_review', updated_at=NOW() WHERE id=$1 AND status IN ('new', 'responded')`,
      [lead.id]
    );
    throw new Error('No sales agent is assigned to this campaign. Create an agent and assign it before enabling replies.');
  }
  const memory = await getMemory(lead.id, agent.id);
  const { intent } = await detectIntent({ agent, leadId: lead.id, message: incomingText, memory });
  if (intent === 'STOP') {
    await logAgentAction(lead.id, 'whatsapp_sequence_stopped', { detail: { reason: 'stop_intent' }, decision: 'stop' });
    return { skipped: true, reason: 'stop' };
  }
  const stage = await getStage(agent.id, memory, intent);
  const knowledge = await getKnowledge(agent.id, stage?.stage_key, intent);
  const result = await draftReply({ agent, lead, campaign, memory, intent, stage, knowledge, message: incomingText });
  const sent = await WABAService.sendTextMessage(lead.whatsapp_number, result.reply);
  if (!sent.success) throw new Error(sent.error || 'Could not send sales reply');
  await pool.query(`INSERT INTO outreach_logs (lead_id, campaign_id, template_id, waba_message_id, message_type, message_text, sent_at)
    SELECT $1, campaign_id, template_id, $2, 'reply', $3, NOW() FROM outreach_logs WHERE lead_id=$1 ORDER BY sent_at DESC LIMIT 1`, [lead.id, sent.messageId, result.reply]);
  await saveMemory(lead.id, agent.id, { ...memory, ...result.memory, current_stage: result.memory.current_stage || stage?.stage_key || memory.current_stage });
  await pool.query(`UPDATE outreach_logs SET lead_status_after=$1, qualified_for_demo=$2 WHERE id=(SELECT id FROM outreach_logs WHERE lead_id=$3 AND response_received=TRUE ORDER BY response_received_at DESC NULLS LAST LIMIT 1)`, [result.status.toLowerCase(), result.status === 'QUALIFIED', lead.id]);
  await logAgentAction(lead.id, 'whatsapp_reply_sent', { detail: { intent, stage: stage?.stage_key || null }, draftText: result.reply, decision: result.status.toLowerCase() });
  if (result.status === 'QUALIFIED') {
    await pool.query(`UPDATE hotel_leads SET status='demo_qualified', updated_at=NOW() WHERE id=$1`, [lead.id]);
    await markNeedsAttention(lead.id, 'Qualified for demo');
    await logAgentAction(lead.id, 'whatsapp_demo_qualified', { decision: 'qualified' });
    await notifyOwner(lead, incomingText, 'Qualified for demo');
  }
  if (result.status === 'NOT_INTERESTED') {
    await pool.query(`UPDATE hotel_leads SET status='not_interested', updated_at=NOW() WHERE id=$1`, [lead.id]);
    await logAgentAction(lead.id, 'whatsapp_not_interested', { decision: 'not_interested' });
  }
  if (result.redirectPhone) {
    await handleRedirectContact(lead, result.redirectPhone, result.redirectLabel, campaign);
  }
  return { ...result, intent, stage: stage?.stage_key || null };
}

module.exports = { handleReply, logAgentAction };
