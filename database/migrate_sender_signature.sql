-- Per-mailbox email signature (services/emailSenderService.js signatureFor): appended to cold
-- emails and AI replies sent from that sender. Empty = EMAIL_SIGNATURE setting, else the default
-- built from the sender's From name + Dreams Technology phone + website.
ALTER TABLE email_senders ADD COLUMN IF NOT EXISTS signature TEXT;
