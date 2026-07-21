-- Fourth Sprint: self-hosted open/click tracking. Every outbound email gets a random token
-- stored here at send time; the HTML carries a 1x1 pixel and HMAC-signed rewritten links
-- pointing at routes/tracking.js (/t/o/:token, /t/c/:token), which stamp opened_at/clicked_at
-- via COALESCE — complementing the Brevo webhook, which only covers Brevo-provider sends.
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS tracking_token VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_email_logs_tracking_token ON email_logs(tracking_token);
