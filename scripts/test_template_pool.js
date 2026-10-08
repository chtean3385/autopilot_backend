// Test for the automatic WhatsApp template pipeline (services/templatePoolService.js + the cadence
// picker in schedulerService.pickFollowUpTemplate). Test DB + dry run; GPT and Meta's status API are
// stubbed. Run: node scripts/test_template_pool.js (needs scripts/setup_overnight_db.js's DB).
const path = require('path');
const B = path.join(__dirname, '..') + '/';
require(B + 'node_modules/dotenv').config({ path: B + '.env' });
process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/[^/]+$/, '/autoagent_overnight');
process.env.OUTBOUND_DRY_RUN = 'true';
process.env.WABA_API_TOKEN = '';

// --- GPT stub: writes ideas; scores "LOWQ" versions 3.8, everything else 4.7 ---
const aiUsage = require(B + 'utils/aiUsage');
const prompts = [];
let draftCalls = 0;
let aiDown = false;
aiUsage.trackedCompletion = async (client, params, { purpose } = {}) => {
  if (aiDown) { const e = new Error('Incorrect API key provided (stub)'); e.status = 401; throw e; }
  if (purpose === 'wa_template_draft') {
    draftCalls++;
    const user = params.messages[1].content;
    prompts.push(user);
    const count = Number((params.messages[0].content.match(/Write (\d+) DIFFERENT/) || [])[1] || 1);
    const variants = Number((params.messages[0].content.match(/write (\d+) versions/) || [])[1] || 3);
    const trade = (user.match(/^Trade: (.*)$/m) || [])[1] || 'x';
    const ideas = Array.from({ length: count }, (_, i) => {
      const weak = draftCalls === 1 && i === 0; // first idea of the first call: only one good version → dropped
      return {
        idea: `idea_${draftCalls}_${i}`,
        versions: Array.from({ length: variants }, (__, v) =>
          `Hi {{1}}, ${weak && v > 0 ? 'LOWQ ' : ''}running a ${trade.slice(0, 30)} unit, when a new buyer asks for your company email, what do you share today? Version ${draftCalls}-${i}-${v}. Would it help if I showed you how others do it?`),
      };
    });
    return { choices: [{ message: { content: JSON.stringify({ ideas }) } }], usage: {} };
  }
  if (purpose === 'wa_template_score') {
    const body = params.messages[1].content;
    return { choices: [{ message: { content: JSON.stringify(/LOWQ/.test(body) ? { score: 3.8, note: 'sounds templated' } : { score: 4.7, note: 'natural' }) } }], usage: {} };
  }
  return { choices: [{ message: { content: '{}' } }], usage: {} };
};

const pool = require(B + 'config/db');
const WABAService = require(B + 'services/wabaService');
const TP = require(B + 'services/templatePoolService');
const { pickFollowUpTemplate } = require(B + 'services/schedulerService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const setSetting = (k, v) => pool.query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [k, String(v)]);
const groupsOf = async (niche) => (await pool.query(
  `SELECT template_group, COUNT(*)::int n, MIN(quality_score)::float min_score, array_agg(status) st, bool_or(body_text LIKE '%LOWQ%') lowq
   FROM waba_templates WHERE LOWER(industry) = $1 AND template_group IS NOT NULL AND status IN ('draft','pending_approval','approved')
   GROUP BY template_group`, [niche])).rows;

(async () => {
  // Isolate: retire earlier grouped templates and park other directory sources.
  await pool.query(`UPDATE waba_templates SET status = 'test_retired', template_group = NULL, industry = 'test_retired' WHERE template_group IS NOT NULL OR LOWER(industry) = 'directory'`);
  await pool.query(`UPDATE directory_sources SET status = 'rejected' WHERE status <> 'rejected'`);
  const src = (await pool.query(
    `INSERT INTO directory_sources (url, name, niche, city, status) VALUES ($1, 'Tpl test dir', 'Engineering', 'Gandhinagar', 'paused') RETURNING id`,
    [`https://tpl-test-${Date.now()}.example/`])).rows[0];
  for (const [k, v] of Object.entries({ WA_TEMPLATE_MIN_POOL: 2, WA_TEMPLATE_VARIANTS: 3, WA_TEMPLATE_MAX_SUBMIT_PER_DAY: 100 })) await setSetting(k, v);
  await pool.query(`DELETE FROM settings WHERE key IN ('WA_TEMPLATE_AUTO_SUBMIT','WA_TEMPLATE_MIN_SCORE')`); // defaults: auto on, 4.5

  // 1. First run: every niche gets 2 ideas × 2-3 versions, all >= 4.5, submitted automatically.
  const r1 = await TP.ensurePool();
  console.log(`      niches: ${r1.niches.map((n) => `${n.niche} (+${n.wrote?.length || 0}, dropped ${n.dropped || 0})`).join(', ')}`);
  const eng = await groupsOf('engineering');
  const gen = await groupsOf('directory');
  check(eng.length === 2 && gen.length === 2, 'each niche (engineering + generic) has 2 live message ideas', `${eng.length}/${gen.length}`);
  check([...eng, ...gen].every((g) => g.n >= 2 && g.n <= 3), 'every idea has 2-3 versions');
  check([...eng, ...gen].every((g) => g.min_score >= 4.5 && !g.lowq), 'no version below 4.5 was kept');
  check(r1.niches.some((n) => n.dropped >= 1), 'an idea with only one good version was dropped and rewritten');
  check(r1.submitted.length === 12 && r1.submitted.every((s) => s.success), 'all passing versions submitted to Meta automatically (dry-run)', String(r1.submitted.length));
  check([...eng, ...gen].every((g) => g.st.every((s) => s === 'pending_approval')), 'submitted templates are pending_approval');
  check(prompts[0].includes('Trade: engineering') || prompts.some((p) => p.includes('Trade: engineering')), 'engineering templates were written for that trade');

  // 2. Second run: pool full → nothing written or submitted.
  const before = draftCalls;
  const r2 = await TP.ensurePool();
  check(draftCalls === before && r2.submitted.length === 0, 'pool full → no new drafts, nothing submitted');

  // 3. Meta's verdicts via the real webhook route: approve engineering idea A, reject all of idea B.
  const express = require(B + 'node_modules/express');
  const app = express(); app.use(express.json()); app.use('/webhook', require(B + 'routes/webhook'));
  const server = app.listen(0);
  const hook = (name, event, reason) => fetch(`http://127.0.0.1:${server.address().port}/webhook/whatsapp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ field: 'message_template_status_update', value: { event, message_template_name: name, message_template_id: 1, reason } }] }] }),
  });
  const engRows = (await pool.query(`SELECT template_name, template_group FROM waba_templates WHERE LOWER(industry)='engineering' AND template_group IS NOT NULL AND status='pending_approval' ORDER BY template_group, variant`)).rows;
  const [gA, gB] = [...new Set(engRows.map((r) => r.template_group))];
  for (const t of engRows) await hook(t.template_name, t.template_group === gA ? 'APPROVED' : 'REJECTED', t.template_group === gB ? 'PROMOTIONAL_CONTENT_TOO_SALESY' : undefined);
  await new Promise((r) => setTimeout(r, 400));
  server.close();
  const st = await TP.poolStatus('engineering');
  check(st.approved >= 2 && st.rejected >= 2, 'webhook recorded approvals and rejections', `approved ${st.approved}, rejected ${st.rejected}`);

  // 4. Next run replaces the rejected idea and tells the writer why it was rejected.
  const r3 = await TP.ensurePool();
  const engAfter = await groupsOf('engineering');
  check(engAfter.length === 2 && r3.niches.find((n) => n.niche === 'engineering')?.wrote?.length >= 2, 'rejected idea replaced with a new one');
  check(prompts[prompts.length - 1].includes('PROMOTIONAL_CONTENT_TOO_SALESY'), "Meta's rejection reason was given to the writer");

  // 5. Hourly sync safety net: pending for over an hour → ask Meta → approved.
  await pool.query(`UPDATE waba_templates SET submitted_at = NOW() - INTERVAL '2 hours' WHERE status = 'pending_approval' AND template_group IS NOT NULL`);
  const origSync = WABAService.syncTemplateStatus;
  WABAService.syncTemplateStatus = async () => ({ success: true, status: 'approved', meta_status: 'APPROVED' });
  const sync = await TP.syncPending();
  WABAService.syncTemplateStatus = origSync;
  check(sync.changed > 0 && (await TP.poolStatus()).pending === 0, 'sync moved every pending template to approved', `${sync.changed} changed`);

  // 6. Daily submit cap.
  await setSetting('WA_TEMPLATE_MAX_SUBMIT_PER_DAY', 3);
  await pool.query(`UPDATE waba_templates SET submitted_at = NOW() - INTERVAL '2 days' WHERE submitted_at IS NOT NULL`);
  await pool.query(`INSERT INTO directory_sources (url, niche, status) VALUES ($1, 'Hotels', 'paused')`, [`https://tpl-hotels-${Date.now()}.example/`]);
  const r4 = await TP.ensurePool();
  const hotelsPending = (await pool.query(`SELECT COUNT(*)::int n FROM waba_templates WHERE LOWER(industry)='hotels' AND status='pending_approval'`)).rows[0].n;
  check(r4.submitted.length === 3 && hotelsPending === 3, 'only WA_TEMPLATE_MAX_SUBMIT_PER_DAY (3) submitted today; rest wait as drafts', `${r4.submitted.length}`);

  // 7. Picker: niche first, never two versions of one idea, versions rotate across leads.
  const mkLead = async (n) => (await pool.query(
    `INSERT INTO hotel_leads (hotel_name, owner_name, whatsapp_number, city, channel, cadence_managed, status, niche, business_category)
     VALUES ($1, 'Maulik Patel', $2, 'Gandhinagar', 'whatsapp', TRUE, 'new', 'engineering', 'Fastener') RETURNING *`,
    [`Pick test ${n} ${Date.now()}`, `9197${String(Date.now()).slice(-6)}${n}`])).rows[0];
  const L1 = await mkLead(1);
  const L2 = await mkLead(2);
  const send = async (lead) => {
    const used = new Set((await pool.query(`SELECT template_id FROM outreach_logs WHERE lead_id = $1`, [lead.id])).rows.map((r) => r.template_id));
    const t = await pickFollowUpTemplate(lead, used, { strictIndustry: true });
    if (t) await pool.query(`INSERT INTO outreach_logs (lead_id, template_id, message_type, sent_at) VALUES ($1, $2, 'template', NOW())`, [lead.id, t.id]);
    return t;
  };
  const a1 = await send(L1);
  check(a1?.industry?.toLowerCase() === 'engineering', "lead's niche templates are used before generic ones", a1?.industry);
  const a2 = await send(L1);
  check(a2 && a2.template_group !== a1.template_group, 'second message to the same lead is a different idea, not another version', `${a1?.template_group} → ${a2?.template_group}`);
  const b1 = await send(L2);
  check(b1 && b1.template_group === a1.template_group ? b1.id !== a1.id : true, 'another lead gets a different version of the same idea (volume spread)', `${a1?.template_name} vs ${b1?.template_name}`);
  const groupsForL1 = new Set();
  for (let i = 0; i < 6; i++) { const t = await send(L1); if (!t) break; check(!groupsForL1.has(t.template_group) && t.template_group !== a1.template_group && t.template_group !== a2.template_group, `send ${i + 3}: new idea each time`); groupsForL1.add(t.template_group); }

  // 8. AI down → nothing written, no crash.
  aiDown = true;
  await pool.query(`UPDATE waba_templates SET status = 'rejected' WHERE LOWER(industry) = 'hotels' AND template_group IS NOT NULL`);
  const r5 = await TP.ensurePool();
  aiDown = false;
  check(r5.niches.every((n) => !n.wrote?.length), 'AI unavailable → nothing written, run completes');

  await pool.query(`UPDATE directory_sources SET status = 'rejected' WHERE url LIKE 'https://tpl-%'`);
  await pool.query(`DELETE FROM settings WHERE key LIKE 'WA_TEMPLATE_%'`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
