-- Needs-attention flag: pulls a lead out of AI auto-reply and into a human queue when the
-- lead asks for something the bot can't handle (a callback, a portfolio) or gets qualified.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS needs_attention BOOLEAN DEFAULT FALSE;
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS needs_attention_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_needs_attention ON hotel_leads(needs_attention) WHERE needs_attention = TRUE;
