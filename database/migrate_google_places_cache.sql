-- Caches Google Place Details responses by place_id so re-running an agent task for a
-- city+businessType we've already scraped (e.g. "hotels in Gandhinagar" a second time)
-- doesn't re-pay for a Details lookup on places we've already resolved — Text Search
-- itself is cheap/uncapped-ish, but Details is the billed call and Text Search tends to
-- return the same top-ranked places for the same query, so most were being wasted on
-- known duplicates. See schedulerService.js scrapeLeads/scrapePlacesForWebsites.

CREATE TABLE IF NOT EXISTS google_places_details_cache (
  place_id VARCHAR(255) PRIMARY KEY,
  name TEXT,
  formatted_phone_number TEXT,
  international_phone_number TEXT,
  website TEXT,
  cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
