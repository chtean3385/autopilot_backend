-- Hotels/Leads Table
CREATE TABLE IF NOT EXISTS hotel_leads (
    id SERIAL PRIMARY KEY,
    hotel_name VARCHAR(255) NOT NULL,
    owner_name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    whatsapp_number VARCHAR(20) NOT NULL,
    city VARCHAR(100),
    phone VARCHAR(20),
    source VARCHAR(50) DEFAULT 'manual', -- 'google', 'directory', 'manual'
    business_category VARCHAR(100),
    estimated_rooms INT,
    status VARCHAR(50) DEFAULT 'new', -- 'new', 'interested', 'demo_qualified', 'responded', 'no_response'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- WhatsApp Templates Table
CREATE TABLE IF NOT EXISTS waba_templates (
    id SERIAL PRIMARY KEY,
    template_name VARCHAR(100) UNIQUE NOT NULL,
    template_category VARCHAR(50), -- 'MARKETING', 'ACCOUNT_UPDATE', 'UTILITY'
    body_text TEXT NOT NULL,
    parameters JSON, -- {"param1": "hotel_name", "param2": "owner_name"}
    footer_text VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending_approval', -- 'pending_approval', 'approved', 'rejected'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(100)
);

-- Campaigns Table
CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    campaign_name VARCHAR(255) NOT NULL,
    template_id INT REFERENCES waba_templates(id),
    description TEXT,
    target_city VARCHAR(100),
    scheduled_start TIMESTAMP,
    scheduled_end TIMESTAMP,
    status VARCHAR(50) DEFAULT 'draft', -- 'draft', 'scheduled', 'active', 'paused', 'completed'
    total_leads INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(100)
);

-- Outreach Logs (Tracking)
CREATE TABLE IF NOT EXISTS outreach_logs (
    id SERIAL PRIMARY KEY,
    lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
    campaign_id INT REFERENCES campaigns(id),
    template_id INT REFERENCES waba_templates(id),
    message_type VARCHAR(50), -- 'template', 'text'
    waba_message_id VARCHAR(255), -- From WhatsApp API
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    response_received BOOLEAN DEFAULT FALSE,
    response_text TEXT,
    response_received_at TIMESTAMP,
    qualified_for_demo BOOLEAN DEFAULT FALSE,
    lead_status_after VARCHAR(50), -- 'interested', 'demo_qualified', etc
    error_message TEXT
);

-- Demo Bookings Table
CREATE TABLE IF NOT EXISTS demo_bookings (
    id SERIAL PRIMARY KEY,
    lead_id INT REFERENCES hotel_leads(id),
    campaign_id INT REFERENCES campaigns(id),
    demo_scheduled_at TIMESTAMP,
    demo_status VARCHAR(50) DEFAULT 'scheduled', -- 'scheduled', 'completed', 'no_show', 'cancelled'
    feedback TEXT,
    conversion_status VARCHAR(50), -- 'interested', 'not_interested', 'pending'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Analytics/Dashboard Summary Table
CREATE TABLE IF NOT EXISTS daily_analytics (
    id SERIAL PRIMARY KEY,
    campaign_id INT REFERENCES campaigns(id),
    date DATE,
    total_sent INT DEFAULT 0,
    total_delivered INT DEFAULT 0,
    total_read INT DEFAULT 0,
    total_responses INT DEFAULT 0,
    demo_qualified INT DEFAULT 0,
    conversion_rate DECIMAL(5, 2),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Agent Tasks Table
CREATE TABLE IF NOT EXISTS agent_tasks (
  id SERIAL PRIMARY KEY,
  instruction TEXT NOT NULL,
  city VARCHAR(100),
  lead_count INTEGER DEFAULT 20,
  template_id INTEGER REFERENCES waba_templates(id),
  status VARCHAR(50) DEFAULT 'pending',
  run_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  leads_scraped INTEGER DEFAULT 0,
  leads_saved INTEGER DEFAULT 0,
  messages_sent INTEGER DEFAULT 0,
  campaign_id INTEGER REFERENCES campaigns(id),
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_leads_city ON hotel_leads(city);
CREATE INDEX IF NOT EXISTS idx_leads_status ON hotel_leads(status);
CREATE INDEX IF NOT EXISTS idx_outreach_lead ON outreach_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_outreach_campaign ON outreach_logs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_outreach_sent_at ON outreach_logs(sent_at);
CREATE INDEX IF NOT EXISTS idx_template_status ON waba_templates(status);
