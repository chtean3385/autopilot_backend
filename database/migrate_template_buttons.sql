-- WABA template buttons (Create Template form): [{type:'QUICK_REPLY'|'URL'|'PHONE_NUMBER', text, url?, phone_number?}]
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS buttons JSON;
