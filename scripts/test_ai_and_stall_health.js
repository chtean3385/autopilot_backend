// Test for the OpenAI-outage warning + 2-day stall detector (2026-11-16):
// utils/aiUsage.js (401 expired key / 429 no credit → channel health 'openai'),
// services/cadenceHealthService.js (ai warning text, stall checks, daily repeat for stall-only alerts).
// Background: an expired OpenAI key (401) killed all GPT work for 10 days with no warning because only
// 429 billing errors were recognised.
//
// Throwaway test DB only; the OpenAI client is a fake — nothing leaves the machine.
// Run: TEST_DB_NAME=autoagent_overnight node scripts/test_ai_and_stall_health.js
require('dotenv').config();
const TEST_DB = process.env.TEST_DB_NAME || 'autoagent_overnight';
if (!/overnight|test/i.test(TEST_DB)) { console.error('Refusing: TEST_DB_NAME must be a throwaway test DB'); process.exit(1); }
const u = new URL(process.env.DATABASE_URL);
u.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = u.toString();
process.env.OWNER_WHATSAPP = ''; // owner alerts become a logged no-op
process.env.WABA_API_TOKEN = 'test'; process.env.WABA_PHONE_ID = 'test';

const pool = require('../config/db');
const channelHealth = require('../utils/channelHealth');
const aiUsage = require('../utils/aiUsage');
const { trackedCompletion, isAiOutageError } = aiUsage;
aiUsage.probeKey = async () => ({ ok: true }); // the hourly probe makes a real (free) OpenAI call — never in a test
const { getHealth, sendUrgentAlert } = require('../services/cadenceHealthService');
const settings = require('../services/settingsService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const warnFor = async (area, level) => (await getHealth()).warnings.find((w) => w.area === area && (!level || w.level === level));
const fakeClient = (impl) => ({ apiKey: 'x', chat: { completions: { create: impl } } });
const apiErr = (status, message, code) => Object.assign(new Error(message), { status, code });
const call = (client) => trackedCompletion(client, { model: 'gpt-4o-mini', messages: [] }, { purpose: 'test' }).catch(() => null);

(async () => {
  await pool.query(`DELETE FROM scheduler_status WHERE job_name LIKE 'health:%'`);
  await pool.query(`DELETE FROM settings WHERE key IN ('HEALTH_LAST_URGENT_ALERT')`);
  await pool.query(`UPDATE email_senders SET status = 'paused'`);
  channelHealth._reset();
  // Recent activity in every stall area so only the thing under test can fire.
  const marks = `t${Date.now()}`;
  const touch = async () => {
    await pool.query(`DELETE FROM email_logs WHERE subject = $1`, [marks]);
    await pool.query(`INSERT INTO email_logs (direction, subject, body, sent_at) VALUES ('out', $1, 'b', NOW())`, [marks]);
  };
  await touch();
  const wa = await pool.query(`SELECT 1 FROM outreach_logs WHERE sent_at > NOW() - INTERVAL '1 day' LIMIT 1`);
  const ai0 = await pool.query(`SELECT 1 FROM ai_usage_logs WHERE created_at > NOW() - INTERVAL '1 day' LIMIT 1`);
  const ld = await pool.query(`SELECT 1 FROM hotel_leads WHERE created_at > NOW() - INTERVAL '1 day' LIMIT 1`);
  if (!wa.rowCount) await pool.query(`INSERT INTO outreach_logs (message_type, sent_at) VALUES ('test_stall', NOW())`).catch((e) => console.log('note: outreach_logs insert:', e.message));
  if (!ai0.rowCount) await pool.query(`INSERT INTO ai_usage_logs (purpose, model) VALUES ('test_stall', 'x')`);
  if (!ld.rowCount) await pool.query(`INSERT INTO hotel_leads (hotel_name, owner_name, created_at) VALUES ($1, '', NOW())`, [`stalltest ${marks}`]).catch((e) => console.log('note: hotel_leads insert:', e.message));

  // ── error classification ───────────────────────────────────────────────────
  check(isAiOutageError(apiErr(401, '401 Your API key has expired.', 'invalid_api_key')), '401 expired key is an AI outage');
  check(isAiOutageError(apiErr(429, '429 You have no credits remaining.')), '429 no credits is an AI outage');
  check(isAiOutageError(apiErr(429, 'insufficient_quota', 'insufficient_quota')), 'insufficient_quota is an AI outage');
  check(!isAiOutageError(apiErr(429, 'Rate limit reached for requests')), 'plain rate limit is NOT an outage');
  check(!isAiOutageError(apiErr(500, 'The server had an error')), 'a one-off 500 is NOT an outage');

  // ── healthy baseline ───────────────────────────────────────────────────────
  check(!(await warnFor('ai', 'error')), 'no AI error when nothing has failed');

  // ── expired key ────────────────────────────────────────────────────────────
  await call(fakeClient(async () => { throw apiErr(401, '401 Your API key has expired. Create a new API key to continue.', 'invalid_api_key'); }));
  const expired = await warnFor('ai', 'error');
  check(!!expired, 'expired key (401) raises an AI error warning');
  check(/expired or invalid/i.test(expired?.message || '') && /Settings/.test(expired?.message || ''), 'message says key expired and where to fix it', expired?.message?.slice(0, 80));
  const stored = (await channelHealth.getAll()).openai;
  check(channelHealth.isFailing(stored), 'failure is persisted (survives a restart / the 15 min cooldown)');

  // ── no credit ──────────────────────────────────────────────────────────────
  channelHealth._reset();
  await pool.query(`DELETE FROM scheduler_status WHERE job_name = 'health:openai'`);
  await call(fakeClient(async () => { throw apiErr(429, '429 You have no credits remaining. Add credits to continue.'); }));
  const credit = await warnFor('ai', 'error');
  check(/out of credit/i.test(credit?.message || ''), 'no-credit (429) says out of credit', credit?.message?.slice(0, 70));

  // ── recovery ───────────────────────────────────────────────────────────────
  await call(fakeClient(async () => ({ model: 'gpt-4o-mini', usage: {}, choices: [{ message: { content: '{}' } }] })));
  const { isAiAvailable } = require('../utils/aiUsage');
  check(isAiAvailable(), 'a successful call clears the in-memory outage flag');
  check(!(await warnFor('ai', 'error')), 'a successful call clears the AI warning');

  // ── 2-day stall detector ───────────────────────────────────────────────────
  check(!(await warnFor('email', 'error')), 'email sent recently → no stall warning');
  await pool.query(`UPDATE email_logs SET sent_at = NOW() - INTERVAL '3 days' WHERE direction = 'out' AND error IS NULL`);
  const stall = await warnFor('email', 'error');
  check(!!stall && stall.kind === 'stall', 'no email sent for 3 days → error-level stall warning', stall?.message?.slice(0, 90));
  check(/3 days/.test(stall?.message || ''), 'stall message says how long');

  // An existing specific email failure must not be duplicated by the stall one
  await channelHealth.markError('email', 'Brevo unauthorized IP');
  const emailWarns = (await getHealth()).warnings.filter((w) => w.area === 'email' && w.level === 'error');
  check(emailWarns.length === 1 && !emailWarns[0].kind, 'specific email failure shown once (stall not duplicated)');
  await pool.query(`DELETE FROM scheduler_status WHERE job_name = 'health:email'`);
  channelHealth._reset();

  // ── stall-only alert repeats daily, not every 6 hours ──────────────────────
  await pool.query(`DELETE FROM settings WHERE key = 'HEALTH_LAST_URGENT_ALERT'`);
  const only = (await getHealth()).warnings.filter((w) => w.level === 'error');
  if (only.length && only.every((w) => w.kind === 'stall')) {
    const a = await sendUrgentAlert();
    check(a.sent === true, 'stall-only alert is sent the first time');
    const realKey = only.map((w) => w.area).sort().join(',');
    await settings.setSetting('HEALTH_LAST_URGENT_ALERT', JSON.stringify({ key: realKey, at: Date.now() - 7 * 3600000 }));
    const b = await sendUrgentAlert();
    check(b.repeat === true, 'stall-only alert is NOT repeated after 7h (daily cadence)');
  } else {
    console.log('SKIP  stall-only alert cadence (test DB has other error-level warnings):', only.map((w) => w.area).join(','));
  }

  // cleanup the rows this test added
  await pool.query(`DELETE FROM email_logs WHERE subject = $1`, [marks]);
  await pool.query(`DELETE FROM outreach_logs WHERE message_type = 'test_stall'`).catch(() => {});
  await pool.query(`DELETE FROM ai_usage_logs WHERE purpose IN ('test_stall','test')`);
  await pool.query(`DELETE FROM hotel_leads WHERE hotel_name = $1`, [`stalltest ${marks}`]).catch(() => {});
  await pool.query(`DELETE FROM scheduler_status WHERE job_name LIKE 'health:%'`);

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  await pool.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
