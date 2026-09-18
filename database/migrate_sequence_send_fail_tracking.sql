-- Tracks consecutive send failures per lead_sequences row (workers/sequenceEmailWorker.js), so a
-- transient send error (network blip, provider outage) gets a bounded number of hourly retries
-- instead of retrying forever. Reset to 0 on every successful send. A synchronous "invalid
-- recipient" rejection from Brevo (e.g. "email is not valid in to") skips this counter entirely
-- and kills the sequence immediately, since retrying the same bad address can never succeed.
ALTER TABLE lead_sequences ADD COLUMN IF NOT EXISTS send_fail_count INT DEFAULT 0;
