// EMAIL_ALLOW_NO_WEBSITE (2026-11-22): a sequence lead with a free-mail address and no website
//  - setting off → stopped 'no_research_possible' (old rule, unchanged)
//  - setting on  → emailed, written from CRM info (composer's no-research branch)
// Throwaway test DB, OUTBOUND_DRY_RUN, OpenAI stubbed. Usage: node scripts/test_no_website_email.js
require('dotenv').config();
const u = new URL(process.env.DATABASE_URL);
u.pathname = `/${process.env.TEST_DB_NAME || 'autoagent_overnight'}`;
process.env.DATABASE_URL = u.toString();
process.env.OUTBOUND_DRY_RUN = 'true';
process.env.WABA_API_TOKEN = '';
process.env.BACKEND_URL = process.env.BACKEND_URL || 'https://bot.example.test';

const aiUsage = require('../utils/aiUsage');
const prompts = [];
aiUsage.trackedCompletion = async (client, params, { purpose } = {}) => {
  if (purpose === 'sequence_email_compose') prompts.push(params.messages[0].content);
  const answers = {
    sequence_email_compose: { subject: 'quick question', body: 'Hi Ramesh, how do most new customers find your shop in Surat today?' },
    cold_email_score: { score: 5, feedback: 'ok' },
  };
  return { choices: [{ message: { content: JSON.stringify(answers[purpose] || {}) } }], usage: {} };
};

const pool = require('../config/db');
const { setSetting } = require('../services/settingsService');
const { runSequenceForLead } = require('../workers/sequenceEmailWorker');

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); if (!ok) failed++; };
const tag = `nw${Date.now().toString(36)}`;

(async () => {
  await setSetting('EMAIL_FRESH_START_AT', '');
  await setSetting('FRESH_RESEND_ENABLED', 'false');
  await setSetting('EMAIL_SENDER_MIN_GAP_MINUTES', '0');
  await setSetting('COLD_EMAIL_EXCLUDE_SENDER_IDS', '');
  await pool.query(`UPDATE email_senders SET status = 'paused'`);
  await pool.query(
    `INSERT INTO email_senders (label, provider, smtp_config, from_name, from_email, daily_cap, status, warmup_started_at)
     VALUES ($1, 'smtp', $2, 'T', $3, 50, 'active', NOW() - INTERVAL '60 days')`,
    [`${tag}-smtp`, JSON.stringify({ host: 'h', port: 465, user: 'u', pass: 'p' }), `s.${tag}@example.com`]);
  const seq = (await pool.query(`INSERT INTO sequences (name, initial_gaps, recurring_interval_days, active) VALUES ($1, '[7]', 7, true) RETURNING id`, [`${tag}-seq`])).rows[0].id;

  async function mk(name) {
    const id = (await pool.query(
      `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, source, status, channel, email_status, website, business_category)
       VALUES ($1, 'Ramesh', $2, '', 'Surat', 'test', 'new', 'email', 'verified', '', 'Textile shop') RETURNING id`,
      [`${tag} ${name}`, `ramesh.${name}.${tag}@gmail.com`])).rows[0].id;
    await pool.query(`INSERT INTO lead_sequences (lead_id, sequence_id, current_step, status, next_run_at) VALUES ($1, $2, 0, 'active', NOW())`, [id, seq]);
    return id;
  }

  await setSetting('EMAIL_ALLOW_NO_WEBSITE', '');
  const off = await mk('off');
  const r1 = await runSequenceForLead(off);
  const ls1 = (await pool.query(`SELECT status, paused_reason FROM lead_sequences WHERE lead_id = $1`, [off])).rows[0];
  check('setting off → stopped no_research_possible (old rule)', ls1.status === 'dead' && ls1.paused_reason === 'no_research_possible', JSON.stringify(ls1));
  check('setting off → nothing sent', (await pool.query(`SELECT COUNT(*)::int n FROM email_logs WHERE lead_id = $1`, [off])).rows[0].n === 0);

  await setSetting('EMAIL_ALLOW_NO_WEBSITE', 'true');
  const on = await mk('on');
  const r2 = await runSequenceForLead(on);
  check('setting on → sent', r2.outcome === 'sent', JSON.stringify(r2.outcome));
  const log = (await pool.query(`SELECT subject, sender_id, tracking_token FROM email_logs WHERE lead_id = $1 AND direction = 'out'`, [on])).rows[0];
  check('email logged with tracking token', Boolean(log && log.tracking_token));
  const p = prompts[prompts.length - 1] || '';
  check('composer used the no-research branch', /No website research is available/i.test(p));
  check('composer had the trade and city', /Textile shop/.test(p) && /Surat/.test(p));

  await setSetting('EMAIL_ALLOW_NO_WEBSITE', '');
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
