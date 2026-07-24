-- Apply manually for local databases; server.js contains the same idempotent schema
-- so Render self-heals at boot.
CREATE TABLE IF NOT EXISTS sales_agents (
  id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, industry VARCHAR(100),
  channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp', system_prompt TEXT NOT NULL,
  sales_strategy TEXT, qualification_logic TEXT, demo_process TEXT, closing_strategy TEXT,
  product_knowledge TEXT, objection_handling TEXT, response_rules TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE sales_agents ADD COLUMN IF NOT EXISTS product_knowledge TEXT;
ALTER TABLE sales_agents ADD COLUMN IF NOT EXISTS objection_handling TEXT;
ALTER TABLE sales_agents ADD COLUMN IF NOT EXISTS response_rules TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS agent_id INT REFERENCES sales_agents(id);
CREATE TABLE IF NOT EXISTS agent_knowledge (
  id SERIAL PRIMARY KEY, agent_id INT NOT NULL REFERENCES sales_agents(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL, content TEXT NOT NULL, tags JSON DEFAULT '[]', stage_keys JSON DEFAULT '[]',
  intent_keys JSON DEFAULT '[]', priority INT DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agent_intent_rules (
  id SERIAL PRIMARY KEY, agent_id INT REFERENCES sales_agents(id) ON DELETE CASCADE, intent VARCHAR(80) NOT NULL,
  description TEXT, examples JSON DEFAULT '[]', priority INT DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agent_stage_rules (
  id SERIAL PRIMARY KEY, agent_id INT NOT NULL REFERENCES sales_agents(id) ON DELETE CASCADE, stage_key VARCHAR(80) NOT NULL,
  stage_name VARCHAR(255) NOT NULL, objective TEXT NOT NULL, stage_order INT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE, UNIQUE(agent_id, stage_key), UNIQUE(agent_id, stage_order)
);
CREATE TABLE IF NOT EXISTS conversation_memories (
  id SERIAL PRIMARY KEY, lead_id INT NOT NULL REFERENCES hotel_leads(id) ON DELETE CASCADE,
  agent_id INT NOT NULL REFERENCES sales_agents(id) ON DELETE CASCADE, summary TEXT, current_stage VARCHAR(80),
  lead_score INT DEFAULT 0, pain_points JSON DEFAULT '[]', interested_features JSON DEFAULT '[]',
  decision_maker VARCHAR(255), objections JSON DEFAULT '[]', budget VARCHAR(255), timeline VARCHAR(255),
  next_objective TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(lead_id, agent_id)
);
