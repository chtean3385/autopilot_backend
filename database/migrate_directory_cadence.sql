-- Directory outreach, steps 3+5 (_docs/directory-outreach-plan.md): one row per cadence_managed lead —
-- the cross-channel cadence's state (which channel is current, touches so far, cycle, next touch).
-- status: active | resting (between cycles) | replied (lead answered on any channel — cadence stops
-- for good, a human/approval flow takes over) | stopped (opt-out, not interested, bounce, owner) | dead.
CREATE TABLE IF NOT EXISTS lead_cadence (
    lead_id INT PRIMARY KEY REFERENCES hotel_leads(id) ON DELETE CASCADE,
    current_channel VARCHAR(10),
    first_channel VARCHAR(10),
    cycle_start_channel VARCHAR(10),
    wa_unusable BOOLEAN NOT NULL DEFAULT FALSE,
    touches_on_channel INT NOT NULL DEFAULT 0,
    total_touches INT NOT NULL DEFAULT 0,
    cycle INT NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    next_touch_at TIMESTAMP,
    last_touch_at TIMESTAMP,
    last_channel VARCHAR(10),
    stop_reason VARCHAR(80),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lead_cadence_due ON lead_cadence(status, next_touch_at);
