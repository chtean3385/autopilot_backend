-- Auto-enroll + "why is this lead waiting" (2026-10-08). Additive and idempotent.
-- A lead saved with a sequence picked (Bulk Domain List, Google Places agent task) whose email isn't
-- verified yet is enrolled automatically the moment it becomes verified (workers/emailVerificationWorker.js).
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS enroll_sequence_id INT REFERENCES sequences(id) ON DELETE SET NULL;
-- Why a directory lead's next touch was postponed (awaiting_research, no_sender_capacity, send_failed…),
-- shown on Lead Sources. Cleared when a touch is sent.
ALTER TABLE lead_cadence ADD COLUMN IF NOT EXISTS last_wait_reason VARCHAR(40);
