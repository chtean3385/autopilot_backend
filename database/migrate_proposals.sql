-- Third Sprint: Proposal Generator. One AI-generated sales proposal per lead (regenerable cache,
-- same pattern as lead_research), grounded in that lead's lead_research row. See proposalService.js.
CREATE TABLE IF NOT EXISTS proposals (
  id SERIAL PRIMARY KEY,
  lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
  proposal JSON,
  timeline JSON,
  quotation JSON,
  architecture JSON,
  current_vs_future JSON,
  roi JSON,
  status VARCHAR(20) DEFAULT 'draft', -- 'draft', 'sent'
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_lead_id ON proposals(lead_id);
