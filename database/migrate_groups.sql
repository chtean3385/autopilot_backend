-- Lead Groups table
CREATE TABLE IF NOT EXISTS lead_groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Group members (many-to-many)
CREATE TABLE IF NOT EXISTS lead_group_members (
    group_id INT REFERENCES lead_groups(id) ON DELETE CASCADE,
    lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, lead_id)
);

-- Add group targeting to campaigns
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS group_id INT REFERENCES lead_groups(id);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_type VARCHAR(20) DEFAULT 'city';
