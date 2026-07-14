-- Prevent duplicate leads sharing the same email address (case-insensitive).
-- Partial index so leads with no email ('' or NULL) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS hotel_leads_email_unique_idx
  ON hotel_leads (LOWER(email))
  WHERE email IS NOT NULL AND email <> '';
