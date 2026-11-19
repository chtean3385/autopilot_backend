// One-off cleanup (2026-11-19): leads flagged Needs Attention only because their own WhatsApp
// Business bot replied ("Greetings from X", "Welcome to X", "Thank you for contacting X", menus,
// "share your details" forms). Re-runs the reply gate on each flagged lead's latest WhatsApp
// message; an AUTO_REPLY gets marked as such and the flag cleared (unless the lead has also sent a
// real reply). Dry run by default — prints what it would do.
//   cd /var/www/autoagent/backend && node scripts/clear_auto_reply_flags.js          # preview
//   cd /var/www/autoagent/backend && node scripts/clear_auto_reply_flags.js --apply  # do it
require('dotenv').config();
const pool = require('../config/db');
const { classifyReplyIntent, markAutoReply, getConversationHistory } = require('../services/salesAgentService');

const APPLY = process.argv.includes('--apply');

(async () => {
  const { rows } = await pool.query(`
    SELECT hl.id, hl.hotel_name, hl.needs_attention_reason, lr.response_text
    FROM hotel_leads hl
    JOIN LATERAL (
      SELECT response_text FROM outreach_logs
      WHERE lead_id = hl.id AND response_received = TRUE AND response_text IS NOT NULL
      ORDER BY response_received_at DESC NULLS LAST LIMIT 1
    ) lr ON TRUE
    WHERE hl.needs_attention = TRUE AND hl.ai_paused = FALSE
    ORDER BY hl.id`);
  console.log(`${rows.length} flagged leads with a WhatsApp reply. ${APPLY ? 'APPLYING.' : 'Dry run (add --apply).'}\n`);

  let cleared = 0;
  for (const lead of rows) {
    const history = await getConversationHistory(lead.id);
    const { gate, reason } = await classifyReplyIntent({ lead, message: lead.response_text, conversationHistory: history });
    const preview = lead.response_text.replace(/\s+/g, ' ').slice(0, 90);
    if (gate !== 'AUTO_REPLY') {
      console.log(`  keep   #${lead.id} ${lead.hotel_name} [${gate}] "${preview}"`);
      continue;
    }
    console.log(`  CLEAR  #${lead.id} ${lead.hotel_name} (${reason}) "${preview}"`);
    if (!APPLY) continue;
    await markAutoReply(lead.id);
    // markAutoReply only clears the auto-flag reasons; here we also clear whatever the old gate
    // called it, as long as this lead never sent a real (non-bot) reply.
    const r = await pool.query(
      `UPDATE hotel_leads SET needs_attention = FALSE, needs_attention_reason = NULL, updated_at = NOW()
       WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM outreach_logs o WHERE o.lead_id = $1 AND o.response_received = TRUE AND o.is_auto_reply IS NOT TRUE)`,
      [lead.id]);
    cleared += r.rowCount;
  }
  if (APPLY) console.log(`\nCleared ${cleared} flags.`);
  await pool.end();
})().catch((err) => { console.error(err.message); process.exit(1); });
