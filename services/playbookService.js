const OpenAI = require('openai');
const pool = require('../config/db');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const FEW_SHOT_LIMIT = 5;
const NOTES_LIMIT = 5;

// A lead asking for an estimate is the funnel's win condition (plan section 1) — the exchange
// that got them there is a good few-shot example for future drafts in similar situations.
async function captureWonExample({ leadId, context, example }) {
  if (!context || !example) return null;
  const result = await pool.query(
    `INSERT INTO playbook_examples (kind, context, example, source_lead_id, active)
     VALUES ('few_shot', $1, $2, $3, true) RETURNING *`,
    [context, example, leadId ?? null]
  );
  return result.rows[0];
}

// Owner edited or rejected a queued draft — record before/after (or before/discarded) so future
// drafts avoid the same misstep. `after` null means the draft was rejected outright.
async function captureCorrection({ leadId, before, after }) {
  if (!before) return null;
  const result = await pool.query(
    `INSERT INTO playbook_examples (kind, context, example, source_lead_id, active)
     VALUES ('correction', $1, $2, $3, true) RETURNING *`,
    [before, after || '(discarded — avoid this style entirely)', leadId ?? null]
  );
  return result.rows[0];
}

// Fed into drafting prompts: concrete few-shot examples (kind=few_shot, in the shape
// replyQualityService.buildPortfolioText-style formatters expect: {context, example}) plus
// short guidance notes distilled from corrections and weekly insight reviews.
async function getPlaybookContext() {
  const [fewShotRes, notesRes] = await Promise.all([
    pool.query(
      `SELECT context, example FROM playbook_examples
       WHERE kind = 'few_shot' AND active = true
       ORDER BY created_at DESC LIMIT $1`,
      [FEW_SHOT_LIMIT]
    ),
    pool.query(
      `SELECT context, example FROM playbook_examples
       WHERE kind IN ('correction', 'insight') AND active = true
       ORDER BY created_at DESC LIMIT $1`,
      [NOTES_LIMIT]
    ),
  ]);

  const notes = notesRes.rows.map(r =>
    r.example.startsWith('(') ? `Avoid: "${r.context}" ${r.example}` : `Avoid: "${r.context}" — Prefer: "${r.example}"`
  );

  return { fewShotExamples: fewShotRes.rows, notes };
}

async function summarizeWeek() {
  const [actionsRes, sentRes, repliedRes] = await Promise.all([
    pool.query(
      `SELECT action, decision, COUNT(*)::int AS count
       FROM agent_actions
       WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY action, decision
       ORDER BY count DESC`
    ),
    pool.query(
      `SELECT COUNT(DISTINCT lead_id)::int AS count FROM email_logs
       WHERE direction = 'out' AND COALESCE(sent_at, created_at) >= NOW() - INTERVAL '7 days'`
    ),
    pool.query(
      `SELECT COUNT(DISTINCT lead_id)::int AS count FROM email_logs
       WHERE direction = 'in' AND COALESCE(sent_at, created_at) >= NOW() - INTERVAL '7 days'`
    ),
  ]);

  const leadsSent = sentRes.rows[0].count;
  const leadsReplied = repliedRes.rows[0].count;
  const replyRate = leadsSent > 0 ? Math.round((leadsReplied / leadsSent) * 100) : null;

  return {
    actionCounts: actionsRes.rows,
    leadsEmailed: leadsSent,
    leadsReplied,
    replyRatePct: replyRate,
  };
}

// Weekly job: GPT reviews the week's agent_actions + reply rate and writes a short guidance
// note stored as kind=insight, appended to future drafting prompts via getPlaybookContext().
async function runWeeklyInsights() {
  const summary = await summarizeWeek();

  if (summary.actionCounts.length === 0 && summary.leadsEmailed === 0) {
    console.log('[Playbook] No email activity in the past week — skipping insight generation');
    return null;
  }

  const summaryText = [
    `Leads emailed: ${summary.leadsEmailed}`,
    `Leads who replied: ${summary.leadsReplied}` + (summary.replyRatePct !== null ? ` (${summary.replyRatePct}% reply rate)` : ''),
    'Agent action counts:',
    ...summary.actionCounts.map(a => `- ${a.action}${a.decision ? ` (${a.decision})` : ''}: ${a.count}`),
  ].join('\n');

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You review a week of email cold-outreach activity for Dreams Technology and write ONE short, ' +
          'actionable guidance note (2-4 sentences) to improve future outreach and replies — based only on ' +
          'the patterns in the data given, no speculation beyond it. ' +
          'Respond with ONLY a JSON object: {"insight": "..."}.',
      },
      { role: 'user', content: summaryText },
    ],
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  const insight = (parsed.insight || '').trim();
  if (!insight) return null;

  const dateRange = `${new Date(Date.now() - 7 * 86400000).toLocaleDateString()} – ${new Date().toLocaleDateString()}`;
  const result = await pool.query(
    `INSERT INTO playbook_examples (kind, context, example, active)
     VALUES ('insight', $1, $2, true) RETURNING *`,
    [`Weekly review ${dateRange}`, insight]
  );
  console.log(`[Playbook] Weekly insight generated: ${insight}`);
  return result.rows[0];
}

module.exports = { captureWonExample, captureCorrection, getPlaybookContext, runWeeklyInsights };
