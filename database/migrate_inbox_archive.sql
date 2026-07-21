-- Inbox conversation archiving: archived chats move to a WhatsApp-style
-- "Archived" box at the top of the Inbox and stop counting toward the
-- unread badge. Archiving is UI organization only — it does not change
-- lead status or affect sending/follow-ups.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
