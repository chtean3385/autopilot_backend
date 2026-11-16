-- When the lead LAST messaged us on WhatsApp. Meta only allows free-form (non-template) messages for
-- 24h after that; outside it only approved templates (error 131047 "Re-engagement message").
-- Set by routes/webhook.js on every inbound; read by WABAService.serviceWindow() so the app never
-- sends a free-form message it knows Meta will reject.
-- Additive + idempotent (the VPS deploy script re-applies every migrate_*.sql on each deploy): the
-- backfill only runs the one time the column is created.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'hotel_leads' AND column_name = 'last_inbound_at') THEN
    ALTER TABLE hotel_leads ADD COLUMN last_inbound_at TIMESTAMP;
    UPDATE hotel_leads l SET last_inbound_at = x.last_in
      FROM (SELECT lead_id, MAX(response_received_at) AS last_in FROM outreach_logs
            WHERE response_received = TRUE GROUP BY lead_id) x
      WHERE x.lead_id = l.id;
  END IF;
END $$;
