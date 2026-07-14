-- Email outreach channel: hotel_leads columns
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'whatsapp'; -- 'whatsapp', 'email', 'linkedin'
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS website VARCHAR(500);
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_status VARCHAR(30) DEFAULT 'unknown'; -- unknown | found | verified | bounced | unsubscribed
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_source VARCHAR(50); -- scraped | domain_list | import | hunter | snov | linkedin

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

-- Indexes
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
