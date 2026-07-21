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

function buildDraftSystemPrompt(playbookExamples, revisionFeedback, portfolioItems, serviceContext, playbookNotes) {
  const revisionNote = revisionFeedback
    ? `\n\nA previous draft scored too low on quality review. Feedback to address: "${revisionFeedback}". Write an improved reply.`
    : '';

  return `You are a sales assistant for Dreams Technology, a business management software company in India, replying to an inbound message from a lead in an ongoing email conversation.

Goals:
- Be warm, professional, and concise (3-6 sentences).
- Directly address what the lead said or asked — do not ignore it or repeat a generic pitch.
- Where natural, move the conversation toward a free demo of our business management software, without being pushy.
- Never fabricate facts about the recipient's business or about Dreams Technology beyond what's given below.
- Never mention you are an AI.${buildPortfolioText(portfolioItems)}${buildServiceContextText(serviceContext)}${buildPlaybookText(playbookExamples)}${buildPlaybookNotesText(playbookNotes)}${revisionNote}

Respond with ONLY a JSON object: {"text": "..."} where text is plain text with "\\n\\n" between paragraphs (no HTML, no signature).`;
}

async function draftReply(context, revisionFeedback) {
  const { lead, incomingMessage, conversationHistory, playbookExamples, portfolioItems, serviceContext, playbookNotes } = context;
  const historyText = buildHistoryText(conversationHistory);
  const userContent = `${buildLeadContext(lead)}${historyText ? `\n\nConversation so far:\n${historyText}` : ''}\n\nLead's latest message:\n${incomingMessage}`;

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildDraftSystemPrompt(playbookExamples, revisionFeedback, portfolioItems, serviceContext, playbookNotes) },
      { role: 'user', content: userContent },
    ],
  }, { purpose: 'reply_draft', leadId: context.leadId ?? null });

  const parsed = JSON.parse(response.choices[0].message.content);
  return (parsed.text || '').trim();
}

async function scoreReply(context, draftText) {
  const { lead, incomingMessage, conversationHistory } = context;
  const historyText = buildHistoryText(conversationHistory);
  const userContent = `${buildLeadContext(lead)}${historyText ? `\n\nConversation so far:\n${historyText}` : ''}\n\nLead's latest message:\n${incomingMessage}\n\nDraft reply to score:\n${draftText}`;

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 150,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are a strict quality reviewer for outbound sales email replies sent by Dreams Technology. ' +
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
function buildColdEmailScorePrompt(stepNumber) {
  const stageNote = stepNumber === 0
    ? 'This is a FIRST cold outreach email (no prior emails sent to this lead).'
    : `This is FOLLOW-UP #${stepNumber} in an outreach sequence — it must read as a genuinely new, short touch, not a rehash of earlier emails in the same thread.`;
  return `You are a strict quality reviewer for cold/follow-up sales emails sent by Dreams Technology, a business management software company in India. ${stageNote}
Score the draft from 1 (bad) to 5 (excellent) based on: genuine personalization grounded in the specific business (not generic filler), a single clear low-pressure CTA, appropriate brevity, professional warm tone with no hype/spam language, and — for follow-ups — that it doesn't just repeat an earlier email's subject/angle/wording.
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
    const text = await draftReply(context, revisionFeedback);
    await logAction(leadId, 'draft_created', { detail: { attempt }, draftText: text });

    const { score, feedback } = await scoreReply(context, text);
    const passed = score >= SCORE_THRESHOLD;
    const isLastAttempt = attempt === MAX_ATTEMPTS;
    const decision = passed ? 'send' : (isLastAttempt ? 'queue_human' : 'revise');

    await logAction(leadId, 'draft_scored', { detail: { attempt, feedback }, draftText: text, score, decision });

    result = { text, score, decision: passed ? 'send' : 'queue_human' };
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
