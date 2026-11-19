const OpenAI = require('openai');
const pool = require('../config/db');
const WABAService = require('./wabaService');
const settingsService = require('./settingsService');
const { trackedCompletion } = require('../utils/aiUsage');
const ReplyQualityService = require('./replyQualityService');
const { alertOwner } = require('./ownerAlertService');

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
  // Pipeline leads (resort_crm = Meta-ad leads for our own hotel CRM) get their pipeline's agent and
  // nothing else — never a hotel-industry agent pitching something different. No agent → null (handoff).
  const pipeline = (await pool.query(`SELECT pipeline FROM hotel_leads WHERE id = $1`, [leadId])).rows[0]?.pipeline;
  if (pipeline) {
    const own = await pool.query(
      `SELECT * FROM sales_agents WHERE industry = $1 AND active = TRUE AND channel = 'whatsapp' ORDER BY id LIMIT 1`, [pipeline]);
    return { agent: own.rows[0] || null, campaign: context };
  }
  if (context?.agent_id) {
    const result = await pool.query(`SELECT * FROM sales_agents WHERE id = $1 AND active = TRUE AND channel = 'whatsapp'`, [context.agent_id]);
    const candidate = result.rows[0];
    if (candidate) {
      // Trust the campaign's assigned agent only if its industry (when it has one set) actually
      // fits this lead. Previously this returned unconditionally — a campaign wired to the wrong
      // agent (e.g. a hotel campaign attached to a generic "Website Growth Consultant" agent)
      // would keep pitching the wrong business on every reply forever, since nothing ever
      // re-checked it. A generic agent (industry NULL/'all') always fits; a specific one only
      // fits if it substring-matches the lead's own business_category. Mismatches fall through
      // to the industry-matched fallback below instead of being trusted blindly.
      const leadRow = await pool.query(`SELECT business_category FROM hotel_leads WHERE id = $1`, [leadId]);
      const businessCategory = leadRow.rows[0]?.business_category || '';
      const fits = !candidate.industry || candidate.industry.toLowerCase() === 'all'
        || businessCategory.toLowerCase().includes(candidate.industry.toLowerCase());
      if (fits) return { agent: candidate, campaign: context };
      console.warn(`[SalesAgent] Lead ${leadId} campaign agent "${candidate.name}" (industry: ${candidate.industry}) doesn't fit business_category "${businessCategory}" — falling back to industry match`);
    }
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
       AND COALESCE(sa.industry, '') <> 'resort_crm' -- pipeline agent: resort_crm leads only (above)
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

// Feeds draftAndScore's `extraContext` slot (buildLeadContext() from replyQualityService.js
// already covers Business/Owner/City/Category/Website, so this only adds what's WhatsApp/CRM
// specific: campaign, funnel stage, structured memory, and configured knowledge).
function buildContext({ lead, campaign, memory, intent, stage, knowledge, handoffReason }) {
  const knowledgeText = knowledge.map(k => `- ${k.title}: ${k.content}`).join('\n') || 'No product knowledge is configured for this situation.';
  // Replaces the old hardcoded canned-sentence handoff: the lead still gets a real, specific
  // acknowledgment of what they asked for, drafted (and quality-scored) like any other reply,
  // instead of one of two fixed strings — a human still has to actually place the callback or
  // send the portfolio, which markNeedsAttention() below still flags for.
  const handoffNote = handoffReason
    ? `\n\nIMPORTANT: this message was detected as: ${handoffReason}. Acknowledge specifically what they asked for, and let them know a team member will personally follow up with it directly — you cannot place a call or send a document yourself, so do not attempt to fulfill it, only acknowledge and reassure.`
    : '';
  return `Campaign: ${campaign?.campaign_name || 'Unassigned'}\nIndustry: ${campaign?.business_type || lead.business_category || 'Unknown'}\nDetected intent: ${intent}\nCurrent stage: ${stage?.stage_name || memory.current_stage || 'Unqualified'}\nCurrent objective: ${stage?.objective || memory.next_objective || 'Understand the lead and progress the sale'}\nPrevious structured summary: ${memory.summary || 'None'}\nKnown decision maker: ${memory.decision_maker || 'Unknown'}\nPain points: ${(memory.pain_points || []).join('; ') || 'Unknown'}\nObjections: ${(memory.objections || []).join('; ') || 'None'}\nBudget: ${memory.budget || 'Unknown'}\nTimeline: ${memory.timeline || 'Unknown'}\nRelevant knowledge:\n${knowledgeText}${handoffNote}`;
}

// Real conversation history instead of the compressed one-line memory summary — mirrors
// emailReplyWorker.js's getConversationHistory() but reads outreach_logs. Each row pairs one
// outbound send with the inbound reply that landed on it (webhook.js always attaches an inbound
// message to the most recently sent row), so out-then-in per row, ordered by sent_at, reconstructs
// the real back-and-forth. Template-type rows never get message_text populated (logOutreach() is
// called without text at every call site), so those fall back to the template's own body_text —
// not personalized, but enough for the model to see what was actually sent.
const HISTORY_LIMIT = 20;
async function getConversationHistory(leadId) {
  const result = await pool.query(
    `SELECT COALESCE(ol.message_text, wt.body_text) AS out_text,
            CASE WHEN ol.is_auto_reply THEN NULL ELSE ol.response_text END AS response_text
     FROM outreach_logs ol
     LEFT JOIN waba_templates wt ON wt.id = ol.template_id
     WHERE ol.lead_id = $1
     ORDER BY ol.sent_at ASC
     LIMIT $2`,
    [leadId, HISTORY_LIMIT]
  );
  const turns = [];
  for (const row of result.rows) {
    if (row.out_text) turns.push({ direction: 'out', body: row.out_text });
    if (row.response_text) turns.push({ direction: 'in', body: row.response_text });
  }
  return turns;
}

function normalizeIndianMobile(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? '91' + digits : null;
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
  // Goes through ownerAlertService, which sends an approved template (works any time)
  // and only falls back to free text when the owner is inside a 24h window.
  await alertOwner(
    reason,
    `${lead.hotel_name}${lead.city ? ' (' + lead.city + ')' : ''} · +${lead.whatsapp_number}\n"${String(lastMessage || '').slice(0, 160)}"`
  ).catch(() => {});
}

// pauseAi=true only when a human explicitly takes the lead over. A plain flag (pauseAi=false)
// surfaces the lead in the Needs Attention tab and pings the owner, but the AI keeps replying
// so the customer is never left waiting for a human who may be hours away.
async function markNeedsAttention(leadId, reason, pauseAi = false) {
  await pool.query(
    `UPDATE hotel_leads SET needs_attention = TRUE, needs_attention_reason = $1,
       ai_paused = ai_paused OR $2, updated_at = NOW() WHERE id = $3`,
    [reason, pauseAi, leadId]
  );
}

// Requests the bot has no business improvising an answer to — a callback or a portfolio are
// things only a human can actually deliver on WhatsApp (no calendar/booking action, no
// document-send capability here). Matched deterministically so this doesn't depend on the
// per-agent GPT intent rules being configured at all. Checked BEFORE the GPT reply draft so
// these leads never get another generic pitch instead of an answer to what they actually asked.
const CALLBACK_RE = /\bcall\s*(me|him|her|us|back)\b|\bcallback\b|\bplease\s*call\b|\bgive.*\bcall\b|\bcall\s*on\b/i;
const PORTFOLIO_RE = /\bportfolio\b|\bpast\s*work\b|\bprevious\s*work\b|\bcase\s*stud(y|ies)\b|\bsample\s*work\b|\bwork\s*samples?\b|\bexamples?\s*of\s*(your\s*)?work\b/i;
// Several live WABA templates end with a keyword CTA ("Reply INFO to receive our portfolio").
// A lead replying with just that keyword is asking for the portfolio just as much as someone
// typing the word "portfolio" — matched as a near-exact reply so it doesn't fire on "info"
// appearing inside an unrelated sentence.
const INFO_KEYWORD_RE = /^\s*info\s*[.!]?\s*$/i;

function detectHandoffReason(message) {
  if (CALLBACK_RE.test(message)) return 'Asked for a callback';
  if (PORTFOLIO_RE.test(message) || INFO_KEYWORD_RE.test(message)) return 'Asked for portfolio';
  return null;
}

// A business's own WhatsApp Business greeting/away bot ("Greetings from X", "Welcome to X",
// "Thank you for contacting X", a menu / "share these details" form). Owner rule 2026-11-19:
// these are never a real reply — never flag them, never answer them. The regex catches the
// obvious openers for free; the GPT gate's AUTO_REPLY catches the rest. A message that also
// says no/stop is left to the gate so an opt-out is never swallowed.
const AUTO_REPLY_RE = new RegExp([
  String.raw`\bgreetings\s+from\b`,
  String.raw`\bwelcome\s+to\s+(?!call|send|contact|share|visit|reach|message|whatsapp|email)`,
  String.raw`\bthanks?(\s+you)?\s+(so\s+much\s+)?for\s+(contacting|reaching\s+out|connecting\s+with|choosing|messaging|your\s+(message|enquiry|inquiry|interest))`,
  String.raw`\bwe\s+(have\s+)?received\s+your\s+(message|enquiry|inquiry|query)`,
  String.raw`\b(we|our\s+team|our\s+executive|someone)\s+(will|'ll|shall)\s+(get\s+back|contact\s+you|respond|reply|revert|connect\s+with\s+you)`,
  String.raw`\b(currently|presently)\s+(unavailable|closed|away|not\s+available|out\s+of\s+office)`,
  String.raw`\bthis\s+is\s+an?\s+(automated|auto[-\s]?generated|auto)\b`,
].join('|'), 'i');
const OPT_OUT_RE = /\b(not\s+interested|stop|unsubscribe|don'?t\s+(message|contact|call)|remove\s+(me|my\s+number))\b/i;
function looksLikeAutoReply(message) {
  const text = String(message || '');
  return AUTO_REPLY_RE.test(text) && !OPT_OUT_RE.test(text);
}

// Flags that were raised only because an auto-reply confused the old gate — cleared once we know
// the message was a bot, so the lead drops out of Needs Attention by itself.
const AUTO_REPLY_FLAG_REASONS = [
  'AI could not understand — please reply',
  'AI could not understand the reply',
  'AI would only repeat itself — needs a human',
  'AI has nothing new to add — needs a human',
];

// Marks the latest inbound on this lead as the business's auto-responder: hidden from the AI's
// history, not counted as unread, never a "reply" for follow-ups. webhook.js already moved the lead
// to 'responded'; undo that when this is the only kind of "reply" they've sent and we never
// answered them, so the normal follow-up cadence still reaches a human.
async function markAutoReply(leadId) {
  await pool.query(
    `UPDATE outreach_logs SET is_auto_reply = TRUE
     WHERE id = (SELECT id FROM outreach_logs WHERE lead_id = $1 AND response_received = TRUE
                 ORDER BY response_received_at DESC NULLS LAST LIMIT 1)`,
    [leadId]
  );
  await pool.query(
    `UPDATE hotel_leads SET status = 'new', updated_at = NOW()
     WHERE id = $1 AND status = 'responded'
       AND NOT EXISTS (SELECT 1 FROM outreach_logs r WHERE r.lead_id = $1 AND r.response_received = TRUE AND r.is_auto_reply IS NOT TRUE)
       AND NOT EXISTS (SELECT 1 FROM outreach_logs r WHERE r.lead_id = $1 AND r.message_type = 'reply')`,
    [leadId]
  );
  await pool.query(
    `UPDATE hotel_leads SET needs_attention = FALSE, needs_attention_reason = NULL, updated_at = NOW()
     WHERE id = $1 AND needs_attention = TRUE AND needs_attention_reason = ANY($2)`,
    [leadId, AUTO_REPLY_FLAG_REASONS]
  );
}

// Fixed, always-on safety gate — one cheap GPT call that decides what to DO with an inbound
// reply BEFORE any draft is attempted. Separate from detectIntent() (which classifies against
// the agent's own configured funnel intents for stage/knowledge selection); this rubric never
// depends on per-agent configuration. The AI still replies on HANDOFF — the customer is never
// left waiting — but the lead also surfaces for a human and the owner is pinged.
const REPLY_GATES = ['HANDOFF', 'NOT_INTERESTED', 'UNSURE', 'ROUTINE', 'AUTO_REPLY'];
// AUTO_REPLY (both channels): the business's own bot — email out-of-office, or a WhatsApp Business
// greeting/away message. Never flagged, never answered.
async function classifyReplyIntent({ lead, message, conversationHistory, channel = 'whatsapp' }) {
  if (looksLikeAutoReply(message)) return { gate: 'AUTO_REPLY', reason: 'business auto-responder' };
  const history = (conversationHistory || []).slice(-10)
    .map(t => `${t.direction === 'in' ? 'Lead' : 'Us'}: ${t.body}`).join('\n');
  const isEmail = channel === 'email';
  const autoReplyRule = isEmail
    ? '\n- AUTO_REPLY: an automated out-of-office / vacation / "we received your email" responder, not written by a person.'
    : '\n- AUTO_REPLY: the business\'s own WhatsApp Business auto-responder, not a person answering us. Typical: "Greetings from <business>", "Welcome to <business>", "Thank you for contacting us", "we will get back to you", an away/closed-hours notice, a menu of options or packages, a list of services/destinations/rooms, an address or business-hours card, or a form asking US to share name/city/dates/requirements. It does not respond to anything we actually said. Also AUTO_REPLY: a message that only advertises or describes THEIR OWN business (rooms, treatments, tours, offers, "100s of happy customers"), only gives their address/location, or only says "for booking/enquiry call <number>" — in any language (Hindi, Gujarati, etc.). Ask: did a person read our message and answer it? If not, AUTO_REPLY. When a message looks like a canned business greeting, brochure or contact card, pick AUTO_REPLY, never UNSURE or ROUTINE. A short human answer ("yes", "ok", a number, "who is this") is NOT AUTO_REPLY.';
  try {
    const res = await trackedCompletion(client, {
      model: 'gpt-4o-mini', max_tokens: 60, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content:
`Classify a B2B lead's latest ${isEmail ? 'email' : 'WhatsApp'} reply. Return only JSON: {"gate":"ONE VALUE","reason":"3-6 words"}.
- HANDOFF: shows buying interest, asks about price/quote/cost, asks to be called, wants a demo/meeting, asks for help or support, raises a problem or complaint, or asks something only a salesperson should answer. When unsure between HANDOFF and ROUTINE, pick HANDOFF.
- NOT_INTERESTED: a clear no — "not interested", "stop", "don't message me".
- UNSURE: unclear, gibberish, a wrong number, or a language you cannot read.
- ROUTINE: a simple question answerable from product knowledge, a mild objection, "who is this", "not right now", small talk.${autoReplyRule}` },
        { role: 'user', content: `Conversation so far:\n${history || '(none)'}\n\nLead's latest reply:\n${message}` },
      ],
    }, { purpose: 'sales_agent_reply_gate', leadId: lead.id });
    const parsed = json(res.choices[0].message.content, {});
    return {
      gate: REPLY_GATES.includes(parsed.gate) ? parsed.gate : 'UNSURE',
      reason: String(parsed.reason || '').slice(0, 60),
    };
  } catch (err) {
    console.error('[SalesAgent] classifyReplyIntent failed:', err.message);
    return { gate: 'UNSURE', reason: 'classifier error' };
  }
}

// Normalized comparison so the bot never re-sends a message it (or a template) already sent —
// catches exact repeats and light rewordings (~80%+ shared tokens).
function normalizeMsg(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function tooSimilarToPrior(candidate, priorOutbound) {
  const c = normalizeMsg(candidate);
  if (!c) return true;
  const cWords = new Set(c.split(' '));
  for (const prev of priorOutbound) {
    const p = normalizeMsg(prev);
    if (!p) continue;
    if (p === c) return true;
    const pWords = new Set(p.split(' '));
    const inter = [...cWords].filter(w => pWords.has(w)).length;
    const union = new Set([...cWords, ...pWords]).size;
    if (union > 0 && inter / union >= 0.8) return true;
  }
  return false;
}

async function handleReply(lead, incomingText) {
  // ai_paused = a human explicitly took this lead over from the Inbox. Only that silences the
  // bot — a plain needs_attention flag does NOT, so the customer keeps getting answers.
  // Re-read fresh (webhook.js's copy can be stale if a flag was set moments ago).
  const fresh = await pool.query('SELECT ai_paused FROM hotel_leads WHERE id = $1', [lead.id]);
  if (fresh.rows[0]?.ai_paused) {
    await logAgentAction(lead.id, 'whatsapp_skipped_ai_paused', { detail: { message: incomingText }, decision: 'skipped' });
    return { skipped: true, reason: 'ai_paused' };
  }

  const { agent, campaign } = await resolveAgent(lead.id);
  const conversationHistory = await getConversationHistory(lead.id);
  const priorOutbound = conversationHistory.filter(t => t.direction === 'out').map(t => t.body);

  if (!agent) {
    await pool.query(
      `UPDATE hotel_leads SET status='needs_review', updated_at=NOW() WHERE id=$1 AND status IN ('new','responded','no_response')`,
      [lead.id]
    );
    await markNeedsAttention(lead.id, 'No matching sales agent — needs manual review', true);
    await logAgentAction(lead.id, 'whatsapp_needs_attention', { detail: { reason: 'no_agent', message: incomingText }, decision: 'handoff' });
    await notifyOwner(lead, incomingText, 'No sales agent — needs manual review');
    return { skipped: false, handoff: true, reason: 'no_agent' };
  }

  // Safety gate first — buying signal / pricing / callback / help, or a message we can't
  // read, pulls in a human. The deterministic regex is a cheap pre-check for the obvious ones.
  // Auto-replies first: business bots often say "call us on …", which must not read as a callback request.
  const deterministicHandoff = looksLikeAutoReply(incomingText) ? null : detectHandoffReason(incomingText);
  const { gate, reason: gateReason } = deterministicHandoff
    ? { gate: 'HANDOFF', reason: deterministicHandoff }
    : await classifyReplyIntent({ lead, message: incomingText, conversationHistory });

  if (gate === 'AUTO_REPLY') {
    // Their WhatsApp Business bot, not a person: no flag, no owner ping, no reply to a bot.
    await markAutoReply(lead.id);
    await logAgentAction(lead.id, 'whatsapp_auto_reply_ignored', { detail: { message: String(incomingText).slice(0, 200), reason: gateReason }, decision: 'ignored' });
    return { skipped: true, reason: 'auto_reply' };
  }
  if (gate === 'NOT_INTERESTED') {
    await pool.query(`UPDATE hotel_leads SET status='not_interested', updated_at=NOW() WHERE id=$1`, [lead.id]);
    await logAgentAction(lead.id, 'whatsapp_not_interested', { detail: { message: incomingText }, decision: 'not_interested' });
    return { skipped: true, reason: 'not_interested' };
  }
  if (gate === 'UNSURE') {
    // Don't guess. Say nothing this turn, flag for a human, ping the owner.
    await markNeedsAttention(lead.id, 'AI could not understand — please reply');
    await logAgentAction(lead.id, 'whatsapp_unsure', { detail: { message: incomingText }, decision: 'queue_human' });
    await notifyOwner(lead, incomingText, 'Lead reply the AI could not understand');
    return { skipped: false, queued: true, reason: 'unsure' };
  }

  const memory = await getMemory(lead.id, agent.id);
  const { intent } = await detectIntent({ agent, leadId: lead.id, message: incomingText, memory });
  if (intent === 'STOP') {
    await pool.query(`UPDATE hotel_leads SET status='not_interested', updated_at=NOW() WHERE id=$1`, [lead.id]);
    await logAgentAction(lead.id, 'whatsapp_sequence_stopped', { detail: { reason: 'stop_intent' }, decision: 'stop' });
    return { skipped: true, reason: 'stop' };
  }
  const stage = await getStage(agent.id, memory, intent);
  const knowledge = await getKnowledge(agent.id, stage?.stage_key, intent);
  // On HANDOFF the AI still replies (so the lead isn't left waiting) but must stay in its
  // lane: acknowledge, promise a personal follow-up, don't quote prices or commit to anything.
  const handoffGuard = gate === 'HANDOFF'
    ? `\n\nThis lead asked for something a human teammate will handle personally (pricing, a call, a demo, or support). Reply warmly in 1-2 sentences: acknowledge exactly what they asked, and tell them a team member will personally follow up with them very shortly. Answer only what is factually in the knowledge above. Do NOT quote prices, discounts, or timelines, and do NOT promise anything specific.`
    : '';
  const extraContext = buildContext({ lead, campaign, memory, intent, stage, knowledge, handoffReason: null })
    + handoffGuard
    + `\n\nEVERY message already sent to this lead is below. NEVER repeat one or lightly reword it. `
    + `If everything worth saying has already been said, return an empty string for "text" and we will bring in a human:\n`
    + (priorOutbound.length ? priorOutbound.map(m => `- ${m}`).join('\n') : '(none yet)');

  const result = await ReplyQualityService.draftAndScore({
    channel: 'whatsapp', leadId: lead.id, lead, agent,
    incomingMessage: incomingText, conversationHistory, extraContext,
  });
  const meta = result.meta || {};

  if (result.decision === 'queue_human') {
    await pool.query(
      `INSERT INTO pending_approvals (type, lead_id, payload) VALUES ('whatsapp_low_score_reply', $1, $2)`,
      [lead.id, JSON.stringify({ draftText: result.text, score: result.score })]
    );
    await markNeedsAttention(lead.id, `AI reply needs review (scored ${result.score}/5)`);
    await logAgentAction(lead.id, 'whatsapp_queued_for_review', { detail: { score: result.score, intent, gate }, draftText: result.text, decision: 'queue_human' });
    await notifyOwner(lead, incomingText, 'AI reply needs your review before sending');
    return { skipped: false, queued: true, score: result.score };
  }

  // Never send a repeat, a reword, or an empty reply — flag for a human instead of annoying the lead.
  if (!result.text?.trim() || tooSimilarToPrior(result.text, priorOutbound)) {
    await markNeedsAttention(lead.id, 'AI would only repeat itself — needs a human');
    await logAgentAction(lead.id, 'whatsapp_no_new_reply', { detail: { draft: result.text, intent, gate }, decision: 'queue_human' });
    await notifyOwner(lead, incomingText, 'Conversation needs a human — AI has nothing new to add');
    return { skipped: false, queued: true, reason: 'would_repeat' };
  }

  const sent = await WABAService.sendTextMessage(lead.whatsapp_number, result.text);
  if (sent.windowClosed) {
    // Their last message is >24h old (e.g. a reply processed late after an outage): Meta only allows an
    // approved template now, so a free-form reply would fail with 131047. Hand it to a human instead.
    await markNeedsAttention(lead.id, 'Replied over 24h ago — WhatsApp only allows a template now; reply when they write again or send a template');
    await logAgentAction(lead.id, 'whatsapp_window_closed', { detail: { intent, gate }, draftText: result.text, decision: 'queue_human' });
    await notifyOwner(lead, incomingText, 'Reply not sent — their 24h WhatsApp window has closed');
    return { skipped: false, queued: true, reason: 'window_closed' };
  }
  if (!sent.success) throw new Error(sent.error || 'Could not send sales reply');
  await pool.query(`INSERT INTO outreach_logs (lead_id, campaign_id, template_id, waba_message_id, message_type, message_text, sent_at)
    SELECT $1, campaign_id, template_id, $2, 'reply', $3, NOW() FROM outreach_logs WHERE lead_id=$1 ORDER BY sent_at DESC LIMIT 1`, [lead.id, sent.messageId, result.text]);
  await saveMemory(lead.id, agent.id, { ...memory, ...meta.memory, current_stage: meta.memory?.current_stage || stage?.stage_key || memory.current_stage });
  await pool.query(`UPDATE outreach_logs SET lead_status_after=$1, qualified_for_demo=$2 WHERE id=(SELECT id FROM outreach_logs WHERE lead_id=$3 AND response_received=TRUE ORDER BY response_received_at DESC NULLS LAST LIMIT 1)`, [(meta.status || 'continue').toLowerCase(), meta.status === 'QUALIFIED', lead.id]);
  await logAgentAction(lead.id, 'whatsapp_reply_sent', { detail: { intent, gate, stage: stage?.stage_key || null }, draftText: result.text, decision: (meta.status || 'continue').toLowerCase() });

  // The AI replied (customer isn't waiting). Now surface the lead for a human where warranted —
  // the gate's HANDOFF, or the drafter's own WARM/QUALIFIED read. AI stays live in all these
  // cases; only a human clicking "Take over" pauses it.
  if (gate === 'HANDOFF' || meta.status === 'QUALIFIED' || meta.status === 'WARM') {
    const why = gate === 'HANDOFF' ? (gateReason || 'Needs a human')
      : meta.status === 'QUALIFIED' ? 'Qualified for demo' : 'Lead showing interest';
    await markNeedsAttention(lead.id, why);
    if (meta.status === 'QUALIFIED') await pool.query(`UPDATE hotel_leads SET status='demo_qualified', updated_at=NOW() WHERE id=$1`, [lead.id]);
    await logAgentAction(lead.id, 'whatsapp_handoff', { detail: { why, gate, status: meta.status }, decision: 'handoff' });
    await notifyOwner(lead, incomingText, why);
  }
  if (meta.status === 'NOT_INTERESTED') {
    await pool.query(`UPDATE hotel_leads SET status='not_interested', updated_at=NOW() WHERE id=$1`, [lead.id]);
    await logAgentAction(lead.id, 'whatsapp_not_interested', { decision: 'not_interested' });
  }
  if (meta.redirectPhone) {
    const normalizedRedirect = normalizeIndianMobile(meta.redirectPhone);
    if (normalizedRedirect) await handleRedirectContact(lead, normalizedRedirect, meta.redirectLabel, campaign);
  }
  return { ...result, meta, intent, gate, stage: stage?.stage_key || null };
}

module.exports = {
  handleReply, logAgentAction, resolveAgent,
  // Reused by resortReplyService.js (Dream Stay ad leads).
  markNeedsAttention, notifyOwner, getMemory, saveMemory,
  // Reused by cadenceReplyService.js (directory leads) — same gate, same never-repeat check.
  classifyReplyIntent, tooSimilarToPrior, detectHandoffReason, getConversationHistory,
  looksLikeAutoReply, markAutoReply,
};
