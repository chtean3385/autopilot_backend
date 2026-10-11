-- Resort CRM (Dream Stay) pipeline, step 2 (_docs/resort-crm/plan.md): Meta-ad leads for our own hotel
-- CRM product. pipeline = 'resort_crm' leads are contacted ONLY by the resort CRM pipeline worker —
-- campaigns, WhatsApp follow-ups, the directory cadence and sequence enrollment all skip them.
-- ad_form keeps the lead-form answers (property type, rooms, current software, timeline, wants demo).
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS pipeline VARCHAR(30);
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS ad_form JSONB;
CREATE INDEX IF NOT EXISTS idx_leads_pipeline ON hotel_leads(pipeline) WHERE pipeline IS NOT NULL;
-- Task 6: per-lead pipeline state. Touches = WhatsApp templates sent (intro → follow-up → last), then
-- 'no_response'. Any reply → 'replied' (the Dream Stay agent owns the chat); a demo date/time agreed in
-- chat → 'demo_booked' with demo_slot (as agreed, e.g. "Thu 16 Oct, 4 pm").
CREATE TABLE IF NOT EXISTS resort_pipeline (
    lead_id INT PRIMARY KEY REFERENCES hotel_leads(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- active | replied | demo_booked | no_response | stopped | failed
    touches INT NOT NULL DEFAULT 0,
    next_touch_at TIMESTAMP,
    last_touch_at TIMESTAMP,
    last_template VARCHAR(100),
    demo_slot TEXT,
    demo_at TIMESTAMP,
    stop_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_resort_pipeline_due ON resort_pipeline(status, next_touch_at);
-- One-click "send to all" queue (2026-10-11): first messages go out one by one with a gap, independent of
-- RESORT_PIPELINE_ENABLED (the owner pressed the button); the regular tick never sends queued rows.
ALTER TABLE resort_pipeline ADD COLUMN IF NOT EXISTS queued BOOLEAN NOT NULL DEFAULT FALSE;
