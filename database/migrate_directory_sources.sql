-- Directory outreach, step 1 (_docs/directory-outreach-plan.md): public business directories
-- (e.g. industrial-association member lists) crawled into a holding area. Nothing here is a lead
-- yet — directory_entries rows are promoted to hotel_leads in a later step.
--   directory_sources     — one row per directory site; only status='approved' is ever crawled
--   directory_crawl_pages — per-source URL queue, so a crawl resumes after a restart (catch-up safe)
--   directory_entries     — one row per business extracted from a page
CREATE TABLE IF NOT EXISTS directory_sources (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    name VARCHAR(255),
    niche VARCHAR(100),
    city VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'suggested',
    suggested_by VARCHAR(20) NOT NULL DEFAULT 'manual',
    notes TEXT,
    robots_ok BOOLEAN,
    pages_total INT NOT NULL DEFAULT 0,
    pages_done INT NOT NULL DEFAULT 0,
    entries_found INT NOT NULL DEFAULT 0,
    last_crawled_at TIMESTAMP,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS directory_crawl_pages (
    id SERIAL PRIMARY KEY,
    source_id INT NOT NULL REFERENCES directory_sources(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    members_found INT NOT NULL DEFAULT 0,
    error TEXT,
    fetched_at TIMESTAMP,
    UNIQUE (source_id, url)
);
CREATE TABLE IF NOT EXISTS directory_entries (
    id SERIAL PRIMARY KEY,
    source_id INT NOT NULL REFERENCES directory_sources(id) ON DELETE CASCADE,
    page_url TEXT,
    company VARCHAR(255) NOT NULL,
    contact_person VARCHAR(255),
    contacts JSON DEFAULT '[]',
    phone_raw VARCHAR(100),
    phone_e164 VARCHAR(20),
    email VARCHAR(255),
    website VARCHAR(500),
    address TEXT,
    category VARCHAR(255),
    products TEXT,
    city VARCHAR(100),
    lead_id INT REFERENCES hotel_leads(id) ON DELETE SET NULL,
    skip_reason VARCHAR(50),
    promoted_at TIMESTAMP,
    imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_directory_entries_source_company ON directory_entries(source_id, LOWER(company));
CREATE INDEX IF NOT EXISTS idx_directory_entries_lead ON directory_entries(lead_id);
CREATE INDEX IF NOT EXISTS idx_directory_entries_phone ON directory_entries(phone_e164);
CREATE INDEX IF NOT EXISTS idx_directory_crawl_pages_status ON directory_crawl_pages(source_id, status);
CREATE INDEX IF NOT EXISTS idx_directory_sources_status ON directory_sources(status);
ALTER TABLE directory_crawl_pages ADD COLUMN IF NOT EXISTS depth INT; -- NULL = sitemap page (not expanded); 0..N = link depth in no-sitemap mode
