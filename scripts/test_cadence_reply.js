// Branch test for services/cadenceReplyService.js (directory outreach step 5) with the two AI calls stubbed. Test DB + dry run only.
// Run: node scripts/test_cadence_reply.js — needs the throwaway DB from scripts/setup_overnight_db.js.
// Never touches the dev DB: it rewrites DATABASE_URL to autoagent_overnight and forces OUTBOUND_DRY_RUN.
const B = require('path').join(__dirname, '..') + '/';
require(B + 'node_modules/dotenv').config({ path: B + '.env' });
process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/[^/]+$/, '/autoagent_overnight');
process.env.OUTBOUND_DRY_RUN = 'true';
process.env.WABA_API_TOKEN = '';

const sales = require(B + 'services/salesAgentService');
const rq = require(B + 'services/replyQualityService');
let gateQueue = [];
let draftQueue = [];
sales.classifyReplyIntent = async () => gateQueue.shift();
rq.draftAndScore = async (ctx, opts) => ({ ...draftQueue.shift(), meta: undefined, _opts: opts });
const { handleCadenceReply } = require(B + 'services/cadenceReplyService');
const pool = require(B + 'config/db');

async function setSetting(k, v) {
  await pool.query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [k, v]);
}
async function freshLead(i) {
  const r = await pool.query(
    `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, channel, cadence_managed, status)
     VALUES ($1,'Test Owner',$2,$3,'Gandhinagar','email',TRUE,'new') RETURNING *`,
    [`Branch Test ${i} ${Date.now()}`, `branch${i}.${Date.now()}@example.com`, `9190000${String(10000 + i)}`]
  );
  return r.rows[0];
}
async function state(id) {
  const c = (await pool.query('SELECT status, stop_reason FROM lead_cadence WHERE lead_id=$1', [id])).rows[0];
  const l = (await pool.query('SELECT status, needs_attention FROM hotel_leads WHERE id=$1', [id])).rows[0];
  const a = (await pool.query(`SELECT type, payload FROM pending_approvals WHERE lead_id=$1`, [id])).rows;
  const sent = (await pool.query(`SELECT COUNT(*)::int n FROM email_logs WHERE lead_id=$1 AND direction='out'`, [id])).rows[0].n
    + (await pool.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE lead_id=$1`, [id])).rows[0].n;
  return { cadence: c ? `${c.status}/${c.stop_reason}` : 'none', lead: `${l.status}${l.needs_attention ? '+flag' : ''}`, approvals: a.map((x) => x.type), sentToLead: sent };
}

const cases = [
  ['HANDOFF (price ask)', 'whatsapp', { gate: 'HANDOFF', reason: 'asks about price' }, null, 'false', { cadence: 'replied', approvals: 0, sent: 0 }],
  ['NOT_INTERESTED', 'email', { gate: 'NOT_INTERESTED', reason: 'no' }, null, 'false', { cadence: 'stopped', approvals: 0, sent: 0 }],
  ['AUTO_REPLY (out of office)', 'email', { gate: 'AUTO_REPLY', reason: 'ooo' }, null, 'false', { cadence: 'none', approvals: 0, sent: 0 }],
  ['ROUTINE 4.7, auto-send OFF', 'whatsapp', { gate: 'ROUTINE' }, { text: 'We build simple websites for new firms in GIDC. Would a quick look help?', score: 4.7 }, 'false', { cadence: 'replied', approvals: 1, sent: 0 }],
  ['ROUTINE 4.2, auto-send ON', 'email', { gate: 'ROUTINE' }, { text: 'Happy to share how other fabricators handle enquiries. Shall I send two examples?', score: 4.2 }, 'true', { cadence: 'replied', approvals: 1, sent: 0 }],
  ['ROUTINE 4.7, auto-send ON (email)', 'email', { gate: 'ROUTINE' }, { text: 'Thanks for replying. We help GIDC units get a business email set up in a day. Want me to explain how?', score: 4.7 }, 'true', { cadence: 'replied', approvals: 0, sent: 1 }],
  ['ROUTINE 4.6, auto-send ON (WhatsApp)', 'whatsapp', { gate: 'ROUTINE' }, { text: 'Thanks! We set up websites and business email for local manufacturers. Shall I share one example?', score: 4.6 }, 'true', { cadence: 'replied', approvals: 0, sent: 1 }],
  ['ROUTINE empty draft', 'whatsapp', { gate: 'ROUTINE' }, { text: '', score: 5 }, 'true', { cadence: 'replied', approvals: 0, sent: 0 }],
];

(async () => {
  let failures = 0;
  for (let i = 0; i < cases.length; i++) {
    const [name, channel, gate, draft, autoSend, expect] = cases[i];
    await setSetting('CADENCE_AUTO_SEND_REPLIES', autoSend);
    await setSetting('AUTO_SEND_MIN_SCORE', '4.5');
    const lead = await freshLead(i);
    gateQueue = [gate];
    draftQueue = draft ? [draft] : [];
    const outcome = await handleCadenceReply({ lead, channel, text: 'test message', subject: 'quick question', messageId: `<t${i}@x>` });
    const s = await state(lead.id);
    const ok = s.cadence.startsWith(expect.cadence) && s.approvals.length === expect.approvals && s.sentToLead === expect.sent;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(36)} → ${outcome.padEnd(14)} ${JSON.stringify(s)}`);
  }

  // ai_paused: a human took over — nothing drafted, cadence off.
  const lead = await freshLead(99);
  await pool.query('UPDATE hotel_leads SET ai_paused=TRUE WHERE id=$1', [lead.id]);
  gateQueue = [{ gate: 'ROUTINE' }];
  const outcome = await handleCadenceReply({ lead, channel: 'whatsapp', text: 'hello' });
  const s = await state(lead.id);
  const ok = outcome === 'ai_paused' && s.approvals.length === 0 && s.cadence.startsWith('replied');
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'ai_paused (human took over)'.padEnd(36)} → ${outcome.padEnd(14)} ${JSON.stringify(s)}`);

  await setSetting('CADENCE_AUTO_SEND_REPLIES', 'false');
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
