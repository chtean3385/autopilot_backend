-- Reshapes lead_research from the old fused research+email-draft cache (leadResearchService.js's
-- old researchAndDraft(): business_profile/website_audit/opportunities/email_subject/email_body)
-- into the new researchCompany() shape: one GPT-5.5 call producing company/summary/business/
-- technology/pain_points/recommended_services/opportunity_score/email_angles/decision_makers.
--
-- This is a deliberate, guarded exception to "migrations are additive/idempotent only, never
-- destructive": lead_research is a pure regenerable cache (see backend/README.md's own note that
-- server.js's initDB() inline block is what actually matters in production; this file matters for
-- anyone restoring/patching a stale local dev DB by hand). The guard makes the DROP self-limiting —
-- it only fires once, when the OLD shape is still present, and becomes a permanent no-op after.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'lead_research' AND column_name = 'business_profile'
  ) THEN
    DROP TABLE lead_research;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS lead_research (
  id SERIAL PRIMARY KEY,
  lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_research_lead_id ON lead_research(lead_id);
