-- Fixes a bug where the WhatsApp-channel lead scraper (schedulerService.js scrapeLeads/
-- saveLeads) and the manual "Search Leads" preview (routes/leads.js GET /search) stored the
-- Google Places website URL into hotel_leads.email instead of hotel_leads.website — leaving
-- website blank and email holding a URL (never a real contact address) for every such lead.
-- That also caused those leads to be mis-marked email_status='found' (LeadService.addLeads
-- treats any truthy `email` as "an address was found").
--
-- Idempotent: after running once, no row matches `email ~* '^https?://'` any more (email is
-- cleared), so this is safe to run again or leave inlined in server.js initDB().
UPDATE hotel_leads
SET website = email, email = '', email_status = 'unknown', updated_at = NOW()
WHERE email ~* '^https?://' AND (website IS NULL OR website = '');
