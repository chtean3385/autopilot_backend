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
    channel VARCHAR(20) DEFAULT 'whatsapp', -- 'whatsapp', 'email', 'linkedin'
    website VARCHAR(500),
    email_status VARCHAR(30) DEFAULT 'unknown', -- unknown | found | verified | unverifiable | bounced | unsubscribed
    email_source VARCHAR(50), -- scraped | domain_list | import | hunter | snov | linkedin
    email_verify_attempts INT DEFAULT 0, -- hourly re-verification worker attempt counter (max 3)
    last_verify_attempt_at TIMESTAMP,
    status VARCHAR(50) DEFAULT 'new', -- 'new', 'interested', 'demo_qualified', 'responded', 'no_response'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lead Groups (used by both WhatsApp campaigns and email agent tasks to bundle scraped leads)
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
    target_type VARCHAR(20) DEFAULT 'city',
    group_id INT REFERENCES lead_groups(id),
    system_prompt TEXT,
    business_type VARCHAR(100),
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

-- Email sending identities (multi-domain, multi-provider)
CREATE TABLE IF NOT EXISTS email_senders (
    id SERIAL PRIMARY KEY,
    label VARCHAR(100) NOT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'brevo', -- 'brevo', 'smtp'
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
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'paused', 'burned'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Follow-up cadence definitions
CREATE TABLE IF NOT EXISTS sequences (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    channel VARCHAR(20) DEFAULT 'email',
    initial_gaps JSON, -- e.g. [1,2,3] days between first follow-ups
    recurring_interval_days INT DEFAULT 7, -- e.g. 7 (weekly) or 3 (twice a week)
    daily_send_limit INT DEFAULT 20,
    sent_today INT DEFAULT 0,
    last_reset_date DATE,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Agent Tasks Table (both channels: WhatsApp uses template_id/campaign_id, email uses sequence_id/group_id)
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
  channel VARCHAR(20) DEFAULT 'whatsapp',
  sequence_id INTEGER REFERENCES sequences(id),
  group_id INTEGER REFERENCES lead_groups(id),
  emails_found INTEGER DEFAULT 0,
  emails_verified INTEGER DEFAULT 0,
  leads_enrolled INTEGER DEFAULT 0,
  parsed_params JSON,
  clarification_questions JSON,
  clarification_answers JSON,
  refined_instruction TEXT,
  refinement_note TEXT,
  system_prompt TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Per-lead progress through a sequence
CREATE TABLE IF NOT EXISTS lead_sequences (
    id SERIAL PRIMARY KEY,
    lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
    sequence_id INT REFERENCES sequences(id) ON DELETE CASCADE,
    sender_id INT REFERENCES email_senders(id),
    current_step INT DEFAULT 0,
    next_run_at TIMESTAMP,
    status VARCHAR(30) DEFAULT 'active', -- 'active', 'paused', 'waiting_estimate', 'dead'
    paused_reason TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sent/received email history
CREATE TABLE IF NOT EXISTS email_logs (
    id SERIAL PRIMARY KEY,
    lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
    sender_id INT REFERENCES email_senders(id),
    sequence_id INT REFERENCES sequences(id),
    direction VARCHAR(5) NOT NULL, -- 'out', 'in'
    subject VARCHAR(500),
    body TEXT,
    provider_message_id VARCHAR(255),
    sent_at TIMESTAMP,
    delivered_at TIMESTAMP,
    opened_at TIMESTAMP,
    clicked_at TIMESTAMP,
    bounced_at TIMESTAMP,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Agent decision log (visible in Analytics)
CREATE TABLE IF NOT EXISTS agent_actions (
    id SERIAL PRIMARY KEY,
    lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    -- reply_analyzed | draft_created | draft_scored | draft_sent |
    -- draft_queued_human | portfolio_sent | estimate_flagged | sequence_stopped ...
    detail JSON,
    draft_text TEXT,
    score INT,
    decision VARCHAR(30),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Human-in-the-loop queue (estimates, low-score replies, future linkedin_comment)
CREATE TABLE IF NOT EXISTS pending_approvals (
    id SERIAL PRIMARY KEY,
    type VARCHAR(30) NOT NULL, -- 'estimate', 'low_score_reply', 'linkedin_comment'
    lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
    payload JSON,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    decided_at TIMESTAMP
);

-- Owner-approved estimates sent to leads
CREATE TABLE IF NOT EXISTS estimates (
    id SERIAL PRIMARY KEY,
    lead_id INT REFERENCES hotel_leads(id) ON DELETE CASCADE,
    approval_id INT REFERENCES pending_approvals(id),
    line_items JSON,
    total DECIMAL(10, 2),
    html TEXT,
    status VARCHAR(20) DEFAULT 'draft', -- 'draft', 'approved', 'sent'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Portfolio links for auto-reply (website scrape cache + bulk-added projects)
CREATE TABLE IF NOT EXISTS portfolio_items (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    url VARCHAR(500),
    description TEXT,
    tags VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Emails that must never enter a sequence (unsubscribed/bounced)
CREATE TABLE IF NOT EXISTS suppression_list (
    email VARCHAR(255) PRIMARY KEY,
    reason VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Few-shot examples + corrections + weekly insights for drafting prompts
CREATE TABLE IF NOT EXISTS playbook_examples (
    id SERIAL PRIMARY KEY,
    kind VARCHAR(20) NOT NULL, -- 'few_shot', 'insight', 'correction'
    context TEXT,
    example TEXT,
    source_lead_id INT REFERENCES hotel_leads(id),
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Cached per-lead company research (one GPT-5.5 call, researchCompany() in leadResearchService.js) —
-- email drafting, reply QA, and intent classification stay on gpt-4o-mini elsewhere and just read this.
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
  confidence_breakdown JSON,
  schema_version INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_research_lead_id ON lead_research(lead_id);

-- Append-only history of every researchCompany() run (lead_research keeps only the current one;
-- see migrate_lead_research_v3.sql). Never updated or pruned.
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

-- Per-call GPT usage/billing log (utils/aiUsage.js trackedCompletion). lead_id is
-- ON DELETE SET NULL — billing history survives lead deletion, unlike agent_actions.
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

-- Tracks the last run of each background scheduler/worker job (WhatsApp follow-ups,
-- email sequence worker, ...) so the UI can show "last ran: X" and prove a Render-sleep
-- window didn't silently swallow a scheduled run.
CREATE TABLE IF NOT EXISTS scheduler_status (
    job_name VARCHAR(50) PRIMARY KEY,
    last_ran_at TIMESTAMP,
    last_trigger VARCHAR(20),
    last_summary JSON,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_leads_city ON hotel_leads(city);
CREATE INDEX IF NOT EXISTS idx_leads_status ON hotel_leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_channel ON hotel_leads(channel);
CREATE INDEX IF NOT EXISTS idx_outreach_lead ON outreach_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_outreach_campaign ON outreach_logs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_outreach_sent_at ON outreach_logs(sent_at);
CREATE INDEX IF NOT EXISTS idx_template_status ON waba_templates(status);
CREATE INDEX IF NOT EXISTS idx_senders_status ON email_senders(status);
CREATE INDEX IF NOT EXISTS idx_lead_sequences_lead ON lead_sequences(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_sequences_sender ON lead_sequences(sender_id);
CREATE INDEX IF NOT EXISTS idx_lead_sequences_status ON lead_sequences(status);
CREATE INDEX IF NOT EXISTS idx_email_logs_lead ON email_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_sender ON email_logs(sender_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_provider_message_id ON email_logs(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_agent_actions_lead ON agent_actions(lead_id);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_lead ON pending_approvals(lead_id);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status);
CREATE INDEX IF NOT EXISTS idx_estimates_lead ON estimates(lead_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);
CREATE INDEX IF NOT EXISTS idx_playbook_examples_lead ON playbook_examples(source_lead_id);
