-- Per-lead website research cache: stores the output of the website-research/audit/
-- email-drafting pipeline (backend/services/leadResearchService.js) so it only needs
-- to run once per lead instead of re-scraping/re-prompting on every view.
CREATE TABLE IF NOT EXISTS lead_research (
  id SERIAL PRIMARY KEY,
  lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
  business_profile JSON,
  website_audit JSON,
  pain_points JSON,
  opportunities JSON,
  recommended_services JSON,
  email_subject VARCHAR(500),
  email_body TEXT,
  confidence VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_research_lead_id ON lead_research(lead_id);
