-- Email Conversations archive (2026-11-27): archived threads move to an "Archived" box and stop
-- counting toward the Email unread badge. Set automatically when a lead replies "no"/not interested
-- (the cadence/sequence is already stopped by then), cleared when the lead writes again.
-- Separate from hotel_leads.archived_at (the WhatsApp Inbox's archive). Additive + idempotent.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_archived_at TIMESTAMP;
