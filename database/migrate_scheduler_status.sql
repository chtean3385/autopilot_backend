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
