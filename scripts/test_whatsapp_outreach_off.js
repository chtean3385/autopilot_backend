// WHATSAPP_OUTREACH_ENABLED=false (2026-11-22): no WhatsApp we start ourselves; leads wait quietly.
// Throwaway test DB, OUTBOUND_DRY_RUN, OpenAI stubbed. Usage: node scripts/test_whatsapp_outreach_off.js
require('dotenv').config();
const u = new URL(process.env.DATABASE_URL);
u.pathname = `/${process.env.TEST_DB_NAME || 'autoagent_overnight'}`;
process.env.DATABASE_URL = u.toString();
process.env.OUTBOUND_DRY_RUN = 'true';
process.env.WHATSAPP_PAUSED = 'false'; // so only the new switch can be what blocks
process.env.WABA_API_TOKEN = '';
process.env.BACKEND_URL = process.env.BACKEND_URL || 'https://bot.example.test';

const aiUsage = require('../utils/aiUsage');
aiUsage.trackedCompletion = async (client, params, { purpose } = {}) => {
  const answers = {
    sequence_email_compose: { subject: 'quick question', body: 'Hi Mehul, how do new buyers usually find your workshop in Rajkot today?' },
    cold_email_score: { score: 5, feedback: 'ok' },
    followup_template_pick: {},
  };
  return { choices: [{ message: { content: JSON.stringify(answers[purpose] || {}) } }], usage: {} };
};

const pool = require('../config/db');
const { setSetting } = require('../services/settingsService');
const WABAService = require('../services/wabaService');
const { runFollowUps } = require('../services/schedulerService');
const { runCadence } = require('../services/cadenceService');
const resort = require('../services/resortPipelineService');

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); if (!ok) failed++; };
const tag = `wa${Date.now().toString(36)}`;

(async () => {
  await setSetting('WHATSAPP_OUTREACH_ENABLED', 'false');
  await setSetting('CADENCE_ENABLED', 'true');
  await setSetting('EMAIL_FRESH_START_AT', '');
  await setSetting('FRESH_RESEND_ENABLED', 'false');
  await setSetting('EMAIL_SENDER_MIN_GAP_MINUTES', '0');
  await setSetting('COLD_EMAIL_EXCLUDE_SENDER_IDS', '');
  await setSetting('EMAIL_ALLOW_NO_WEBSITE', 'true');
  await pool.query(`UPDATE email_senders SET status = 'paused'`);
  await pool.query(
    `INSERT INTO email_senders (label, provider, smtp_config, from_name, from_email, daily_cap, status, warmup_started_at)
     VALUES ($1, 'smtp', $2, 'T', $3, 50, 'active', NOW() - INTERVAL '60 days')`,
    [`${tag}-smtp`, JSON.stringify({ host: 'h', port: 465, user: 'u', pass: 'p' }), `s.${tag}@example.com`]);

  // 1. backstop
  const r = await WABAService.sendPersonalizedTemplate({ id: 0, whatsapp_number: '919999999999' }, { template_name: 'x' });
  check('sendPersonalizedTemplate refuses', r.success === false && r.outreachOff === true, JSON.stringify(r));

  // 2. jobs skip
  const fu = await runFollowUps('manual');
  check('12 pm follow-ups skip', fu && fu.skipped === 'whatsapp_outreach_off', JSON.stringify(fu));
  // campaignWorker.runCampaignTick is not exported (its gate is the first line of the function).
  const qt = await resort.runQueueTick();
  check('Dream Stay send queue skips', qt && qt.skipped === 'whatsapp_outreach_off', JSON.stringify(qt));

  // 3. cadence: WhatsApp-only lead waits quietly; WhatsApp + no-website gmail lead gets EMAIL
  async function mk(name, { email = '', wa = '' } = {}) {
    return (await pool.query(
      `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, source, status, channel, email_status, website, business_category, cadence_managed)
       VALUES ($1, 'Mehul Patel', $2, $3, 'Rajkot', 'directory', 'new', 'whatsapp', $4, '', 'Engineering workshop', TRUE) RETURNING id`,
      [`${tag} ${name}`, email, wa, email ? 'verified' : 'unknown'])).rows[0].id;
  }
  const waOnly = await mk('waonly', { wa: '919812345670' });
  const both = await mk('both', { wa: '919812345671', email: `mehul.${tag}@gmail.com` });
  await pool.query(`INSERT INTO lead_cadence (lead_id, current_channel, first_channel, cycle_start_channel, status, next_touch_at) VALUES ($1, 'whatsapp', 'whatsapp', 'whatsapp', 'active', NOW()), ($2, 'whatsapp', 'whatsapp', 'whatsapp', 'active', NOW())`, [waOnly, both]);
  await runCadence('manual');
  const c1 = (await pool.query(`SELECT status, last_wait_reason FROM lead_cadence WHERE lead_id = $1`, [waOnly])).rows[0];
  const h1 = (await pool.query(`SELECT call_needed_at FROM hotel_leads WHERE id = $1`, [waOnly])).rows[0];
  const wa1 = (await pool.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE lead_id = $1`, [waOnly])).rows[0].n;
  check('WhatsApp-only lead: no WhatsApp sent', wa1 === 0);
  check('WhatsApp-only lead: waits quietly (still active, reason whatsapp_outreach_off)', c1.status === 'active' && c1.last_wait_reason === 'whatsapp_outreach_off', JSON.stringify(c1));
  check('WhatsApp-only lead: NOT put on the Call list', !h1.call_needed_at);
  const wa2 = (await pool.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE lead_id = $1`, [both])).rows[0].n;
  const em2 = (await pool.query(`SELECT COUNT(*)::int n FROM email_logs WHERE lead_id = $1 AND direction = 'out' AND error IS NULL`, [both])).rows[0].n;
  check('WhatsApp + email lead: no WhatsApp sent', wa2 === 0);
  check('WhatsApp + email lead: got an email instead', em2 === 1, `emails=${em2}`);

  // 4. switch back on: follow-ups no longer skip because of the switch
  await setSetting('WHATSAPP_OUTREACH_ENABLED', 'true');
  const fu2 = await runFollowUps('manual');
  check('switch on: follow-ups no longer skipped by the switch', !(fu2 && fu2.skipped === 'whatsapp_outreach_off'));

  await setSetting('EMAIL_ALLOW_NO_WEBSITE', '');
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
