-- Email re-verification worker + Brevo delivery tracking
-- 1. Track verification attempts so the hourly worker doesn't re-check the same lead forever
-- 2. delivered_at on email_logs so Brevo webhook events can record delivery confirmation

ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_verify_attempts INT DEFAULT 0;
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS last_verify_attempt_at TIMESTAMP;

ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_email_logs_provider_message_id ON email_logs(provider_message_id);
