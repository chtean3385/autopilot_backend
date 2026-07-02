const express = require('express');
const cors = require('cors');
require('dotenv').config();

const pool = require('./config/db');

// Auto-create all tables on startup
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hotel_leads (
      id SERIAL PRIMARY KEY,
      hotel_name VARCHAR(255) NOT NULL,
      owner_name VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      whatsapp_number VARCHAR(20) NOT NULL,
      city VARCHAR(100),
      phone VARCHAR(20),
      source VARCHAR(50) DEFAULT 'manual',
      business_category VARCHAR(100),
      estimated_rooms INT,
      status VARCHAR(50) DEFAULT 'new',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS waba_templates (
      id SERIAL PRIMARY KEY,
      template_name VARCHAR(100) UNIQUE NOT NULL,
      template_category VARCHAR(50),
      body_text TEXT NOT NULL,
      parameters JSON,
      footer_text VARCHAR(255),
      status VARCHAR(50) DEFAULT 'pending_approval',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(100)
    );
    ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS examples JSON;
    ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS meta_template_id VARCHAR(100);
    ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS header_image_url VARCHAR(500);
    ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS parameter_mapping JSON;
    ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS message_text TEXT;
    CREATE TABLE IF NOT EXISTS lead_groups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS lead_group_members (
      group_id INT REFERENCES lead_groups(id) ON DELETE CASCADE,
      lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, lead_id)
    );
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS group_id INT REFERENCES lead_groups(id);
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_type VARCHAR(20) DEFAULT 'city';
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_lead_status VARCHAR(50) DEFAULT 'new';
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      campaign_name VARCHAR(255) NOT NULL,
      template_id INT REFERENCES waba_templates(id),
      description TEXT,
      target_city VARCHAR(100),
      target_type VARCHAR(50),
      scheduled_start TIMESTAMP,
      scheduled_end TIMESTAMP,
      status VARCHAR(50) DEFAULT 'draft',
      total_leads INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(100)
    );
    CREATE TABLE IF NOT EXISTS outreach_logs (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
      campaign_id INT REFERENCES campaigns(id),
      template_id INT REFERENCES waba_templates(id),
      message_type VARCHAR(50),
      waba_message_id VARCHAR(255),
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      delivered_at TIMESTAMP,
      read_at TIMESTAMP,
      response_received BOOLEAN DEFAULT FALSE,
      response_text TEXT,
      response_received_at TIMESTAMP,
      qualified_for_demo BOOLEAN DEFAULT FALSE,
      lead_status_after VARCHAR(50),
      error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS demo_bookings (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES hotel_leads(id),
      campaign_id INT REFERENCES campaigns(id),
      demo_scheduled_at TIMESTAMP,
      demo_status VARCHAR(50) DEFAULT 'scheduled',
      feedback TEXT,
      conversion_status VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS daily_analytics (
      id SERIAL PRIMARY KEY,
      campaign_id INT REFERENCES campaigns(id),
      date DATE,
      total_sent INT DEFAULT 0,
      total_delivered INT DEFAULT 0,
      total_read INT DEFAULT 0,
      total_responses INT DEFAULT 0,
      demo_qualified INT DEFAULT 0,
      conversion_rate DECIMAL(5,2),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
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
    ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS parsed_params JSON;
    ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS clarification_questions JSON;
    ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS clarification_answers JSON;
    ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS refined_instruction TEXT;
    ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS refinement_note TEXT;
    ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS system_prompt TEXT;
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS system_prompt TEXT;
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS business_type VARCHAR(100);
    CREATE INDEX IF NOT EXISTS idx_leads_city ON hotel_leads(city);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON hotel_leads(status);
    CREATE INDEX IF NOT EXISTS idx_outreach_lead ON outreach_logs(lead_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_campaign ON outreach_logs(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_sent_at ON outreach_logs(sent_at);
    CREATE INDEX IF NOT EXISTS idx_template_status ON waba_templates(status);
  `);
  console.log('✅ Database tables ready');
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/webhook', require('./routes/webhook'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/groups', require('./routes/groups'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/agent', require('./routes/agent'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Start background workers
require('./workers/campaignWorker');
require('./services/schedulerService');

const PORT = process.env.PORT || 5000;
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Backend running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});
