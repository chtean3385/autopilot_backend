-- Email Conversations "real unread badge" support (routes/emailConversations.js):
-- stamped to NOW() whenever the admin opens a lead's email thread, so GET /api/email-conversations/count
-- can compute a true unread count (a reply that arrived after the thread was last opened), the
-- same way WhatsApp Inbox's inbox_last_read_at already works (migrate_inbox_unread_tracking.sql).
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_last_read_at TIMESTAMP;
