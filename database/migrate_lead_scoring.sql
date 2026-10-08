-- Lead completeness score (services/leadScoreService.js): 0-100 from the contact data we hold —
-- name, WhatsApp mobile, email (+ verified), website, category, contact person, address. All of them
-- = 100 = hot. Recomputed in SQL every 10 minutes, so it follows email verification/backfill changes.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS lead_score INT NOT NULL DEFAULT 0;
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS lead_tier VARCHAR(10) NOT NULL DEFAULT 'cold'; -- hot | warm | cold
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS address TEXT;
-- Website email lookup for directory leads promoted without an email (directoryPromotionService
-- backfillWebsiteEmails): retried up to 3 times, a day apart, so a site that was down once isn't lost.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_lookup_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS last_email_lookup_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_leads_score ON hotel_leads(lead_score DESC);
