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
    const result = await pool.query('SELECT * FROM sales_agents WHERE id = $1 AND active = TRUE', [context.agent_id]);
    if (result.rows[0]) return { agent: result.rows[0], campaign: context };
  }
  // Compatibility for campaigns created before sales_agents existed. The prompt still
  // comes from the database; new campaigns should always attach an agent_id.
  if (context?.system_prompt) {
    const migrated = await pool.query(
      `INSERT INTO sales_agents (name, industry, channel, system_prompt, active)
       VALUES ($1, $2, 'whatsapp', $3, TRUE) RETURNING *`,
      [`${context.campaign_name} agent`, context.business_type || context.business_category || null, context.system_prompt]
    );
    await pool.query('UPDATE campaigns SET agent_id = $1 WHERE id = $2 AND agent_id IS NULL', [migrated.rows[0].id, context.id]);
    return { agent: migrated.rows[0], campaign: { ...context, agent_id: migrated.rows[0].id } };
  }
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
       AND (stage_keys IS NULL OR stage_keys = '[]'::json OR stage_keys ? $2)
       AND (intent_keys IS NULL OR intent_keys = '[]'::json OR intent_keys ? $3)
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

async function draftReply({ agent, lead, campaign, memory, intent, stage, knowledge, message }) {
  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini', max_tokens: 380, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${agentInstructions(agent)}\n\nYou are an experienced human B2B sales executive. Use only the supplied context and knowledge. Never mention AI. Keep the reply to 2-3 short sentences, ask at most one question, and move toward the current objective. Never answer a business's customer booking request; ask for the owner or operations manager instead. Return only JSON: {"reply":"...","status":"CONTINUE|WARM|COLD|QUALIFIED|NOT_INTERESTED","memory":{"summary":"...","current_stage":"configured stage key or current key","lead_score":0-100,"pain_points":[],"interested_features":[],"decision_maker":"...","objections":[],"budget":"...","timeline":"...","next_objective":"..."}}` },
      { role: 'user', content: `${buildContext({ lead, campaign, memory, intent, stage, knowledge })}\n\nLatest inbound message: ${message}` },
    ],
  }, { purpose: 'sales_agent_reply', leadId: lead.id });
  const parsed = json(response.choices[0].message.content, {});
  const reply = String(parsed.reply || '').trim().replace(/\s+/g, ' ');
  if (!reply) throw new Error('Sales agent returned no reply');
  return { reply: reply.slice(0, 1000), status: ['CONTINUE', 'WARM', 'COLD', 'QUALIFIED', 'NOT_INTERESTED'].includes(parsed.status) ? parsed.status : 'CONTINUE', memory: parsed.memory || {} };
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

async function notifyOwner(lead, lastMessage) {
  let phone = await settingsService.getSetting('OWNER_WHATSAPP');
  if (!phone) return;
  phone = phone.replace(/\D/g, ''); if (phone.length === 10) phone = `91${phone}`;
  await WABAService.sendTextMessage(phone, `New qualified lead: ${lead.hotel_name}\n${lead.owner_name || ''} ${lead.city || ''}\n\nLast message: ${lastMessage}`).catch(() => {});
}

async function handleReply(lead, incomingText) {
  const { agent, campaign } = await resolveAgent(lead.id);
  if (!agent) throw new Error('No sales agent is assigned to this campaign. Create an agent and assign it before enabling replies.');
  const memory = await getMemory(lead.id, agent.id);
  const { intent } = await detectIntent({ agent, leadId: lead.id, message: incomingText, memory });
  if (intent === 'STOP') return { skipped: true, reason: 'stop' };
  const stage = await getStage(agent.id, memory, intent);
  const knowledge = await getKnowledge(agent.id, stage?.stage_key, intent);
  const result = await draftReply({ agent, lead, campaign, memory, intent, stage, knowledge, message: incomingText });
  const sent = await WABAService.sendTextMessage(lead.whatsapp_number, result.reply);
  if (!sent.success) throw new Error(sent.error || 'Could not send sales reply');
  await pool.query(`INSERT INTO outreach_logs (lead_id, campaign_id, template_id, waba_message_id, message_type, message_text, sent_at)
    SELECT $1, campaign_id, template_id, $2, 'reply', $3, NOW() FROM outreach_logs WHERE lead_id=$1 ORDER BY sent_at DESC LIMIT 1`, [lead.id, sent.messageId, result.reply]);
  await saveMemory(lead.id, agent.id, { ...memory, ...result.memory, current_stage: result.memory.current_stage || stage?.stage_key || memory.current_stage });
  await pool.query(`UPDATE outreach_logs SET lead_status_after=$1, qualified_for_demo=$2 WHERE id=(SELECT id FROM outreach_logs WHERE lead_id=$3 AND response_received=TRUE ORDER BY response_received_at DESC NULLS LAST LIMIT 1)`, [result.status.toLowerCase(), result.status === 'QUALIFIED', lead.id]);
  if (result.status === 'QUALIFIED') { await pool.query(`UPDATE hotel_leads SET status='demo_qualified', updated_at=NOW() WHERE id=$1`, [lead.id]); await notifyOwner(lead, incomingText); }
  if (result.status === 'NOT_INTERESTED') await pool.query(`UPDATE hotel_leads SET status='not_interested', updated_at=NOW() WHERE id=$1`, [lead.id]);
  return { ...result, intent, stage: stage?.stage_key || null };
}

module.exports = { handleReply };
