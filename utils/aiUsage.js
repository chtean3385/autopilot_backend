const pool = require('../config/db');

// Per-call GPT usage/billing tracker. Wraps every chat.completions.create in this codebase
// (12 call sites) so tokens/model/cost/duration land in ai_usage_logs. Tokens are the stored
// source of truth — cost_usd is a convenience computed from PRICING below and can be
// recomputed later if prices change.

// USD per 1M tokens. Verified 2026-07-21: gpt-5.5/5.4 family from developers.openai.com/api/docs/pricing;
// gpt-4o-mini ($0.15/$0.60, long-stable) and gpt-5/5.1 tier ($1.25/$10) from current third-party trackers —
// OpenAI's page no longer lists legacy models. Matched by longest prefix, so dated snapshots
// (e.g. 'gpt-5.5-2026-04-23') resolve to their family entry. Unknown model → cost_usd NULL.
const PRICING = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-5-mini': { input: 0.25, output: 2.00 },
  'gpt-5-nano': { input: 0.05, output: 0.40 },
  'gpt-5.1': { input: 1.25, output: 10.00 },
  'gpt-5': { input: 1.25, output: 10.00 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25 },
  'gpt-5.4': { input: 2.50, output: 15.00 },
  'gpt-5.5': { input: 5.00, output: 30.00 },
};

function priceFor(model) {
  if (!model) return null;
  let best = null;
  for (const prefix of Object.keys(PRICING)) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix;
  }
  return best ? PRICING[best] : null;
}

function computeCost(model, usage) {
  const price = priceFor(model);
  if (!price || !usage) return null;
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
}

// Drop-in replacement for client.chat.completions.create(params): identical return value and
// error behavior, plus one ai_usage_logs row per successful response. The INSERT is wrapped in
// its own try/catch — a logging failure must never break the AI call that paid for the tokens.
async function trackedCompletion(client, params, { purpose, leadId = null } = {}) {
  const t0 = Date.now();
  const response = await client.chat.completions.create(params);
  const durationMs = Date.now() - t0;

  try {
    const usage = response.usage || {};
    const model = response.model || params.model || null;
    await pool.query(
      `INSERT INTO ai_usage_logs
         (lead_id, purpose, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        leadId,
        purpose || 'unknown',
        model,
        usage.prompt_tokens ?? null,
        usage.completion_tokens ?? null,
        usage.total_tokens ?? null,
        computeCost(model, usage),
        durationMs,
      ]
    );
  } catch (err) {
    console.error('[AIUsage] failed to log usage:', err.message);
  }

  return response;
}

module.exports = { trackedCompletion, computeCost, PRICING };
