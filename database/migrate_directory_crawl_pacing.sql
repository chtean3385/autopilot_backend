-- Directory crawl pacing (2026-10-09): every site rests between crawl turns, and a site that stops
-- answering (rate block — idbf.in did this to the VPS and a laptop) is cooled down for hours instead
-- of being hammered. cooldown_until: not crawled before this time. block_count: blocks in a row
-- (cool-down doubles each time, capped). Idempotent.
ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMP;
ALTER TABLE directory_sources ADD COLUMN IF NOT EXISTS block_count INT NOT NULL DEFAULT 0;
