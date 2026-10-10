// One-time (2026-10-10): apply the "one failed WhatsApp = never WhatsApp again" rule to directory leads
// whose template already failed under the old 24h-retry rule. Each goes to email, or — with no usable
// email — stops and lands on Leads → "📞 Call list". Same code path as the Meta webhook.
//   node scripts/convert_failed_whatsapp.js          (dry run: counts only)
//   node scripts/convert_failed_whatsapp.js --apply
require('dotenv').config();
const pool = require('../config/db');
const { handleWhatsappSendFailed } = require('../services/cadenceService');

(async () => {
  const apply = process.argv.includes('--apply');
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (ol.lead_id) ol.lead_id, ol.error_message
     FROM outreach_logs ol
     JOIN hotel_leads hl ON hl.id = ol.lead_id
     JOIN lead_cadence lc ON lc.lead_id = ol.lead_id
     WHERE ol.error_message IS NOT NULL AND ol.message_type = 'template'
       AND hl.cadence_managed AND lc.status IN ('active', 'resting') AND NOT lc.wa_unusable
     ORDER BY ol.lead_id, ol.sent_at DESC`
  );
  console.log(`${rows.length} cadence lead(s) with a failed WhatsApp still on WhatsApp`);
  const outcomes = {};
  if (apply) {
    for (const r of rows) {
      const out = await handleWhatsappSendFailed(r.lead_id, r.error_message);
      outcomes[out] = (outcomes[out] || 0) + 1;
    }
    console.log(JSON.stringify(outcomes));
  }
  await pool.end();
  process.exit(0); // cadence/scheduler modules start their own jobs on require
})().catch((err) => { console.error(err); process.exit(1); });
