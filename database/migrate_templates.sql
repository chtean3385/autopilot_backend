-- Add meta_template_id and examples columns to waba_templates
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS meta_template_id VARCHAR(100);
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS examples JSON;
