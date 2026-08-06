-- Lets an email sequence be tied to a specific Sales Agent (channel='email'), so replies
-- drafted for leads enrolled in it use that agent's persona/knowledge instead of only the
-- shared Playbook. NULL keeps today's behavior (shared Playbook only).
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS agent_id INT REFERENCES sales_agents(id);
