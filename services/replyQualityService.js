const OpenAI = require('openai');
const pool = require('../config/db');
const { trackedCompletion } = require('../utils/aiUsage');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SCORE_THRESHOLD = 4;
const MAX_ATTEMPTS = 3; // 1 draft + up to 2 revisions
const COLD_EMAIL_SCORE_THRESHOLD = 4;

// context: { leadId, lead: {hotel_name, owner_name, city, business_category, website},
//            incomingMessage, conversationHistory: [{direction:'in'|'out', subject, body}],
//            playbookExamples: [{context, example}] }
function buildLeadContext(lead) {
  if (!lead) return '';
  return `Business: ${lead.hotel_name || 'Unknown'}\nOwner: ${lead.owner_name || 'Unknown'}\nCity: ${lead.city || 'Unknown'}${lead.business_category ? `\nCategory: ${lead.business_category}` : ''}${lead.website ? `\nWebsite: ${lead.website}` : ''}`;
}

function buildHistoryText(conversationHistory) {
  if (!conversationHistory?.length) return '';
  return conversationHistory
    .map(m => `[${m.direction === 'in' ? 'Lead' : 'Us'}]${m.subject ? ` ${m.subject}: ` : ' '}${m.body}`)
    .join('\n\n');
}

function buildPlaybookText(playbookExamples) {
  if (!playbookExamples?.length) return '';
  return '\n\nExamples of replies that worked well in similar situations:\n' +
    playbookExamples.map(ex => `- Context: ${ex.context}\n  Reply: ${ex.example}`).join('\n');
}

function buildPlaybookNotesText(playbookNotes) {
  if (!playbookNotes?.length) return '';
  return '\n\nLessons from past owner corrections and weekly reviews:\n' +
    playbookNotes.map(note => `- ${note}`).join('\n');
}

function buildPortfolioText(portfolioItems) {
  if (!portfolioItems?.length) return '';
  return '\n\nThe lead asked to see past work — weave in a couple of these naturally:\n' +
    portfolioItems.map(p => `- ${p.title}${p.url ? ` (${p.url})` : ''}${p.description ? `: ${p.description}` : ''}`).join('\n');
}

function buildServiceContextText(serviceContext) {
  if (!serviceContext) return '';
  return `\n\nBackground on what Dreams Technology offers (from our own website — use only if relevant, don't quote verbatim):\n${serviceContext}`;
}

// Mirrors salesAgentService.js's agentInstructions() — same idea, same fields, so an agent
// configured once (Manage -> Sales Agents) reads consistently whether it's driving WhatsApp
// or email replies.
function buildAgentPersonaText(agent) {
  if (!agent) return '';
  const parts = [
    agent.system_prompt,
    agent.sales_strategy,
    agent.qualification_logic,
    agent.demo_process,
    agent.closing_strategy,
    agent.product_knowledge && `Product knowledge:\n${agent.product_knowledge}`,
    agent.objection_handling && `Objection handling:\n${agent.objection_handling}`,
    agent.response_rules && `Response rules:\n${agent.response_rules}`,
  ].filter(Boolean).join('\n\n');
  return `\n\n${parts}`;
}

// channel: 'email' (default) | 'whatsapp'. WhatsApp needs shorter replies, no HTML paragraphing,
// and its own status/redirect-contact tracking fields — everything else (portfolio, playbook
// examples/notes, revision feedback, agent persona) is channel-agnostic and layers on top either way.
function buildDraftSystemPrompt(playbookExamples, revisionFeedback, portfolioItems, serviceContext, playbookNotes, agent, channel) {
  const isWhatsapp = channel === 'whatsapp';
  const revisionNote = revisionFeedback
    ? `\n\nA previous draft scored too low on quality review. Feedback to address: "${revisionFeedback}". Write an improved reply.`
    : '';
  const conversationLabel = isWhatsapp ? 'WhatsApp conversation' : 'email conversation';
  const lengthRule = isWhatsapp ? 'Keep the reply to 2-3 short sentences and ask at most one question.' : 'Respond in 3-6 sentences unless the agent instructions below say otherwise.';

  // With an agent assigned, its own persona/strategy fully replaces the generic intro (same
  // agent-owns-its-persona principle across channels) -- everything else (portfolio, playbook
  // examples/notes, revision feedback) still layers on top since those are lead-specific
  // context, not persona.
  const intro = agent
    ? `You are replying to an inbound message from a lead in an ongoing ${conversationLabel}. ${lengthRule} Never mention you are an AI.${buildAgentPersonaText(agent)}`
    : `You are a sales assistant for Dreams Technology, a business management software company in India, replying to an inbound message from a lead in an ongoing ${conversationLabel}.

Goals:
- Be warm, professional, and concise${isWhatsapp ? ' (2-3 short sentences, at most one question)' : ' (3-6 sentences)'}.
- Directly address what the lead said or asked — do not ignore it or repeat a generic pitch.
- Where natural, move the conversation toward a free demo of our business management software, without being pushy.
- Never fabricate facts about the recipient's business or about Dreams Technology beyond what's given below.
- Never mention you are an AI.`;

  const whatsappNote = isWhatsapp
    ? `\n\nAlso track the conversation status. Redirect handling: if the contact tells you to reach someone else — a different phone number, another branch, or a head/main office — read carefully whether they gave you a phone number for that contact.\n- If they DID give a number, set redirect_phone to it (digits, any format they used) and redirect_label to a short 2-4 word description (e.g. "Head Office", "Rajkot Branch"), and mention in your reply that you'll also reach out there.\n- If they mention another branch/head office/person but do NOT give a number, ask them for that contact's phone number in your reply instead, and leave redirect_phone/redirect_label null.\nOnly set redirect_phone when a real phone number is actually present in their message. Never answer a business's customer booking request; ask for the owner or operations manager instead.`
    : '';
  const whatsappFields = isWhatsapp
    ? `,"status":"CONTINUE|WARM|COLD|QUALIFIED|NOT_INTERESTED","redirect_phone":"digits or null","redirect_label":"short label or null","memory":{"summary":"...","current_stage":"configured stage key or current key","lead_score":0-100,"pain_points":[],"interested_features":[],"decision_maker":"...","objections":[],"budget":"...","timeline":"...","next_objective":"..."}`
    : '';
  const textFormatNote = isWhatsapp ? '' : ' with "\\n\\n" between paragraphs (no HTML, no signature)';

  return `${intro}${buildPortfolioText(portfolioItems)}${buildServiceContextText(serviceContext)}${buildPlaybookText(playbookExamples)}${buildPlaybookNotesText(playbookNotes)}${revisionNote}${whatsappNote}

Respond with ONLY a JSON object: {"text": "..."${whatsappFields}} where text is plain text${textFormatNote}.`;
}

// Returns { text, meta }. `meta` is undefined for email; for whatsapp it carries the extra
// status/redirect fields salesAgentService.js's handleReply() needs (conversation status,
// alternate-contact redirect) that email replies have no equivalent of.
async function draftReply(context, revisionFeedback) {
  const { lead, incomingMessage, conversationHistory, playbookExamples, portfolioItems, serviceContext, playbookNotes, agent, channel, extraContext } = context;
  const historyText = buildHistoryText(conversationHistory);
  const userContent = `${buildLeadContext(lead)}${extraContext ? `\n\n${extraContext}` : ''}${historyText ? `\n\nConversation so far:\n${historyText}` : ''}\n\nLead's latest message:\n${incomingMessage}`;

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: channel === 'whatsapp' ? 380 : 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildDraftSystemPrompt(playbookExamples, revisionFeedback, portfolioItems, serviceContext, playbookNotes, agent, channel) },
      { role: 'user', content: userContent },
    ],
  }, { purpose: 'reply_draft', leadId: context.leadId ?? null });

  const parsed = JSON.parse(response.choices[0].message.content);
  const text = (parsed.text || '').trim();
  const meta = channel === 'whatsapp'
    ? {
        status: ['CONTINUE', 'WARM', 'COLD', 'QUALIFIED', 'NOT_INTERESTED'].includes(parsed.status) ? parsed.status : 'CONTINUE',
        redirectPhone: parsed.redirect_phone || null,
        redirectLabel: (parsed.redirect_label && String(parsed.redirect_label).trim().slice(0, 40)) || null,
        memory: parsed.memory || {},
      }
    : undefined;
  return { text, meta };
}

async function scoreReply(context, draftText) {
  const { lead, incomingMessage, conversationHistory, channel, extraContext } = context;
  const historyText = buildHistoryText(conversationHistory);
  const userContent = `${buildLeadContext(lead)}${extraContext ? `\n\n${extraContext}` : ''}${historyText ? `\n\nConversation so far:\n${historyText}` : ''}\n\nLead's latest message:\n${incomingMessage}\n\nDraft reply to score:\n${draftText}`;
  const medium = channel === 'whatsapp' ? 'WhatsApp sales messages' : 'outbound sales email replies';

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 150,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          `You are a strict quality reviewer for ${medium} sent by Dreams Technology. ` +
          'Score the draft reply from 1 (bad) to 5 (excellent) based on: relevance to what the lead said, ' +
          'professionalism, accuracy (no fabricated facts), warm but non-pushy tone, and whether it avoids revealing it is AI-generated. ' +
          'Respond with ONLY a JSON object: {"score": <1-5 integer>, "feedback": "short reason, especially if below 4"}.',
      },
      { role: 'user', content: userContent },
    ],
  }, { purpose: 'reply_score', leadId: context.leadId ?? null });

  const parsed = JSON.parse(response.choices[0].message.content);
  const score = Number.parseInt(parsed.score, 10);
  return {
    score: Number.isFinite(score) ? Math.max(1, Math.min(5, score)) : 1,
    feedback: parsed.feedback || '',
  };
}

// Quality gate for the FIRST-touch/follow-up sequence emails composed by
// sequenceEmailWorker.js — reuses the exact scoring capability already used for reply
// drafts (same model, same 1-5 rubric shape), applied at a new call site instead of a new
// AI system. No incoming message to react to here, so the rubric is pitch-quality specific:
// personalization grounded in real research (not generic), a clear single CTA, appropriate
// brevity for a cold email, and — for follow-ups — genuinely reads as a fresh touch rather
// than a repeat of an earlier one in the thread.
// What a "5" looks like depends on the step — mirrors the three stage notes in
// sequenceEmailWorker.js buildSystemPrompt, so a correct last-touch "close your file?" email
// isn't marked down for not opening with a business question and recomposed for nothing.
function buildColdEmailScorePrompt(stepNumber) {
  const { stageNote, fiveLooksLike } = stepNumber === 0
    ? {
        stageNote: 'This is a FIRST cold outreach email (no prior emails sent to this lead).',
        fiveLooksLike: 'under 60 words, opens with a specific question about THIS business (not "I hope..." or an introduction), frames the value as the owner\'s outcome in plain words, and ends with one easy yes/no question',
      }
    : stepNumber === 1
      ? {
          stageNote: 'This is FOLLOW-UP #1 in an outreach sequence — it must read as a genuinely new, short touch, not a rehash of earlier emails in the same thread.',
          fiveLooksLike: '2-3 short sentences, offers ONE new useful idea or example relevant to their industry (different from the first email) without saying it is a follow-up, and ends with one easy yes/no question',
        }
      : {
          stageNote: `This is the LAST email (touch #${stepNumber + 1}) in an outreach sequence — a short, polite break-up note.`,
          fiveLooksLike: 'at most 2 sentences, politely says there has been no reply so the timing probably isn\'t right, and asks one easy question like whether to close their file or reconnect later — no new pitch',
        };
  return `You are a strict quality reviewer for cold/follow-up sales emails sent by Dreams Technology, a software company in India, to busy Indian business owners. ${stageNote}
Score the draft from 1 (bad) to 5 (excellent). A 5 reads like a quick personal note from a founder: ${fiveLooksLike}. Score 2 or lower if it has any of: a pleasantry opener ("I hope this finds you well", "I wanted to reach out"), "circling back"/"just following up", tech or marketing jargon (CRM, GA4, integration, solution, streamline, enhance, leverage), criticism of their website, a demo pitch, more than ~80 words, or generic filler that could be sent to any business. For follow-ups, also score low if it repeats an earlier email's subject/angle/wording.
Respond with ONLY a JSON object: {"score": <1-5 integer>, "feedback": "short reason, especially if below 4"}.`;
}

async function scoreColdEmail({ leadId, lead, subject, body, stepNumber }) {
  const userContent = `${buildLeadContext(lead)}\n\nSubject: ${subject}\n\nBody:\n${body}`;

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 150,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildColdEmailScorePrompt(stepNumber) },
      { role: 'user', content: userContent },
    ],
  }, { purpose: 'cold_email_score', leadId: leadId ?? null });

  const parsed = JSON.parse(response.choices[0].message.content);
  const score = Number.parseInt(parsed.score, 10);
  return {
    score: Number.isFinite(score) ? Math.max(1, Math.min(5, score)) : 1,
    feedback: parsed.feedback || '',
  };
}

async function logAction(leadId, action, { detail, draftText, score, decision } = {}) {
  await pool.query(
    `INSERT INTO agent_actions (lead_id, action, detail, draft_text, score, decision)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [leadId ?? null, action, detail ? JSON.stringify(detail) : null, draftText ?? null, score ?? null, decision ?? null]
  );
}

async function draftAndScore(context) {
  const { leadId } = context;
  let revisionFeedback = null;
  let result = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { text, meta } = await draftReply(context, revisionFeedback);
    await logAction(leadId, 'draft_created', { detail: { attempt }, draftText: text });

    const { score, feedback } = await scoreReply(context, text);
    const passed = score >= SCORE_THRESHOLD;
    const isLastAttempt = attempt === MAX_ATTEMPTS;
    const decision = passed ? 'send' : (isLastAttempt ? 'queue_human' : 'revise');

    await logAction(leadId, 'draft_scored', { detail: { attempt, feedback }, draftText: text, score, decision });

    result = { text, meta, score, decision: passed ? 'send' : 'queue_human' };
    if (passed) return result;
    revisionFeedback = feedback;
  }

  await logAction(leadId, 'draft_queued_human', {
    detail: { attempts: MAX_ATTEMPTS },
    draftText: result.text,
    score: result.score,
    decision: 'queue_human',
  });

  return result;
}

module.exports = {
  draftAndScore, buildLeadContext, buildHistoryText, buildPlaybookText, buildPlaybookNotesText,
  scoreColdEmail, COLD_EMAIL_SCORE_THRESHOLD,
};
