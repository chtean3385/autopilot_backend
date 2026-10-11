// Resort CRM pipeline, task 4 (_docs/resort-crm/plan.md): the "Dream Stay" WhatsApp sales agent that
// answers pipeline = 'resort_crm' leads (and only them — industry 'resort_crm' never matches a normal
// lead's business_category). Its knowledge comes from data/resort-crm-knowledge.md: one
// agent_knowledge row per "## " section.
//
// ensureAgent() runs on every boot and only CREATES the agent when it's missing, so edits made later in
// the Sales Agents page are never overwritten. syncKnowledge() (POST /api/resort-crm/agent/sync)
// replaces the knowledge rows from the file on purpose.
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const INDUSTRY = 'resort_crm';
const KNOWLEDGE_FILE = path.join(__dirname, '../data/resort-crm-knowledge.md');
// Sections the drafter must always see (getKnowledge returns at most 12, highest priority first).
const PRIORITY = { 'Rules for the agent': 100, 'Plans & modules (NO PRICES)': 90, 'Demo': 80, 'Who we are': 70, 'Screenshots': 60 };

const AGENT = {
  name: 'Dream Stay — Resort CRM',
  system_prompt: `You are Chetan from Dreams Technology, chatting on WhatsApp with a hotel/resort/guest-house owner who filled our Facebook/Instagram ad form for Dream Stay, our hotel & resort management software. They asked about it themselves — this is a warm conversation, not a cold pitch. Write like a real person typing on WhatsApp: short (1-3 sentences, max ~60 words), warm, simple English, no bullet lists, no "Dear Sir", at most one emoji. Use their first name only if you know it. If they write in Hindi or Hinglish, reply the same way.`,
  sales_strategy: `Goal of every conversation: a free live demo booked at a date and time the lead chooses. Answer their actual question first, using only the product knowledge, and connect it to their property (rooms, type, city, current software, timeline from their ad form). Then one easy next step — usually asking which date and time suits them for a 20-30 minute demo.`,
  qualification_logic: `Useful to learn naturally (never as a questionnaire): number of rooms, what they use today (register / Excel / other software), their biggest daily headache (bookings, billing/GST, OTAs, WhatsApp to guests, restaurant, Pathik in Gujarat), and when they want to start.`,
  demo_process: `The lead picks the date AND time. If they give only one, ask for the other. Once you have both, confirm it back in one short line (e.g. "Done — Thu 16 Oct, 4 pm. Chetan will call you then for the demo.") Never choose a time for them. Demos run roughly 10 am-7 pm IST, any day, by phone/Google Meet screen-share, in English, Hindi or Gujarati.`,
  closing_strategy: `Never discuss price. If asked about price, cost, plans or quote: "We have different modules, so we make a personalised estimate for your property — our team will share it with you. A quick demo helps us suggest the right setup — which day and time suits you?"`,
  objection_handling: `Already using software → ask what they use and what's missing, mention what we do well there, don't criticise competitors. "Not now / later" → respect it, ask if you can check back in a few weeks. "Too costly / budget" → no numbers; modules mean they pay only for what they need; offer the demo. "Not interested / stop" → thank them, stop.`,
  response_rules: `Never invent features, integrations, customers or numbers that aren't in the knowledge. Never give or hint at any price. Never mention the OTA Channel Manager. Never promise discounts, custom development or delivery dates. If unsure, say the team will confirm. Never repeat a message already sent.`,
};

const STAGES = [
  ['engage', 'Engage', 'Answer their question and learn about their property', 1],
  ['demo_ask', 'Ask for demo slot', 'Get a demo date and time they choose', 2],
  ['demo_booked', 'Demo booked', 'Demo confirmed — keep it light, answer questions, no new asks', 3],
];

// "## Title\nbody…" → [{ title, content }]
function parseKnowledge(markdown) {
  return markdown.split(/^## /m).slice(1).map((chunk) => {
    const [titleLine, ...rest] = chunk.split('\n');
    return { title: titleLine.trim(), content: rest.join('\n').trim() };
  }).filter((s) => s.title && s.content);
}

async function findAgent() {
  return (await pool.query(`SELECT * FROM sales_agents WHERE industry = $1 ORDER BY id LIMIT 1`, [INDUSTRY])).rows[0] || null;
}

async function syncKnowledge(agentId) {
  const sections = parseKnowledge(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM agent_knowledge WHERE agent_id = $1`, [agentId]);
    for (const s of sections) {
      const priority = PRIORITY[s.title] ?? PRIORITY[Object.keys(PRIORITY).find((k) => s.title.startsWith(k))] ?? 10;
      await client.query(
        `INSERT INTO agent_knowledge (agent_id, title, content, priority) VALUES ($1, $2, $3, $4)`,
        [agentId, s.title, s.content, priority]);
    }
    await client.query('COMMIT');
    return sections.length;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function ensureAgent() {
  const existing = await findAgent();
  if (existing) return { agent: existing, created: false };
  const a = AGENT;
  const agent = (await pool.query(
    `INSERT INTO sales_agents (name, industry, channel, system_prompt, sales_strategy, qualification_logic, demo_process,
       closing_strategy, objection_handling, response_rules, active, auto_generated)
     VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, $7, $8, $9, TRUE, FALSE) RETURNING *`,
    [a.name, INDUSTRY, a.system_prompt, a.sales_strategy, a.qualification_logic, a.demo_process,
     a.closing_strategy, a.objection_handling, a.response_rules])).rows[0];
  for (const [key, name, objective, order] of STAGES) {
    await pool.query(
      `INSERT INTO agent_stage_rules (agent_id, stage_key, stage_name, objective, stage_order) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`, [agent.id, key, name, objective, order]);
  }
  const sections = await syncKnowledge(agent.id);
  console.log(`[ResortCRM] Created sales agent "${agent.name}" (#${agent.id}) with ${sections} knowledge sections`);
  return { agent, created: true };
}

module.exports = { ensureAgent, syncKnowledge, findAgent, parseKnowledge, INDUSTRY };
