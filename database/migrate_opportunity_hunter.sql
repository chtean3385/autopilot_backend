-- Opportunity Hunter (2026-11-19, _docs/opportunity-hunter.md): WhatsApp groups/channels are read
-- (read-only, never sent to) → posts qualified by AI → freelance/project posts with an email get one
-- intro email draft; phone-only posts get a WhatsApp message the owner copies and sends by hand.
-- Leads created from sent applications are hotel_leads.pipeline = 'opportunity', which every other
-- send path already skips (pipeline IS NULL filters). Additive + idempotent.

CREATE TABLE IF NOT EXISTS opportunity_sources (
    id SERIAL PRIMARY KEY,
    link TEXT NOT NULL UNIQUE,
    kind VARCHAR(10) NOT NULL,                       -- group | channel
    invite_code TEXT,
    jid TEXT,                                        -- 123@g.us | 123@newsletter, set once joined
    name TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending | joined | error
    error TEXT,
    last_message_at TIMESTAMP,
    last_polled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_opp_sources_jid ON opportunity_sources(jid);

CREATE TABLE IF NOT EXISTS opportunity_messages (
    id SERIAL PRIMARY KEY,
    source_id INT REFERENCES opportunity_sources(id) ON DELETE SET NULL,
    chat_jid TEXT,
    wa_message_id TEXT,
    sender TEXT,
    text TEXT NOT NULL,
    text_hash VARCHAR(64) NOT NULL,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending | filtered_out | duplicate | analyzed | error
    attempts INT NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_opp_messages_wa ON opportunity_messages(chat_jid, wa_message_id);
CREATE INDEX IF NOT EXISTS idx_opp_messages_status ON opportunity_messages(status);

CREATE TABLE IF NOT EXISTS opportunities (
    id SERIAL PRIMARY KEY,
    message_id INT REFERENCES opportunity_messages(id) ON DELETE SET NULL,
    text_hash VARCHAR(64) NOT NULL UNIQUE,           -- same post forwarded to many groups = one opportunity
    source_name TEXT,
    post_text TEXT NOT NULL,
    title TEXT,
    engagement_type VARCHAR(30),                     -- freelance | project | staff_augmentation | job_vacancy | not_opportunity | unclear
    decision VARCHAR(10),                            -- email | manual | skip
    skip_reason TEXT,
    score INT,
    score_breakdown JSONB,
    explicit JSONB,
    inferred JSONB,
    unknown JSONB,
    email TEXT,
    phone TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',     -- draft | sending | sent | failed | replied | manual | manual_sent | skipped | rejected
    draft_subject TEXT,
    draft_body TEXT,
    draft_warning TEXT,                              -- e.g. draft mentions a price → never auto-sent
    wa_draft TEXT,
    lead_id INT REFERENCES hotel_leads(id) ON DELETE SET NULL,
    sender_id INT,
    sent_at TIMESTAMP,
    error TEXT,
    replied_at TIMESTAMP,
    wa_sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_lead ON opportunities(lead_id);
