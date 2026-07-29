-- Marks agents auto-created by resolveAgent's migration fallback (services/salesAgentService.js)
-- when a campaign has a system_prompt but no agent_id — a blank one-off, not a real Sales
-- Agent the user configured. Lets the no-lineage fallback in resolveAgent skip these and
-- prefer a real hand-built agent instead.
ALTER TABLE sales_agents ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE;
