-- 2026-11-22: keep mails.so's actual answer (deliverable | risky | unknown | undeliverable) and its reason
-- (e.g. catch_all, invalid_domain). Before this every non-"deliverable" answer collapsed into
-- email_status='unverifiable', so a usable catch-all business address looked the same as a dead domain.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_verify_result VARCHAR(20);
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS email_verify_reason VARCHAR(60);
