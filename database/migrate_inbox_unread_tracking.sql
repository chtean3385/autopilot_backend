-- WhatsApp Inbox "real unread badge" support (routes/inbox.js, frontend InboxView.jsx):
-- stamped to NOW() whenever the admin opens a lead's thread, so GET /api/inbox can compute a
-- true per-conversation unread count (replies received after the thread was last opened),
-- the same way a real messaging app's read receipt works.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS inbox_last_read_at TIMESTAMP;
