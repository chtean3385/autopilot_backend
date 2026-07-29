-- 1. Templates can now be scoped to an industry (mirrors sales_agents.industry), so
--    follow-up sends stop blindly reusing "whatever was approved most recently" for
--    every lead regardless of business_category. NULL/'all' = generic, usable by any lead.
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS industry VARCHAR(100);

-- 2. Run-level lock for background jobs (starting with WhatsApp follow-ups) so an
--    overlapping cron tick — e.g. more than one backend instance alive at once — can't
--    both pick up the same due leads and double-send. Self-heals: a stale lock (crash
--    mid-run) is reclaimed after 10 minutes rather than blocking the job forever.
CREATE TABLE IF NOT EXISTS job_locks (
    job_name VARCHAR(100) PRIMARY KEY,
    locked_at TIMESTAMP NOT NULL
);
