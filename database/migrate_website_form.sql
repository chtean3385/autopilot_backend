-- Website contact-form leads (routes/websiteLeads.js): raw form fields + when last submitted.
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS website_form JSONB;
ALTER TABLE hotel_leads ADD COLUMN IF NOT EXISTS website_form_at TIMESTAMP;
