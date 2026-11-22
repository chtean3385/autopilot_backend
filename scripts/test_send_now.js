// Tests Leads → "Send now" (services/sendNowService.js + POST /api/leads/:id/send-now) on the throwaway test DB
// (scripts/setup_overnight_db.js, then boot scripts/run_test_server.sh once so initDB() runs). Never touches the
// dev DB (DATABASE_URL is rewritten), never sends anything (OUTBOUND_DRY_RUN forced), OpenAI is stubbed.
// Usage: node scripts/test_send_now.js
require('dotenv').config();
const TEST_DB = process.env.TEST_DB_NAME || 'autoagent_overnight';
const u = new URL(process.env.DATABASE_URL);
u.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = u.toString();
process.env.OUTBOUND_DRY_RUN = 'true';
process.env.WABA_API_TOKEN = ''; process.env.OWNER_WHATSAPP = '';
process.env.BACKEND_URL = process.env.BACKEND_URL || 'https://bot.example.test';

// --- stub OpenAI at its one choke point before any service destructures it ---
const aiUsage = require('../utils/aiUsage');
let coldScore = 5;
let composeDelayMs = 0;
aiUsage.trackedCompletion = async (client, params, { purpose } = {}) => {
  if (purpose === 'sequence_email_compose' && composeDelayMs) await new Promise((r) => setTimeout(r, composeDelayMs));
  const answers = {
    sequence_email_compose: { subject: 'quick question about your orders', body: `Hi, how do customers reach you after hours? Test ${Date.now() % 1000}.` },
    cold_email_score: { score: coldScore, feedback: coldScore < 4.5 ? 'reads templated' : 'ok' },
  };
  return { choices: [{ message: { content: JSON.stringify(answers[purpose] || {}) } }], usage: {} };
};
aiUsage.isAiAvailable = () => true;

const express = require('express');
const pool = require('../config/db');
const { setSetting } = require('../services/settingsService');
const { sendNow } = require('../services/sendNowService');

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  →  ${extra}` : ''}`); if (!ok) failed++; };
const tag = `sn${Date.now().toString(36)}`;
let n = 0;

async function lead({ email = true, status = 'new', emailStatus = 'verified', cadence = true, research = true, wa = '919812345678' } = {}) {
  n++;
  const r = await pool.query(
    `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, source, status, channel, email_status, cadence_managed, website, niche)
     VALUES ($1, 'Ashwani Kumar', $2, $3, 'Lucknow', 'directory', $4, 'email', $5, $6, 'https://example-biz.in', 'garments') RETURNING id`,
    [`${tag} lead${n}`, email ? `owner${n}.${tag}@example-biz.in` : null, wa, status, emailStatus, cadence]);
  const id = r.rows[0].id;
  if (research) await pool.query(`INSERT INTO lead_research (lead_id, summary, pain_points, email_angles) VALUES ($1, 'Garment wholesaler.', '["slow quotes"]', '["order follow-ups"]')`, [id]);
  return id;
}
const cadence = (leadId, status, channel, extra = {}) => pool.query(
  `INSERT INTO lead_cadence (lead_id, current_channel, first_channel, cycle_start_channel, status, next_touch_at, total_touches, cycle, stop_reason, wa_unusable, started_at)
   VALUES ($1, $2, $2, $2, $3, NOW(), $4, 1, $5, $6, NOW() - INTERVAL '30 days')`,
  [leadId, channel, status, extra.touches || 0, extra.stopReason || null, Boolean(extra.waUnusable)]);
const emailsTo = async (leadId) => (await pool.query(`SELECT * FROM email_logs WHERE lead_id = $1 AND direction = 'out' AND error IS NULL`, [leadId])).rows;
const waTo = async (leadId) => (await pool.query(`SELECT COUNT(*)::int AS n FROM outreach_logs WHERE lead_id = $1`, [leadId])).rows[0].n;

(async () => {
  // Isolate: only our test mailboxes are active for cold email, prod-like settings.
  const prevActive = (await pool.query(`SELECT id FROM email_senders WHERE status = 'active'`)).rows.map((r) => r.id);
  await pool.query(`UPDATE email_senders SET status = 'paused' WHERE status = 'active'`);
  const mk = async (label, name, status = 'active', cap = 50) => (await pool.query(
    `INSERT INTO email_senders (label, provider, smtp_config, from_name, from_email, daily_cap, status, warmup_started_at, sent_today, last_reset_date)
     VALUES ($1, 'smtp', $2, $3, $4, $5, $6, NOW() - INTERVAL '90 days', 0, CURRENT_DATE) RETURNING id`,
    [`${tag}-${label}`, JSON.stringify({ host: 'h', port: 465, user: 'u', pass: 'p' }), name, `${label}.${tag}@example.com`, cap, status])).rows[0].id;
  const priya = await mk('priya', 'Priya');
  const old = {};
  for (const k of ['WHATSAPP_OUTREACH_ENABLED', 'EMAIL_SENDER_MIN_GAP_MINUTES', 'SEND_WINDOW_START_HOUR', 'SEND_WINDOW_END_HOUR', 'EMAIL_FRESH_START_AT', 'COLD_EMAIL_EXCLUDE_SENDER_IDS', 'CADENCE_EMAIL_MIN_SCORE']) {
    old[k] = (await pool.query('SELECT value FROM settings WHERE key = $1', [k])).rows[0]?.value ?? null;
  }
  await setSetting('WHATSAPP_OUTREACH_ENABLED', 'false');
  await setSetting('EMAIL_SENDER_MIN_GAP_MINUTES', '9');
  await setSetting('EMAIL_FRESH_START_AT', new Date(Date.now() - 86400e3).toISOString());
  await setSetting('COLD_EMAIL_EXCLUDE_SENDER_IDS', '');
  await setSetting('CADENCE_EMAIL_MIN_SCORE', '4.5');
  // Send window that is closed right now (a 1-hour window 12 hours away, IST) — Send now must still send.
  const istHour = new Date(Date.now() + 5.5 * 3600e3).getUTCHours();
  const closedStart = (istHour + 12) % 24;
  await setSetting('SEND_WINDOW_START_HOUR', String(Math.min(closedStart, 22)));
  await setSetting('SEND_WINDOW_END_HOUR', String(Math.min(closedStart, 22) + 1));
  const { isWithinSendWindow } = require('../utils/sendWindow');
  check('setup: send window is closed right now', !(await isWithinSendWindow()).allowed);

  try {
    console.log('\n— WhatsApp outreach OFF: directory lead whose schedule is on WhatsApp gets the EMAIL —');
    const A = await lead();
    await cadence(A, 'active', 'whatsapp');
    // Priya emailed someone 1 minute ago → 9-minute spacing would block an automatic send; a manual one may go.
    const other = await lead({ cadence: false });
    await pool.query(`INSERT INTO email_logs (lead_id, sender_id, direction, subject, body, sent_at) VALUES ($1, $2, 'out', 's', 'b', NOW() - INTERVAL '1 minute')`, [other, priya]);
    const rA = await sendNow(A);
    console.log('      response:', JSON.stringify(rA));
    check('sent: true, channel email', rA.sent === true && rA.channel === 'email', rA.message || rA.reason);
    check('says who it went to, from which mailbox, subject', rA.to?.includes('@example-biz.in') && rA.sender === 'Priya' && Boolean(rA.subject));
    check('exactly one email logged', (await emailsTo(A)).length === 1);
    check('no WhatsApp sent', (await waTo(A)) === 0);
    const cA = (await pool.query('SELECT * FROM lead_cadence WHERE lead_id = $1', [A])).rows[0];
    check('cadence moved onto email, next touch planned days out', cA.current_channel === 'email' && cA.status === 'active' && cA.total_touches === 1 && new Date(cA.next_touch_at) > new Date(Date.now() + 2 * 86400e3), `${cA.current_channel}/${cA.status}/${cA.total_touches}/${cA.next_touch_at}`);
    check('outside the send window and inside the mailbox gap, still sent (manual bypass)', rA.sent === true);

    console.log('\n— repeat clicks —');
    const again = await sendNow(A);
    check('second click refused with a cooldown reason', again.sent === false && again.cooldown === true && /Already sent/.test(again.reason), again.reason);
    check('still exactly one email', (await emailsTo(A)).length === 1);
    await pool.query(`UPDATE email_logs SET sent_at = NOW() - INTERVAL '2 hours', created_at = NOW() - INTERVAL '2 hours' WHERE lead_id = $1`, [A]);
    const sameDay = await sendNow(A);
    check('2 hours later: refused, one email a day', sameDay.sent === false && /already emailed 2 hours ago/.test(sameDay.reason), sameDay.reason);

    const D = await lead();
    await cadence(D, 'active', 'whatsapp');
    composeDelayMs = 300;
    const [d1, d2] = await Promise.all([sendNow(D), sendNow(D)]);
    composeDelayMs = 0;
    check('double click at the same moment: one sent, one refused', [d1, d2].filter((r) => r.sent).length === 1 && [d1, d2].some((r) => !r.sent && /Already sending/.test(r.reason)), `${d1.message || d1.reason} | ${d2.message || d2.reason}`);
    check('…and only one email logged', (await emailsTo(D)).length === 1);

    console.log('\n— lead 15027 case: cadence stopped "wa_failed_no_email", email verified since —');
    const S = await lead();
    await cadence(S, 'stopped', 'whatsapp', { touches: 2, stopReason: 'wa_failed_no_email', waUnusable: true });
    const rS = await sendNow(S);
    check('sent by email', rS.sent === true, rS.message || rS.reason);
    const cS = (await pool.query('SELECT * FROM lead_cadence WHERE lead_id = $1', [S])).rows[0];
    check('cadence restarted on email (WhatsApp stays off)', cS.status === 'active' && cS.current_channel === 'email' && cS.wa_unusable === true, `${cS.status}/${cS.current_channel}`);

    console.log('\n— refusals —');
    const noEmail = await sendNow(await lead({ email: false }));
    check('no email → clear reason', !noEmail.sent && /no email address/.test(noEmail.reason), noEmail.reason);
    const O = await lead({ status: 'opted_out' });
    await cadence(O, 'active', 'email');
    const opted = await sendNow(O);
    check('opted out → refused', !opted.sent && /opted out/.test(opted.reason), opted.reason);
    check('…nothing sent', (await emailsTo(O)).length === 0);
    const NI = await lead({ status: 'not_interested' });
    const ni = await sendNow(NI);
    check('not interested → refused', !ni.sent && /not interested/.test(ni.reason), ni.reason);
    const U = await lead();
    await cadence(U, 'active', 'email');
    await require('../services/suppressionService').addToSuppression((await pool.query('SELECT email FROM hotel_leads WHERE id=$1', [U])).rows[0].email, 'unsubscribed');
    const unsub = await sendNow(U);
    check('unsubscribed address → refused', !unsub.sent && /unsubscribed or bounced/.test(unsub.reason), unsub.reason);
    const B = await lead({ emailStatus: 'bounced' });
    const bounced = await sendNow(B);
    check('bounced → refused', !bounced.sent && /bounced/.test(bounced.reason), bounced.reason);
    const UV = await lead({ emailStatus: 'unverifiable' });
    await cadence(UV, 'active', 'email');
    const unver = await sendNow(UV);
    check('unverified email → refused', !unver.sent && /not verified/.test(unver.reason), unver.reason);
    const R = await lead();
    await cadence(R, 'replied', 'email');
    const rep = await sendNow(R);
    check('replied lead → refused', !rep.sent && /replied/.test(rep.reason), rep.reason);
    const NC = await lead({ cadence: false });
    const nc = await sendNow(NC);
    check('not in any sequence or schedule → says enroll first', !nc.sent && /Enroll it in a sequence/.test(nc.reason), nc.reason);

    console.log('\n— mailbox cap and quality bar —');
    await pool.query(`UPDATE email_senders SET sent_today = daily_cap WHERE id = $1`, [priya]);
    const C = await lead();
    await cadence(C, 'active', 'email');
    const full = await sendNow(C);
    check('every mailbox full today → refused, names the mailbox', !full.sent && /Priya 50\/50 today/.test(full.reason), full.reason);
    await pool.query(`UPDATE email_senders SET sent_today = 0 WHERE id = $1`, [priya]);
    coldScore = 3;
    const Q = await lead();
    await cadence(Q, 'active', 'email');
    const q = await sendNow(Q);
    coldScore = 5;
    check('AI draft below 4.5 → nothing sent, says so', !q.sent && /quality bar/.test(q.reason) && (await emailsTo(Q)).length === 0, q.reason);

    console.log('\n— HTTP route —');
    const app = express();
    app.use(express.json());
    app.use('/api/leads', require('../routes/leads'));
    const server = app.listen(0);
    const port = server.address().port;
    const H = await lead();
    await cadence(H, 'active', 'whatsapp');
    const post = async (id) => { const r = await fetch(`http://localhost:${port}/api/leads/${id}/send-now`, { method: 'POST' }); return { status: r.status, body: await r.json() }; };
    const h1 = await post(H);
    console.log('      POST →', h1.status, JSON.stringify(h1.body));
    check('POST /send-now 200 { sent: true, channel, to, subject, sender }', h1.status === 200 && h1.body.sent && h1.body.channel === 'email' && h1.body.to && h1.body.subject && h1.body.sender === 'Priya');
    const h2 = await post(H);
    check('POST again → 200 { sent: false, reason, cooldown }', h2.status === 200 && h2.body.sent === false && h2.body.cooldown && /Already sent/.test(h2.body.reason), h2.body.reason);
    const h404 = await post(999999999);
    check('unknown lead → 404', h404.status === 404);
    server.close();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === null) await pool.query('DELETE FROM settings WHERE key = $1', [k]); else await setSetting(k, v);
    }
    await pool.query(`UPDATE email_senders SET status = 'paused' WHERE label LIKE $1`, [`${tag}-%`]);
    if (prevActive.length) await pool.query(`UPDATE email_senders SET status = 'active' WHERE id = ANY($1)`, [prevActive]);
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
