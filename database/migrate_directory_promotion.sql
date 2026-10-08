-- Directory outreach, step 2 (_docs/directory-outreach-plan.md): directory_entries are promoted into
-- hotel_leads with cadence_managed = TRUE. Those leads are contacted ONLY by the cross-channel
-- cadence worker — campaigns, WhatsApp follow-ups and manual sequence enrollment all skip them, so a
-- lead can never get two channels (or two engines) at once.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS cadence_managed BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_leads_whatsapp_number ON hotel_leads(whatsapp_number);
CREATE INDEX IF NOT EXISTS idx_leads_cadence_managed ON hotel_leads(cadence_managed) WHERE cadence_managed = TRUE;
-- Optional per-source keyword filter (comma-separated, matched against category/products/company);
-- empty = promote every entry. Lets one mixed directory (e.g. GECA's 100+ categories) feed one niche.
ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS category_filter TEXT;
-- The niche of the directory a lead came from — picks that niche's WhatsApp templates.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS niche VARCHAR(100);
