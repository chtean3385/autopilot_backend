// Test for channel health + verifier outage handling + auto-enroll once verified (2026-10-08):
// utils/channelHealth.js, services/cadenceHealthService.js systemChecks/sendUrgentAlert,
// emailSenderService / wabaService failure classification, emailVerifierService providerDown,
// workers/emailVerificationWorker.js, SequenceService.enrollPendingVerified, cadence wait reasons.
//
// Runs against the throwaway test DB only (scripts/setup_overnight_db.js, then boot
// scripts/run_test_server.sh once so initDB adds the newest columns). Outside services are stubbed
// (axios is patched in-process) — nothing reaches Brevo, Meta or mails.so.
// Run: TEST_DB_NAME=autoagent_overnight node scripts/test_health_and_enroll.js
require('dotenv').config();
const TEST_DB = process.env.TEST_DB_NAME || 'autoagent_overnight';
if (!/overnight|test/i.test(TEST_DB)) { console.error('Refusing: TEST_DB_NAME must be a throwaway test DB'); process.exit(1); }
const u = new URL(process.env.DATABASE_URL);
u.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = u.toString();
delete process.env.OUTBOUND_DRY_RUN;
process.env.OWNER_WHATSAPP = ''; // owner alerts become a logged no-op
process.env.WABA_API_TOKEN = 'test'; process.env.WABA_PHONE_ID = 'test';

const axios = require('axios');
let axiosPost = async () => { throw new Error('unexpected network call in test'); };
axios.post = (...args) => axiosPost(...args);
const fail = (status, data) => async () => { const e = new Error(`HTTP ${status}`); e.response = { status, data }; throw e; };

const pool = require('../config/db');
const channelHealth = require('../utils/channelHealth');
const { getHealth, sendUrgentAlert } = require('../services/cadenceHealthService');
const EmailSenderService = require('../services/emailSenderService');
const WABAService = require('../services/wabaService');
const { verifyEmail } = require('../services/emailVerifierService');
const SequenceService = require('../services/sequenceService');
const LeadService = require('../services/leadService');
const settings = require('../services/settingsService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const areas = async (level) => (await getHealth()).warnings.filter((w) => !level || w.level === level).map((w) => w.area);
const tag = `t${Date.now()}`;

(async () => {
  // Clean slate for the parts this test owns
  await pool.query(`DELETE FROM scheduler_status WHERE job_name LIKE 'health:%'`);
  await pool.query(`DELETE FROM settings WHERE key IN ('HEALTH_LAST_URGENT_ALERT', 'VERIFIER_API_KEY')`);
  await pool.query(`UPDATE email_senders SET status = 'paused'`); // only the sender below counts
  channelHealth._reset();

  // ── email channel ──────────────────────────────────────────────────────────
  const sender = (await pool.query(
    `INSERT INTO email_senders (label, provider, from_email, api_key, status, imap_config)
     VALUES ($1, 'brevo', $2, 'k', 'active', $3) RETURNING *`,
    [`Test ${tag}`, `${tag}@example.com`, JSON.stringify({ host: 'imap.example.com', user: 'u', pass: 'p' })])).rows[0];

  axiosPost = fail(400, { code: 'invalid_parameter', message: 'email is not valid in to' });
  await EmailSenderService.send(sender, { to: 'bad@nowhere', subject: 's', html: 'h' });
  check(!(await areas('error')).includes('email'), 'one invalid recipient (400) is NOT an email outage');

  axiosPost = fail(401, { code: 'unauthorized', message: 'We have detected you are using an unrecognised IP address 72.61.238.93' });
  await EmailSenderService.send(sender, { to: 'x@example.com', subject: 's', html: 'h' });
  const h1 = await getHealth();
  const emailErr = h1.warnings.find((w) => w.area === 'email' && w.level === 'error');
  check(Boolean(emailErr) && /unrecognised IP/.test(emailErr.message) && /Authorised IPs/.test(emailErr.message), 'Brevo IP block → red "email sending is failing" with the fix');

  axiosPost = async () => ({ data: { messageId: '<m1@brevo>' } });
  const ok = await EmailSenderService.send(sender, { to: 'x@example.com', subject: 's', html: 'h' });
  check(ok.success && !(await areas('error')).includes('email'), 'next successful send clears it');

  // ── WhatsApp channel ───────────────────────────────────────────────────────
  axiosPost = fail(400, { error: { code: 131026, message: 'Message undeliverable' } });
  await WABAService.sendTextMessage('919999999999', 'hi');
  check(!(await areas('error')).includes('whatsapp'), 'recipient not on WhatsApp (131026) is NOT an outage');
  axiosPost = fail(401, { error: { code: 190, message: 'Error validating access token: Session has expired' } });
  await WABAService.sendTemplateMessageWithComponents('919999999999', 'tpl', []);
  check((await areas('error')).includes('whatsapp'), 'expired WABA token (190) → red WhatsApp alert');
  axiosPost = async () => ({ data: { messages: [{ id: 'wamid.1' }] } });
  await WABAService.sendTextMessage('919999999999', 'hi');
  check(!(await areas('error')).includes('whatsapp'), 'next successful WhatsApp send clears it');

  // ── IMAP reply checking ────────────────────────────────────────────────────
  await channelHealth.markError(`imap:${sender.id}`, `${sender.label}: Invalid credentials (Failure)`);
  check((await getHealth()).warnings.some((w) => w.area === 'replies' && w.level === 'error' && /IMAP password/.test(w.message)), 'IMAP login failing → red "reply checking failing"');
  await channelHealth.markOk(`imap:${sender.id}`);
  check(!(await areas('error')).includes('replies'), 'successful poll clears it');
  const noImap = (await pool.query(
    `INSERT INTO email_senders (label, provider, from_email, api_key, status) VALUES ($1, 'brevo', $2, 'k', 'active') RETURNING id`,
    [`NoImap ${tag}`, `n${tag}@example.com`])).rows[0];
  check((await getHealth()).warnings.some((w) => w.area === 'replies' && /no IMAP settings/.test(w.message)), 'mailbox without IMAP → warning (replies never picked up)');
  await pool.query(`DELETE FROM email_senders WHERE id = $1`, [noImap.id]);

  // ── verifier outage + auto-enroll ──────────────────────────────────────────
  await settings.setSetting('VERIFIER_API_KEY', 'test-key');
  const seq = (await pool.query(`INSERT INTO sequences (name, active) VALUES ($1, TRUE) RETURNING id`, [`Seq ${tag}`])).rows[0];
  axiosPost = fail(401, { error: 'Unauthorized: insufficient credits' });
  const added = await LeadService.addLeads([
    { hotel_name: `A ${tag}`, email: `a.${tag}@company.in`, channel: 'email', source: 'domain_list', enroll_sequence_id: seq.id },
    { hotel_name: `B ${tag}`, email: `b.${tag}@gmail.com`, channel: 'email', source: 'domain_list', enroll_sequence_id: seq.id },
  ]);
  const [a, b] = added.inserted;
  check(a.email_status === 'unknown' && b.email_status === 'verified', 'mails.so out of credit at save: company email → unknown (not "bad"), Gmail → verified');
  check((await SequenceService.enrollPendingVerified()).enrolled === 1, 'Gmail lead enrolled in the picked sequence right away');
  const v = await verifyEmail('c@company.in');
  check(v.status === 'error' && v.providerDown === true, 'verifyEmail flags providerDown for an out-of-credit answer');
  check((await getHealth()).warnings.some((w) => w.area === 'verification' && w.level === 'error' && /top up mails.so/.test(w.message)), 'red "mails.so is failing" banner with lead count');

  const { runVerificationPass } = require('../workers/emailVerificationWorker');
  await pool.query(`UPDATE hotel_leads SET last_verify_attempt_at = NULL WHERE id = $1`, [a.id]);
  await runVerificationPass();
  let la = (await pool.query(`SELECT email_status, COALESCE(email_verify_attempts,0) AS n, enroll_sequence_id FROM hotel_leads WHERE id = $1`, [a.id])).rows[0];
  check(la.email_status === 'unknown' && la.n === 0, 'worker during outage: no attempt burned, lead still waiting', JSON.stringify(la));
  check(la.enroll_sequence_id === seq.id, '…and still pending for its sequence');

  axiosPost = async () => ({ data: { data: { result: 'deliverable' } } });
  await runVerificationPass();
  la = (await pool.query(`SELECT email_status, enroll_sequence_id FROM hotel_leads WHERE id = $1`, [a.id])).rows[0];
  const inSeq = (await pool.query(`SELECT COUNT(*)::int AS n FROM lead_sequences WHERE lead_id = $1 AND sequence_id = $2 AND status = 'active'`, [a.id, seq.id])).rows[0].n;
  check(la.email_status === 'verified' && inSeq === 1 && la.enroll_sequence_id === null, 'mails.so back → verified and auto-enrolled into the picked sequence');
  check(!(await areas('error')).includes('verification'), 'verifier banner clears after a good answer');

  // Stuck lead (3 attempts used, last one 8 days ago) is retried instead of abandoned
  const stuck = (await LeadService.addLeads([{ hotel_name: `S ${tag}`, email: `s.${tag}@company.in`, channel: 'email' }])).inserted[0];
  await pool.query(`UPDATE hotel_leads SET email_status = 'unknown', email_verify_attempts = 3, last_verify_attempt_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [stuck.id]);
  await runVerificationPass();
  check((await pool.query(`SELECT email_status FROM hotel_leads WHERE id = $1`, [stuck.id])).rows[0].email_status === 'verified', 'lead that used its 3 attempts is retried after a week → verified');

  // Manual override path: unverifiable lead with a pending sequence → owner marks it verified
  const m = (await LeadService.addLeads([{ hotel_name: `M ${tag}`, email: `m.${tag}@company.in`, channel: 'email', enroll_sequence_id: seq.id }])).inserted[0];
  await pool.query(`UPDATE hotel_leads SET email_status = 'unverifiable' WHERE id = $1`, [m.id]);
  check((await SequenceService.enrollPendingVerified()).enrolled === 0, 'unverifiable lead is not enrolled');
  await pool.query(`UPDATE hotel_leads SET email_status = 'verified' WHERE id = $1`, [m.id]);
  check((await SequenceService.enrollPendingVerified()).enrolled === 1, '…until it is marked verified by hand, then it joins its sequence');

  // ── urgent owner alert: once per problem per 6 h ───────────────────────────
  await channelHealth.markError('whatsapp', 'Error validating access token (code 190)');
  const first = await sendUrgentAlert();
  const second = await sendUrgentAlert();
  check(first.sent === true && second.sent === false && second.repeat === true, 'urgent alert sent once, not repeated within 6h');
  await channelHealth.markOk('whatsapp');

  // cleanup
  await pool.query(`DELETE FROM hotel_leads WHERE hotel_name LIKE $1`, [`% ${tag}`]);
  await pool.query(`DELETE FROM sequences WHERE id = $1`, [seq.id]);
  await pool.query(`DELETE FROM email_senders WHERE id = $1`, [sender.id]);
  await pool.query(`DELETE FROM settings WHERE key IN ('HEALTH_LAST_URGENT_ALERT', 'VERIFIER_API_KEY')`);

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
