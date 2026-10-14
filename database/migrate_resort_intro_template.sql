-- Dream Stay: owner-picked first-touch template for a send (used for Past enquiry leads).
ALTER TABLE resort_pipeline ADD COLUMN IF NOT EXISTS intro_template_id INT; -- owner-picked first-touch template (Past enquiry sends)
