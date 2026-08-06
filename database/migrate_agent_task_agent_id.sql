-- Lets the Agent tab's task-creation form assign a real Sales Agent directly, instead of
-- relying on resolveAgent()'s industry-match fallback at reply time.
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS agent_id INT REFERENCES sales_agents(id);
