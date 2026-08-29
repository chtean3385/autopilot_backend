-- AI-driven replies + hands-off Needs Attention + webhook idempotency (2026-08-29)
-- Additive / idempotent by convention (see backend/README.md) — safe to re-run.

-- A human explicitly took the lead over from the Inbox. Distinct from needs_attention:
-- a lead can be flagged for a human while the AI keeps answering so the customer never
-- waits; only ai_paused actually silences the bot.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS ai_paused BOOLEAN DEFAULT FALSE;

-- One row per inbound WhatsApp message id already handled — stops a Meta webhook
-- redelivery from making the agent reply twice.
CREATE TABLE IF NOT EXISTS processed_wa_messages (
    wa_message_id VARCHAR(255) PRIMARY KEY,
    processed_at TIMESTAMP DEFAULT NOW()
);

-- One-time repair: leads that already replied but were left tagged 'new' by the old
-- webhook (which never moved status on a reply). The cold-template follow-up job keys
-- off status = 'new', so these were getting the intro template re-sent every 2 days.
UPDATE hotel_leads SET status = 'responded', updated_at = NOW()
WHERE status = 'new'
  AND EXISTS (
    SELECT 1 FROM outreach_logs o
    WHERE o.lead_id = hotel_leads.id AND o.response_received = TRUE
  );
