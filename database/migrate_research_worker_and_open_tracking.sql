-- workers/researchWorker.js's retry bookkeeping (dedicated research cron, decoupled from
-- sequenceEmailWorker.js's send tick) + email_logs open-count tracking (routes/tracking.js
-- previously only stamped a single opened_at timestamp, no count of repeat opens).
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS research_attempts INT DEFAULT 0;
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS last_research_attempt_at TIMESTAMP;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS open_count INT DEFAULT 0;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMP;
