// Submits the `owner_alert` WhatsApp template to Meta for approval, and records it in
// waba_templates. Run once:  node backend/scripts/submit_owner_alert_template.js
//
// This is the template ownerAlertService.js uses for every owner/admin WhatsApp alert
// (new lead reply, buying signal, follow-up run summary, ...). Free-text alerts to the
// owner's own number are blocked by Meta outside a 24h window — a template is not.
//
// After Meta approves it (usually minutes; check Meta Business Manager → WhatsApp Manager
// → Message templates, or the CRM Templates tab), alerts start arriving with no further
// action. If Meta rejects UTILITY, re-run with WABA_ALERT_CATEGORY=MARKETING.
require('dotenv').config();
const WABAService = require('../services/wabaService');
const pool = require('../config/db');

const template = {
  template_name: 'owner_alert',
  template_category: process.env.WABA_ALERT_CATEGORY || 'UTILITY',
  body_text: '🔔 {{1}}\n\n{{2}}',
  examples: ['New lead reply', 'Sunrise Hotel (Jaipur) - +919812345678 - "what is the price?"'],
  footer_text: 'Dreams Technology CRM',
};

(async () => {
  console.log(`Submitting template "${template.template_name}" (${template.template_category}) to Meta...`);
  const res = await WABAService.submitTemplateToMeta(template);
  console.log(JSON.stringify(res, null, 2));

  if (res.success) {
    await pool.query(
      `INSERT INTO waba_templates (template_name, template_category, body_text, footer_text, examples, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'pending_approval', 'system')
       ON CONFLICT (template_name) DO UPDATE
         SET body_text = EXCLUDED.body_text,
             template_category = EXCLUDED.template_category,
             status = 'pending_approval',
             updated_at = NOW()`,
      [template.template_name, template.template_category, template.body_text,
       template.footer_text, JSON.stringify(template.examples)]
    );
    console.log('\nSaved to waba_templates as pending_approval. It will flip to approved automatically');
    console.log('via the Meta status webhook once approved (routes/webhook.js).');
  } else {
    console.error('\nSubmit failed. If the error mentions the category, re-run with:');
    console.error('  WABA_ALERT_CATEGORY=MARKETING node backend/scripts/submit_owner_alert_template.js');
  }
  process.exit(res.success ? 0 : 1);
})();
