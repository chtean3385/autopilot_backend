-- Directory outreach, step 4 (_docs/directory-outreach-plan.md): WhatsApp template pool for directory
-- leads (industry = 'directory'). auto_generated marks drafts the system wrote (seed or GPT) so the
-- Templates page can show them for review; rejection_reason keeps Meta's reason when one is rejected.
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
-- Template groups: one message idea (angle) written as 2-3 variants. A lead never gets two variants
-- of the same group; sends rotate across variants. quality_score = the AI reviewer's 0-5 score.
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS template_group VARCHAR(80);
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS variant INT;
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS quality_score NUMERIC(2,1);
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS quality_note TEXT;
ALTER TABLE waba_templates ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP;
