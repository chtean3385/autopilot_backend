-- Research pipeline v3: per-category confidence + versioned history (additive only, no drops).
--
-- 1. lead_research gains confidence_breakdown (per-area 0-100 confidences from the research GPT
--    call) and schema_version (1 = pre-breakdown rows, 2 = rows written by the upgraded
--    researchCompany()). Existing rows keep working — old code never reads the new columns.
-- 2. lead_research_versions is an append-only history: every researchCompany() run inserts a new
--    (lead_id, version) row here alongside the lead_research upsert, so a ?force=true re-research
--    no longer destroys the previous result. Never updated or pruned by design.

ALTER TABLE lead_research ADD COLUMN IF NOT EXISTS confidence_breakdown JSON;
ALTER TABLE lead_research ADD COLUMN IF NOT EXISTS schema_version INT DEFAULT 1;

CREATE TABLE IF NOT EXISTS lead_research_versions (
  id SERIAL PRIMARY KEY,
  lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
  version INT NOT NULL,
  company JSON,
  summary TEXT,
  business JSON,
  technology JSON,
  pain_points JSON,
  recommended_services JSON,
  opportunity_score JSON,
  email_angles JSON,
  decision_makers JSON,
  confidence INT,
  confidence_breakdown JSON,
  schema_version INT DEFAULT 2,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_research_versions_lead_version ON lead_research_versions(lead_id, version);
CREATE INDEX IF NOT EXISTS idx_lead_research_versions_lead_created ON lead_research_versions(lead_id, created_at DESC);
