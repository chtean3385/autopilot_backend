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
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_leads_city ON hotel_leads(city);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON hotel_leads(status);
    CREATE INDEX IF NOT EXISTS idx_outreach_lead ON outreach_logs(lead_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_campaign ON outreach_logs(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_sent_at ON outreach_logs(sent_at);
    CREATE INDEX IF NOT EXISTS idx_template_status ON waba_templates(status);

    -- Email outreach channel (database/migrate_email_outreach.sql) — inlined here so a
    -- fresh/production DB self-heals on boot instead of depending on someone manually
    -- running the migration file (which is how prod ended up missing these tables).
    ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'whatsapp';
    ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS website VARCHAR(500);
    ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_status VARCHAR(30) DEFAULT 'unknown';
    ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_source VARCHAR(50);
    ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_verify_attempts INT DEFAULT 0;
    ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS last_verify_attempt_at TIMESTAMP;
    CREATE UNIQUE INDEX IF NOT EXISTS hotel_leads_email_unique_idx
      ON hotel_leads (LOWER(email))
      WHERE email IS NOT NULL AND email <> '';

    CREATE TABLE IF NOT EXISTS email_senders (
      id SERIAL PRIMARY KEY,
      label VARCHAR(100) NOT NULL,
      provider VARCHAR(20) NOT NULL DEFAULT 'brevo',
      api_key VARCHAR(255),
      smtp_config JSON,
      from_name VARCHAR(255),
      from_email VARCHAR(255) NOT NULL,
      sending_domain VARCHAR(255),
      daily_cap INT DEFAULT 20,
      warmup_started_at TIMESTAMP,
      sent_today INT DEFAULT 0,
      last_reset_date DATE,
      imap_config JSON,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sequences (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      channel VARCHAR(20) DEFAULT 'email',
      initial_gaps JSON,
      recurring_interval_days INT DEFAULT 7,
      daily_send_limit INT DEFAULT 20,
      sent_today INT DEFAULT 0,
      last_reset_date DATE,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS lead_sequences (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
      sequence_id INT REFERENCES sequences(id) ON DELETE CASCADE,
      sender_id INT REFERENCES email_senders(id),
      current_step INT DEFAULT 0,
      next_run_at TIMESTAMP,
      status VARCHAR(30) DEFAULT 'active',
      paused_reason TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_logs (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
      sender_id INT REFERENCES email_senders(id),
      sequence_id INT REFERENCES sequences(id),
      direction VARCHAR(5) NOT NULL,
      subject VARCHAR(500),
      body TEXT,
      provider_message_id VARCHAR(255),
      sent_at TIMESTAMP,
      opened_at TIMESTAMP,
      clicked_at TIMESTAMP,
      bounced_at TIMESTAMP,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
    CREATE INDEX IF NOT EXISTS idx_email_logs_provider_message_id ON email_logs(provider_message_id);
    CREATE TABLE IF NOT EXISTS agent_actions (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
      action VARCHAR(50) NOT NULL,
      detail JSON,
      draft_text TEXT,
      score INT,
      decision VARCHAR(30),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id SERIAL PRIMARY KEY,
      type VARCHAR(30) NOT NULL,
      lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
      payload JSON,
      status VARCHAR(20) DEFAULT 'pending',
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      decided_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS estimates (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
      approval_id INT REFERENCES pending_approvals(id),
      line_items JSON,
      total DECIMAL(10, 2),
      html TEXT,
      status VARCHAR(20) DEFAULT 'draft',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS portfolio_items (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      url VARCHAR(500),
      description TEXT,
      tags VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS suppression_list (
      email VARCHAR(255) PRIMARY KEY,
      reason VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS playbook_examples (
      id SERIAL PRIMARY KEY,
      kind VARCHAR(20) NOT NULL,
      context TEXT,
      example TEXT,
      source_lead_id INT REFERENCES hotel_leads(id),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
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
    ALTER TABLE lead_research ADD COLUMN IF NOT EXISTS confidence_breakdown JSON;
    ALTER TABLE lead_research ADD COLUMN IF NOT EXISTS schema_version INT DEFAULT 1;
    CREATE TABLE IF NOT EXISTS lead_research_versions (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
      version INT NOT NULL,
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
      confidence_breakdown JSON,
      schema_version INT DEFAULT 2,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_research_versions_lead_version ON lead_research_versions(lead_id, version);
    CREATE INDEX IF NOT EXISTS idx_lead_research_versions_lead_created ON lead_research_versions(lead_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ai_usage_logs (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES hotel_leads(id) ON DELETE SET NULL,
      purpose VARCHAR(50) NOT NULL,
      model VARCHAR(80),
      prompt_tokens INT,
      completion_tokens INT,
      total_tokens INT,
      cost_usd NUMERIC(12,6),
      duration_ms INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created ON ai_usage_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_purpose ON ai_usage_logs(purpose, created_at DESC);
    CREATE TABLE IF NOT EXISTS proposals (
      id SERIAL PRIMARY KEY,
      lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
      proposal JSON,
      timeline JSON,
      quotation JSON,
      architecture JSON,
      current_vs_future JSON,
      roi JSON,
      status VARCHAR(20) DEFAULT 'draft',
      sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_lead_id ON proposals(lead_id);
    CREATE TABLE IF NOT EXISTS scheduler_status (
      job_name VARCHAR(50) PRIMARY KEY,
      last_ran_at TIMESTAMP,
      last_trigger VARCHAR(20),
      last_summary JSON,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_leads_channel ON hotel_leads(channel);
    CREATE INDEX IF NOT EXISTS idx_senders_status ON email_senders(status);
    CREATE INDEX IF NOT EXISTS idx_lead_sequences_lead ON lead_sequences(lead_id);
    CREATE INDEX IF NOT EXISTS idx_lead_sequences_sender ON lead_sequences(sender_id);
    CREATE INDEX IF NOT EXISTS idx_lead_sequences_status ON lead_sequences(status);
    CREATE INDEX IF NOT EXISTS idx_email_logs_lead ON email_logs(lead_id);
    CREATE INDEX IF NOT EXISTS idx_email_logs_sender ON email_logs(sender_id);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_lead ON agent_actions(lead_id);
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_lead ON pending_approvals(lead_id);
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status);
    CREATE INDEX IF NOT EXISTS idx_estimates_lead ON estimates(lead_id);
    CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);
    CREATE INDEX IF NOT EXISTS idx_playbook_examples_lead ON playbook_examples(source_lead_id);
  `);
  console.log('✅ Database tables ready');
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/webhook', require('./routes/webhook'));
app.use('/webhooks/brevo', require('./routes/brevoWebhook'));
app.use('/unsubscribe', require('./routes/unsubscribe'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/groups', require('./routes/groups'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/agent', require('./routes/agent'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/email-senders', require('./routes/emailSenders'));
app.use('/api/sequences', require('./routes/sequences'));
app.use('/api/estimates', require('./routes/estimates'));
app.use('/api/portfolio-items', require('./routes/portfolio'));
app.use('/api/email-conversations', require('./routes/emailConversations'));
app.use('/api/proposals', require('./routes/proposals'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Start background workers
require('./workers/campaignWorker');
require('./workers/sequenceEmailWorker');
require('./workers/emailReplyWorker');
require('./workers/emailVerificationWorker');
require('./workers/playbookInsightsWorker');
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
