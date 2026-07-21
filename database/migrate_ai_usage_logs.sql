-- Per-call GPT usage/billing log — one row per successful chat.completions call, written by
-- utils/aiUsage.js's trackedCompletion() wrapper (all 12 call sites route through it).
-- lead_id is ON DELETE SET NULL (not CASCADE like agent_actions): this is billing history,
-- it must survive lead deletion.

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id SERIAL PRIMARY KEY,
  lead_id INT REFERENCES hotel_leads(id) ON DELETE SET NULL,
  purpose VARCHAR(50) NOT NULL,
  model VARCHAR(80),
  prompt_tokens INT,
  completion_tokens INT,
  total_tokens INT,
  cost_usd NUMERIC(12,6),
  duration_ms INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created ON ai_usage_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_purpose ON ai_usage_logs(purpose, created_at DESC);
