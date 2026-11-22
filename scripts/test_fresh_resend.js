// Tests services/freshResendService.js against the throwaway test DB (scripts/setup_overnight_db.js, then
// boot scripts/run_test_server.sh once so initDB() runs). OUTBOUND_DRY_RUN: nothing is sent.
// Usage: node scripts/test_fresh_resend.js
require('dotenv').config();
const TEST_DB = process.env.TEST_DB_NAME || 'autoagent_overnight';
const u = new URL(process.env.DATABASE_URL);
if (u.pathname.slice(1) === TEST_DB) throw new Error('unexpected');
u.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = u.toString();
process.env.OUTBOUND_DRY_RUN = 'true';
process.env.WABA_API_TOKEN = ''; process.env.OWNER_WHATSAPP = '';

const pool = require('../config/db');
const { setSetting } = require('../services/settingsService');
const FreshResend = require('../services/freshResendService');
const { buildClickUrl, buildPixelUrl, verifyClickTarget } = require('../utils/emailTracking');

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`); if (!ok) failed++; };
const tag = `fr${Date.now().toString(36)}`;

async function lead(name, extra = {}) {
  const r = await pool.query(
    `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, source, status, channel, email_status, cadence_managed)
     VALUES ($1, '', $2, '', 'Ahmedabad', 'test', $3, 'email', 'verified', $4) RETURNING id`,
    [`${tag} ${name}`, `${name}.${tag}@example-biz.in`, extra.status || 'new', Boolean(extra.cadence)]);
  return r.rows[0].id;
}
async function logOut(leadId, senderId, { at, token = null, body = '<p>hi</p>', seq = null, error = null }) {
  await pool.query(
    `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, tracking_token, error, sent_at, created_at)
     VALUES ($1, $2, $3, 'out', 'Original subject', $4, $5, $6, $7, $7)`, [leadId, senderId, seq, body, token, error, at]);
}

(async () => {
  const smtp = (await pool.query(
    `INSERT INTO email_senders (label, provider, smtp_config, from_name, from_email, daily_cap, status, warmup_started_at)
     VALUES ($1, 'smtp', $2, 'T', $3, 50, 'active', NOW() - INTERVAL '60 days') RETURNING id`,
    [`${tag}-smtp`, JSON.stringify({ host: 'h', port: 465, user: 'u', pass: 'p' }), `s.${tag}@example.com`])).rows[0].id;
  const brevo = (await pool.query(
    `INSERT INTO email_senders (label, provider, api_key, from_name, from_email, daily_cap, status)
     VALUES ($1, 'brevo', 'k', 'B', $2, 300, 'paused') RETURNING id`, [`${tag}-brevo`, `b.${tag}@example.com`])).rows[0].id;
  const seqId = (await pool.query(
    `INSERT INTO sequences (name, initial_gaps, recurring_interval_days, active) VALUES ($1, '[7]', 7, false) RETURNING id`, [`${tag}-seq`])).rows[0].id;

  const fresh = new Date(Date.now() - 3600e3); // fresh start 1h ago
  const old = new Date(Date.now() - 20 * 86400e3);
  await setSetting('EMAIL_FRESH_START_AT', fresh.toISOString());
  await setSetting('FRESH_RESEND_ENABLED', 'true');
  await setSetting('EMAIL_SENDER_MIN_GAP_MINUTES', '0');

  const oldToken = 'a'.repeat(32);
  const dest = 'https://dreamstechnology.in/work';
  const oldHtml = `<html><body><p>Hello there</p><a href="${buildClickUrl(oldToken, dest)}">see</a><img src="${buildPixelUrl(oldToken)}" width="1" height="1"></body></html>`;

  const A = await lead('smtponly', { cadence: true });                 // eligible
  await logOut(A, smtp, { at: old, token: oldToken, body: oldHtml, seq: seqId });
  await logOut(A, smtp, { at: new Date(old.getTime() + 86400e3), body: '<p>follow-up</p>', seq: seqId });
  await pool.query(`INSERT INTO lead_sequences (lead_id, sequence_id, current_step, status, paused_reason) VALUES ($1, $2, 3, 'dead', 'sequence_complete')`, [A, seqId]);
  await pool.query(`INSERT INTO lead_cadence (lead_id, current_channel, status, stop_reason, cycle, total_touches) VALUES ($1, 'email', 'dead', 'no_response_all_cycles', 3, 6)`, [A]);
  await pool.query(`UPDATE hotel_leads SET status = 'no_response' WHERE id = $1`, [A]);

  const B = await lead('brevo'); await logOut(B, smtp, { at: old }); await logOut(B, brevo, { at: old });          // Brevo-reached
  const C = await lead('replied'); await logOut(C, smtp, { at: old });
  await pool.query(`INSERT INTO email_logs (lead_id, direction, subject, created_at) VALUES ($1, 'in', 'Re', NOW())`, [C]); // replied
  const D = await lead('already'); await logOut(D, smtp, { at: old }); await logOut(D, smtp, { at: new Date() });   // already sent since fresh start
  const E = await lead('optout', { status: 'opted_out' }); await logOut(E, smtp, { at: old });
  const F = await lead('never');                                                                                    // never emailed
  const G = await lead('failedonly'); await logOut(G, smtp, { at: old, error: 'boom' });                             // only failed sends
  const H = await lead('waonly', { cadence: true }); await logOut(H, smtp, { at: old });
  await pool.query(`INSERT INTO lead_cadence (lead_id, current_channel, status, stop_reason) VALUES ($1, 'whatsapp', 'replied', 'whatsapp_reply')`, [H]); // replied on WhatsApp

  const ids = (await FreshResend.listEligible()).map((r) => r.lead_id).filter((id) => [A, B, C, D, E, F, G, H].includes(id));
  check('only the SMTP-only lead is eligible', JSON.stringify(ids) === JSON.stringify([A]), JSON.stringify(ids));
  const [row] = await FreshResend.listEligible({ leadId: A });
  check('original = FIRST email (not the follow-up)', row && row.tracking_token === oldToken);
  check('re-sends pending', await FreshResend.isPending());
  check('lead A is waiting for its own re-send (blocks AI mail to it)', await FreshResend.isLeadWaiting(A));
  check('Brevo-reached lead B is not waiting', !(await FreshResend.isLeadWaiting(B)));

  const r = await FreshResend.resendOne(row);
  check('re-send ok (dry run)', r.ok && r.dryRun, JSON.stringify(r));
  const sent = (await pool.query(`SELECT * FROM email_logs WHERE lead_id = $1 AND direction = 'out' ORDER BY id DESC LIMIT 1`, [A])).rows[0];
  check('same subject', sent.subject === 'Original subject');
  check('new tracking token', sent.tracking_token && sent.tracking_token !== oldToken);
  check('old token gone from the body', !sent.body.includes(oldToken));
  check('pixel uses the new token', sent.body.includes(buildPixelUrl(sent.tracking_token)));
  const m = sent.body.match(/\/t\/c\/([a-f0-9]+)\?u=([^&"]+)&(?:amp;)?s=([a-f0-9]+)/i);
  check('click link rebuilt with a valid signature', m && m[1] === sent.tracking_token && verifyClickTarget(m[1], decodeURIComponent(m[2]), m[3]));
  check('text kept', sent.body.includes('Hello there'));
  const ls = (await pool.query(`SELECT * FROM lead_sequences WHERE lead_id = $1`, [A])).rows[0];
  check('sequence resumes at step 1, active, next in ~7 days', ls.current_step === 1 && ls.status === 'active' && new Date(ls.next_run_at) > new Date(Date.now() + 6.9 * 86400e3));
  const lc = (await pool.query(`SELECT * FROM lead_cadence WHERE lead_id = $1`, [A])).rows[0];
  check('cadence email restarted (cycle 1, 1 touch, active)', lc.status === 'active' && lc.cycle === 1 && lc.touches_on_channel === 1 && lc.current_channel === 'email');
  const st = (await pool.query(`SELECT status FROM hotel_leads WHERE id = $1`, [A])).rows[0].status;
  check('lead no_response → new', st === 'new', st);
  check('not eligible again after re-send', (await FreshResend.listEligible({ leadId: A })).length === 0);
  check('lead A no longer waiting after re-send', !(await FreshResend.isLeadWaiting(A)));

  await pool.query(`UPDATE email_senders SET status = 'paused' WHERE id = $1`, [smtp]);
  const I = await lead('paused'); await logOut(I, smtp, { at: old });
  const [ri] = await FreshResend.listEligible({ leadId: I });
  const rp = await FreshResend.resendOne(ri, { manual: true });
  check('paused mailbox → not sent, waits', !rp.ok && rp.reason === 'mailbox_paused');

  await setSetting('FRESH_RESEND_ENABLED', 'false');
  check('disabled → runTick skips', (await FreshResend.runTick()).skipped === 'disabled');
  await setSetting('EMAIL_FRESH_START_AT', '');

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  await pool.end?.();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
