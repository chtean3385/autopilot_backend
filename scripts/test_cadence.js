// Tests for the directory cadence (services/cadenceService.js) + the shared cold-email path it reuses.
// Run: node scripts/test_cadence.js — needs the throwaway DB from scripts/setup_overnight_db.js.
// Never touches the dev DB (DATABASE_URL is rewritten to autoagent_overnight) and never sends
// anything (OUTBOUND_DRY_RUN forced; the OpenAI call is stubbed at its one choke point, trackedCompletion).
//   A. planAfterTouch state machine over a lead's lifetime (pure, no DB)
//   B. runCadence end-to-end on the test DB with time fast-forwarded between ticks
//   C. regression: the existing sequence worker still sends + logs against the right lead after the
//      composeAndSendColdEmail extraction
const path = require('path');
const B = path.join(__dirname, '..') + '/';
require(B + 'node_modules/dotenv').config({ path: B + '.env' });
process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/[^/]+$/, '/autoagent_overnight');
process.env.OUTBOUND_DRY_RUN = 'true';
process.env.WABA_API_TOKEN = '';
process.env.BACKEND_URL = process.env.BACKEND_URL || 'https://bot.example.test';

// --- stub OpenAI before any service destructures trackedCompletion ---
const aiUsage = require(B + 'utils/aiUsage');
let gateAnswer = 'HANDOFF';
let coldScore = 5;
const composePrompts = [];
aiUsage.trackedCompletion = async (client, params, { purpose } = {}) => {
  if (purpose === 'sequence_email_compose') composePrompts.push(params.messages[0].content);
  const answers = {
    sequence_email_compose: { subject: 'quick question', body: `Hi, how do customers find you online today? Test body ${Date.now() % 1000}.` },
    cold_email_score: { score: coldScore, feedback: coldScore < 4.5 ? 'reads a bit templated' : 'ok' },
    followup_template_pick: {},
    sales_agent_reply_gate: { gate: gateAnswer, reason: 'test' },
  };
  return { choices: [{ message: { content: JSON.stringify(answers[purpose] || {}) } }], usage: {} };
};

const pool = require(B + 'config/db');
const { planAfterTouch, runCadence, handleWhatsappSendFailed } = require(B + 'services/cadenceService');
const { handleCadenceReply } = require(B + 'services/cadenceReplyService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const setSetting = (k, v) => pool.query(
  `INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [k, String(v)]);

// ------------------------------------------------------------------------------------------- A
function testStateMachine() {
  console.log('\n— A. state machine —');
  const cfg = { emailTouches: 2, waTouches: 3, emailGapDays: 4, waGapDays: 3, restDays: [30, 60, 90], maxCycles: 3 };
  const run = (startChannel, usable, maxCycles = 3) => {
    let s = { current_channel: startChannel, cycle_start_channel: startChannel, touches_on_channel: 0, total_touches: 0, cycle: 1, status: 'active' };
    let t = new Date('2026-10-08T05:00:00Z');
    const seq = [];
    for (let i = 0; i < 40 && s.status !== 'dead'; i++) {
      const ch = s.current_channel;
      seq.push(`${ch === 'email' ? 'E' : 'W'}${s.status === 'resting' ? '(after rest)' : ''}`);
      const prev = t;
      s = planAfterTouch(s, ch, usable, { ...cfg, maxCycles }, t);
      if (s.next_touch_at) {
        const gap = (s.next_touch_at - prev) / 86400000;
        if (gap < 3) return { seq, err: `gap ${gap}d < 3d` };
        t = s.next_touch_at;
      }
    }
    return { seq, final: s };
  };
  const both = run('email', { email: true, whatsapp: true });
  console.log('      both channels, start email:', both.seq.join(' '));
  check(!both.err && both.seq.slice(0, 5).join('') === 'EEWWW', 'cycle 1 = 2 emails then 3 WhatsApp');
  check(both.seq[5] === 'W(after rest)', 'cycle 2 starts on the other channel after a rest');
  check(both.final.status === 'dead' && both.final.cycle === 3 && both.seq.length === 15, 'stops after 3 cycles (15 touches) → dead');
  const emailOnly = run('email', { email: true, whatsapp: false });
  console.log('      email only:', emailOnly.seq.join(' '));
  check(emailOnly.seq.every((x) => x.startsWith('E')) && emailOnly.seq.length === 6, 'email-only lead: 2 per cycle, never WhatsApp');
  const waOnly = run('whatsapp', { email: false, whatsapp: true });
  check(waOnly.seq.every((x) => x.startsWith('W')) && waOnly.seq.length === 9, 'WhatsApp-only lead: 3 per cycle, never email');
  const forever = run('email', { email: true, whatsapp: true }, 0);
  check(forever.seq.length === 40 && !forever.final?.status?.includes('dead'), 'CADENCE_MAX_CYCLES=0 never stops (ran 40 touches)');
  const restGaps = [];
  let s = { current_channel: 'email', cycle_start_channel: 'email', touches_on_channel: 1, total_touches: 4, cycle: 1 };
  for (const c of [1, 2, 3, 4]) {
    const after = planAfterTouch({ ...s, current_channel: 'whatsapp', touches_on_channel: 2, cycle: c }, 'whatsapp', { email: true, whatsapp: true }, { ...cfg, maxCycles: 0 }, new Date(0));
    restGaps.push(after.next_touch_at / 86400000);
  }
  check(restGaps.join(',') === '30,60,90,90', 'rests 30 → 60 → 90 → 90 days', restGaps.join(','));
}

// ------------------------------------------------------------------------------------------- B
// Cold email needs research on the lead (owner's rule, 2026-10-09) — give email test leads a research row.
async function addResearch(lead) {
  await pool.query(
    `INSERT INTO lead_research (lead_id, summary, pain_points, email_angles) VALUES ($1, 'Test fabrication shop.', '["slow quotes"]', '["quote follow-ups"]')
     ON CONFLICT (lead_id) DO NOTHING`, [lead.id]);
  return lead;
}

async function makeLead(name, { email = null, emailStatus = 'unknown', wa = '' } = {}) {
  const r = await pool.query(
    `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, channel, cadence_managed, status, email_status, business_category)
     VALUES ($1, 'Test Person', $2, $3, 'Gandhinagar', $4, TRUE, 'new', $5, 'Fabrication (All Type)') RETURNING *`,
    [`${name} ${Date.now()}`, email || '', wa, email ? 'email' : 'whatsapp', emailStatus]
  );
  return email ? addResearch(r.rows[0]) : r.rows[0];
}

async function testCadenceEndToEnd() {
  console.log('\n— B. runCadence on the test DB (dry-run, time fast-forwarded) —');
  // Earlier runs used today's intake quota — age their rows so this run starts with a fresh day.
  await pool.query(`UPDATE lead_cadence SET started_at = started_at - INTERVAL '3 days'`);
  // Park every other directory lead so intake only sees the test leads.
  await pool.query(`UPDATE hotel_leads SET status = 'test_parked' WHERE cadence_managed AND status = 'new'`);
  // Retire (not delete) earlier directory templates — sent-message logs reference them.
  await pool.query(`UPDATE waba_templates SET industry = 'test_retired', template_name = template_name || '_r' || id WHERE LOWER(industry) = 'directory'`);
  const run = Date.now() % 100000;
  for (let i = 1; i <= 4; i++) {
    await pool.query(
      `INSERT INTO waba_templates (template_name, template_category, body_text, status, industry) VALUES ($1, 'MARKETING', $2, 'approved', 'directory')`,
      [`tst_dir_${run}_${i}`, `Hi {{1}}, test directory template ${i}`]
    );
  }
  for (const [k, v] of Object.entries({
    CADENCE_ENABLED: 'true', CADENCE_NEW_EMAIL_PER_DAY: 2, CADENCE_NEW_WA_PER_DAY: 2, CADENCE_MAX_CYCLES: 2,
    CADENCE_EMAIL_ONLY_IF_VERIFIED: 'false', // this timeline checks the both-channels mode; the default is tested below
  })) await setSetting(k, v);

  const sfx = String(Date.now()).slice(-6);
  const L = {
    both: await makeLead('CadTest Both', { email: `both.${sfx}@example.com`, emailStatus: 'verified', wa: `9198${sfx}01` }),
    emailOnly: await makeLead('CadTest EmailOnly', { email: `eonly.${sfx}@example.com`, emailStatus: 'verified' }),
    waOnly: await makeLead('CadTest WaOnly', { wa: `9197${sfx}02` }),
    unverified: await makeLead('CadTest Unverified', { email: `unv.${sfx}@example.com`, emailStatus: 'unknown' }),
    replier: await makeLead('CadTest Replier', { email: `rep.${sfx}@example.com`, emailStatus: 'verified', wa: `9196${sfx}03` }),
  };
  const ids = Object.values(L).map((l) => l.id);
  const timeline = Object.fromEntries(Object.keys(L).map((k) => [k, []]));

  for (let tick = 1; tick <= 16; tick++) {
    const before = await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM agent_actions`);
    const stats = await runCadence('manual');
    if (tick === 1) console.log('      tick 1 intake:', JSON.stringify(stats.intake));
    const sent = await pool.query(
      `SELECT lead_id, action FROM agent_actions WHERE id > $1 AND action IN ('cadence_email_sent','cadence_whatsapp_sent') AND lead_id = ANY($2)`,
      [before.rows[0].m, ids]
    );
    for (const [k, l] of Object.entries(L)) {
      const mine = sent.rows.filter((r) => r.lead_id === l.id).map((r) => (r.action === 'cadence_email_sent' ? 'E' : 'W'));
      timeline[k].push(mine.join('') || '·');
    }
    if (tick === 2) { gateAnswer = 'HANDOFF'; await handleCadenceReply({ lead: L.replier, channel: 'email', text: 'What is the price?' }); }
    // Fast-forward: everything due now, last touch long ago (keeps the same-day guard honest).
    await pool.query(
      `UPDATE lead_cadence SET next_touch_at = NOW() - INTERVAL '1 minute', last_touch_at = last_touch_at - INTERVAL '5 days'
       WHERE lead_id = ANY($1) AND status IN ('active', 'resting')`, [ids]);
  }
  for (const [k, t] of Object.entries(timeline)) console.log(`      ${k.padEnd(11)} ${t.join(' ')}`);

  const flat = (k) => timeline[k].join('').replace(/·/g, '');
  check(timeline.both.every((x) => x.length <= 1) && timeline.replier.every((x) => x.length <= 1), 'never more than one touch per lead per tick');
  check(flat('both').startsWith('EEWWW'), 'both-channel lead: E E W W W first cycle', flat('both'));
  check(/^E+$/.test(flat('emailOnly')) && flat('emailOnly').length === 4, 'email-only lead: emails only, 2 per cycle × 2 cycles', flat('emailOnly'));
  check(/^W+$/.test(flat('waOnly')), 'WhatsApp-only lead: WhatsApp only', flat('waOnly'));
  check(flat('unverified') === '', 'unverified email (no WhatsApp) is never contacted');
  const repliedAfter = timeline.replier.slice(2).join('').replace(/·/g, '');
  check(repliedAfter === '', 'lead who replied after tick 2 gets nothing more', `before: ${timeline.replier.slice(0, 2).join(' ')}`);
  const st = Object.fromEntries((await pool.query(`SELECT lead_id, status, stop_reason FROM lead_cadence WHERE lead_id = ANY($1)`, [ids])).rows.map((r) => [r.lead_id, r]));
  check(st[L.emailOnly.id]?.status === 'dead', 'email-only lead dead after 2 cycles', st[L.emailOnly.id]?.status);
  check(st[L.replier.id]?.status === 'replied', 'replier cadence status = replied');
  const tplReuse = await pool.query(
    `SELECT lead_id, template_id, COUNT(*)::int n FROM outreach_logs WHERE lead_id = ANY($1) GROUP BY 1, 2 HAVING COUNT(*) > 1`, [ids]);
  check(tplReuse.rows.length === 0, 'no WhatsApp template ever sent twice to the same lead');
  const unsent = await pool.query(`SELECT COUNT(*)::int n FROM email_logs WHERE lead_id = $1`, [L.unverified.id]);
  check(unsent.rows[0].n === 0, 'no email row at all for the unverified lead');
  const notDry = await pool.query(
    `SELECT COUNT(*)::int n FROM email_logs WHERE lead_id = ANY($1) AND provider_message_id NOT LIKE '%dryrun%'`, [ids]);
  check(notDry.rows[0].n === 0, 'every email went through the dry-run guard');

  // CADENCE_EMAIL_ONLY_IF_VERIFIED on (the default): verified email → email only, never WhatsApp.
  await pool.query(`DELETE FROM settings WHERE key = 'CADENCE_EMAIL_ONLY_IF_VERIFIED'`);
  await pool.query(`UPDATE lead_cadence SET started_at = started_at - INTERVAL '3 days'`); // free today's intake quota
  const sfx2 = String(Date.now()).slice(-6);
  const M = {
    both: await makeLead('CadTest Both2', { email: `both2.${sfx2}@example.com`, emailStatus: 'verified', wa: `9195${sfx2}04` }),
    waFailEmail: await makeLead('CadTest WaFailEmail', { email: `wfe.${sfx2}@example.com`, emailStatus: 'unknown', wa: `9194${sfx2}05` }),
    waFailNoEmail: await makeLead('CadTest WaFailNoEmail', { wa: `9193${sfx2}06` }),
  };
  const mIds = Object.values(M).map((l) => l.id);
  const mSent = { both: '', waFailEmail: '', waFailNoEmail: '' };
  for (let tick = 1; tick <= 4; tick++) {
    const before = await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM agent_actions`);
    await runCadence('manual');
    const sent = await pool.query(
      `SELECT lead_id, action FROM agent_actions WHERE id > $1 AND action IN ('cadence_email_sent','cadence_whatsapp_sent') AND lead_id = ANY($2)`,
      [before.rows[0].m, mIds]);
    for (const [k, l] of Object.entries(M)) mSent[k] += sent.rows.filter((r) => r.lead_id === l.id).map((r) => (r.action === 'cadence_email_sent' ? 'E' : 'W')).join('');
    if (tick === 1) {
      // Meta refuses both first WhatsApp templates (async webhook). One lead's email is verified meanwhile.
      await pool.query(`UPDATE hotel_leads SET email_status = 'verified' WHERE id = $1`, [M.waFailEmail.id]);
      for (const l of [M.waFailEmail, M.waFailNoEmail]) await handleWhatsappSendFailed(l.id, 'This message was not delivered to maintain healthy ecosystem engagement.');
    }
    await pool.query(
      `UPDATE lead_cadence SET next_touch_at = NOW() - INTERVAL '1 minute', last_touch_at = last_touch_at - INTERVAL '5 days'
       WHERE lead_id = ANY($1) AND status IN ('active', 'resting')`, [mIds]);
  }
  console.log('      email-only-if-verified:', JSON.stringify(mSent));
  check(/^E+$/.test(mSent.both), 'verified email + WhatsApp → email only (default)', mSent.both);
  check(/^WE+$/.test(mSent.waFailEmail), 'WhatsApp failed → never WhatsApp again, moved to email', mSent.waFailEmail);
  check(mSent.waFailNoEmail === 'W', 'WhatsApp failed, no email → nothing more sent', mSent.waFailNoEmail);
  const callRow = (await pool.query(`SELECT call_needed_at, call_reason FROM hotel_leads WHERE id = $1`, [M.waFailNoEmail.id])).rows[0];
  check(Boolean(callRow.call_needed_at) && /WhatsApp not delivered/.test(callRow.call_reason || ''), 'WhatsApp failed, no email → on the Call list', callRow.call_reason);
  const notOnList = (await pool.query(`SELECT call_needed_at FROM hotel_leads WHERE id = $1`, [M.waFailEmail.id])).rows[0];
  check(!notOnList.call_needed_at, 'lead moved to email is not on the Call list');

  // disabled → nothing
  await setSetting('CADENCE_ENABLED', 'false');
  const off = await runCadence('manual');
  check(off.skipped && /CADENCE_ENABLED/.test(off.reason), 'CADENCE_ENABLED=false → manual run does nothing');

  await pool.query(`UPDATE hotel_leads SET status = 'new' WHERE status = 'test_parked'`);
  await pool.query(`DELETE FROM settings WHERE key IN ('CADENCE_NEW_EMAIL_PER_DAY','CADENCE_NEW_WA_PER_DAY','CADENCE_MAX_CYCLES')`);
}

// ------------------------------------------------------------------------------------------- C
async function testSequenceRegression() {
  console.log('\n— C. existing sequence worker after the refactor —');
  const sfx = String(Date.now()).slice(-6);
  const lead = (await pool.query(
    `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, channel, status, email_status)
     VALUES ($1, 'Seq Owner', $2, '', 'Ahmedabad', 'email', 'new', 'verified') RETURNING *`,
    [`SeqRegression ${sfx}`, `seq.${sfx}@example.com`]
  )).rows[0];
  await addResearch(lead);
  const seq = (await pool.query(
    `INSERT INTO sequences (name, initial_gaps, daily_send_limit) VALUES ('Regression seq', '[3,5]', 50) RETURNING id`)).rows[0];
  // Pad lead_sequences ids so a sequence-row id can't accidentally equal the lead id.
  await pool.query(`SELECT setval(pg_get_serial_sequence('lead_sequences','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM lead_sequences), $1) + 1000)`, [lead.id]);
  const ls = (await pool.query(
    `INSERT INTO lead_sequences (lead_id, sequence_id, current_step, next_run_at, status) VALUES ($1, $2, 0, NOW(), 'active') RETURNING id`,
    [lead.id, seq.id])).rows[0];
  const { runSequenceWorker } = require(B + 'workers/sequenceEmailWorker');
  const stats = await runSequenceWorker('manual');
  const log = (await pool.query(`SELECT sequence_id, provider_message_id FROM email_logs WHERE lead_id = $1 AND direction = 'out'`, [lead.id])).rows;
  const row = (await pool.query(`SELECT current_step FROM lead_sequences WHERE id = $1`, [ls.id])).rows[0];
  const scored = (await pool.query(`SELECT lead_id FROM agent_actions WHERE action = 'cold_email_scored' ORDER BY id DESC LIMIT 1`)).rows[0];
  check(stats.sent === 1, 'sequence worker sent 1 email', JSON.stringify({ sent: stats.sent, due: stats.due }));
  check(log.length === 1 && log[0].sequence_id === seq.id, 'email_logs row written with the sequence id');
  check(row.current_step === 1, 'lead_sequences advanced to step 1');
  check(scored?.lead_id === lead.id && ls.id !== lead.id, 'quality score logged against the LEAD id, not the sequence-row id', `lead ${lead.id}, seq row ${ls.id}`);
  await pool.query(`UPDATE lead_sequences SET status = 'dead' WHERE id = $1`, [ls.id]);
}

// ------------------------------------------------------------------------------------------- D
async function testEmailQualityGate() {
  console.log('\n— D. directory email 4.5 quality gate —');
  await pool.query(`UPDATE hotel_leads SET status = 'test_parked' WHERE cadence_managed AND status = 'new'`);
  await pool.query(`UPDATE lead_cadence SET started_at = started_at - INTERVAL '3 days'`);
  await setSetting('CADENCE_ENABLED', 'true');
  const sfx = String(Date.now()).slice(-6);
  const lead = (await pool.query(
    `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, channel, cadence_managed, status, email_status, niche, business_category)
     VALUES ($1, 'Maulik Patel', $2, '', 'Gandhinagar', 'email', TRUE, 'new', 'verified', 'engineering', 'Fastener') RETURNING *`,
    [`Gate test ${sfx}`, `gate.${sfx}@example.com`])).rows[0];
  await addResearch(lead);
  const sentCount = async () => (await pool.query(`SELECT COUNT(*)::int n FROM email_logs WHERE lead_id = $1 AND direction = 'out'`, [lead.id])).rows[0].n;

  coldScore = 4.2;
  composePrompts.length = 0;
  await runCadence('manual');
  const lc = (await pool.query(`SELECT next_touch_at FROM lead_cadence WHERE lead_id = $1`, [lead.id])).rows[0];
  const held = (await pool.query(`SELECT COUNT(*)::int n FROM agent_actions WHERE lead_id = $1 AND action = 'cadence_email_held'`, [lead.id])).rows[0].n;
  check(await sentCount() === 0 && held === 1, 'draft scoring 4.2 is NOT sent (held)');
  check(composePrompts.length === 3, 'rewritten 3 times before holding', String(composePrompts.length));
  check(lc && new Date(lc.next_touch_at) - Date.now() > 20 * 3600000, 'retried tomorrow, not every tick');
  check(composePrompts.every((p) => /typing a quick message himself/.test(p) && /engineering/.test(p)), "composer got the human-tone rules and the lead's trade");

  coldScore = 4.8;
  await pool.query(`UPDATE lead_cadence SET next_touch_at = NOW() - INTERVAL '1 minute' WHERE lead_id = $1`, [lead.id]);
  await runCadence('manual');
  check(await sentCount() === 1, 'draft scoring 4.8 is sent');
  coldScore = 5;
  await setSetting('CADENCE_ENABLED', 'false');
  await pool.query(`UPDATE hotel_leads SET status = 'new' WHERE status = 'test_parked'`);
}

(async () => {
  testStateMachine();
  await testCadenceEndToEnd();
  await testSequenceRegression();
  await testEmailQualityGate();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
