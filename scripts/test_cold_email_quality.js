// Directory cold-email quality check: composes a FIRST-attempt draft for each lead in a fixtures file
// and scores it with the strict human-tone scorer — nothing is sent. Uses real OpenAI calls.
//   node scripts/test_cold_email_quality.js <fixtures.json> [stepNumber]
// fixtures.json = [{ id, hotel_name, owner_name, city, business_category, niche, website, email, research }]
require('dotenv').config();
const fs = require('fs');
const { composeEmail } = require('../workers/sequenceEmailWorker');
const ReplyQualityService = require('../services/replyQualityService');
const { WRITING_RULES } = require('../utils/humanTone');
const pool = require('../config/db');

function firstName(lead) {
  const parts = String(lead.owner_name || '').trim().split(/\s+/)
    .filter((p) => p && !/^(mr|mrs|ms|dr|shri|smt|m\/s)\.?$/i.test(p));
  return parts.length ? parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase() : 'there';
}

(async () => {
  const leads = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const stepNumber = Number(process.argv[3] || 0);
  const scores = [];
  for (const lead of leads) {
    const trade = lead.niche || lead.business_category || 'their line of business';
    const guidance = `${WRITING_RULES}\nThis owner's trade: ${trade}. ` +
      `Use their first name (${firstName(lead)}) and refer to something real about running a ${trade} business.` +
      (stepNumber > 0 ? ' This is not the first email: ask only ONE question, the closing yes/no one.' : '');
    const { subject, body } = await composeEmail(lead, stepNumber, [], null, lead.research, [], null, guidance, { humanTone: true });
    const { score, feedback } = await ReplyQualityService.scoreColdEmail({
      leadId: null, lead, subject, body, stepNumber, strict: true,
    });
    scores.push(score);
    console.log(`\n=== ${lead.id} ${lead.hotel_name} (${trade}) — ${score}/5\nSubject: ${subject}\n${body}\n>> ${feedback}`);
  }
  const pass = scores.filter((s) => s >= 4.5).length;
  console.log(`\nFirst-attempt: ${pass}/${scores.length} at >= 4.5 | 5.0: ${scores.filter((s) => s >= 5).length} | avg ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)}`);
  await pool.end();
  process.exit(0); // the worker module starts its own schedule on require
})().catch((err) => { console.error(err); process.exit(1); });
