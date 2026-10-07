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

// Hard monthly spend cap (added 2026-10-07): every GPT call is refused once this calendar
// month's logged cost_usd reaches OPENAI_MONTHLY_BUDGET_USD (settings table, default $10).
// Callers already treat a thrown OpenAI error as "try again later", so hitting the cap just
// pauses AI work until the 1st. Cached 60s so we don't SUM the table on every call. Only
// counts this app's logged calls — the OpenAI dashboard's own usage limit is the backstop.
const DEFAULT_MONTHLY_BUDGET_USD = 10;
let budgetCache = { at: 0, spent: 0, budget: DEFAULT_MONTHLY_BUDGET_USD };

async function assertWithinBudget() {
  if (Date.now() - budgetCache.at > 60000) {
    const { getSetting } = require('../services/settingsService');
    const budget = Number(await getSetting('OPENAI_MONTHLY_BUDGET_USD')) || DEFAULT_MONTHLY_BUDGET_USD;
    const result = await pool.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_usage_logs WHERE created_at >= date_trunc('month', NOW())`
    );
    budgetCache = { at: Date.now(), spent: Number(result.rows[0].spent), budget };
  }
  if (budgetCache.spent >= budgetCache.budget) {
    const err = new Error(`OpenAI monthly budget reached ($${budgetCache.spent.toFixed(2)} of $${budgetCache.budget}) — AI paused until next month`);
    err.code = 'budget_exceeded';
    throw err;
  }
}

// Drop-in replacement for client.chat.completions.create(params): identical return value and
// error behavior, plus one ai_usage_logs row per successful response. The INSERT is wrapped in
// its own try/catch — a logging failure must never break the AI call that paid for the tokens.
// Set when OpenAI says the account is out of credit (429 "no credits"/insufficient_quota) or our
// own budget cap trips — a billing outage, not a verdict on any lead. Workers that count failed
// attempts per lead (researchWorker.js) check isAiAvailable() so an outage doesn't burn them.
const AI_UNAVAILABLE_COOLDOWN_MS = 15 * 60 * 1000;
let aiUnavailableUntil = 0;

function isBillingError(err) {
  return err?.code === 'budget_exceeded' || err?.code === 'insufficient_quota' ||
    (err?.status === 429 && /credits|quota|billing/i.test(err?.message || ''));
}

function isAiAvailable() {
  return Date.now() >= aiUnavailableUntil;
}

async function trackedCompletion(client, params, { purpose, leadId = null } = {}) {
  let response;
  const t0 = Date.now();
  try {
    await assertWithinBudget();
    // Every OpenAI client in the codebase is built once at module load from .env's
    // OPENAI_API_KEY, so a key changed in Manage → Settings was never used. Read the live
    // value (settings table first, .env fallback) on each call and swap it onto the client.
    const { getSetting } = require('../services/settingsService');
    const liveKey = await getSetting('OPENAI_API_KEY');
    if (liveKey && client.apiKey !== liveKey) client.apiKey = liveKey;
    response = await client.chat.completions.create(params);
  } catch (err) {
    if (isBillingError(err)) aiUnavailableUntil = Date.now() + AI_UNAVAILABLE_COOLDOWN_MS;
    throw err;
  }
  aiUnavailableUntil = 0;
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

module.exports = { trackedCompletion, computeCost, PRICING, isAiAvailable };
