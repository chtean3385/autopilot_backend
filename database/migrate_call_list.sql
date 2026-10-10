-- Call list (2026-10-10): directory leads WhatsApp can't reach (Meta refused a template) and that have no
-- usable email are flagged here for the owner to phone directly. Leads page → "📞 Call list" tab.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS call_needed_at TIMESTAMP;
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS call_reason TEXT;
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS call_done_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_leads_call_needed ON hotel_leads(call_needed_at) WHERE call_done_at IS NULL;
