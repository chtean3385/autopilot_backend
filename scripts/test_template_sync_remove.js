// Test: Templates → "Sync with Meta" removes submitted templates that Meta no longer has, keeps drafts,
// keeps history rows (template_id cleared), and changes nothing if Meta's list is empty or unreadable.
// Test DB only; Meta's list is stubbed. Run: node scripts/test_template_sync_remove.js
const path = require('path');
const B = path.join(__dirname, '..') + '/';
require(B + 'node_modules/dotenv').config({ path: B + '.env' });
process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/[^/]+$/, '/autoagent_overnight');
process.env.OUTBOUND_DRY_RUN = 'true';
process.env.WABA_API_TOKEN = '';

const pool = require(B + 'config/db');
const WABAService = require(B + 'services/wabaService');
const express = require(B + 'node_modules/express');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };

(async () => {
  const tag = `synctest_${Date.now()}`;
  const mk = async (suffix, status) => (await pool.query(
    `INSERT INTO waba_templates (template_name, template_category, body_text, status) VALUES ($1, 'MARKETING', 'Hi {{1}}, test', $2) RETURNING id`,
    [`${tag}_${suffix}`, status])).rows[0].id;
  const kept = await mk('kept', 'pending_approval');
  const gone = await mk('gone', 'approved');
  const metaDeleted = await mk('metadeleted', 'approved');
  const draft = await mk('draft', 'draft');
  const prefix = await mk('prefix', 'pending_approval'); // Meta only has "<name>_x" — partial match must not count
  const lead = (await pool.query(`INSERT INTO hotel_leads (hotel_name, owner_name, whatsapp_number, city) VALUES ($1, 'Test', $2, 'X') RETURNING id`, [tag, `9196${String(Date.now()).slice(-8)}`])).rows[0].id;
  await pool.query(`INSERT INTO outreach_logs (lead_id, template_id, message_type) VALUES ($1, $2, 'template')`, [lead, gone]);

  // Only our test rows are in play: Meta "has" every other local template.
  const others = (await pool.query(`SELECT template_name FROM waba_templates WHERE template_name NOT LIKE $1`, [`${tag}%`])).rows;
  let metaList = () => new Map([
    ...others.map((r) => [r.template_name, { name: r.template_name, status: 'APPROVED', id: '1' }]),
    [`${tag}_kept`, { name: `${tag}_kept`, status: 'APPROVED', id: '777' }],
    [`${tag}_metadeleted`, { name: `${tag}_metadeleted`, status: 'DELETED', id: '8' }],
    [`${tag}_prefix_x`, { name: `${tag}_prefix_x`, status: 'APPROVED', id: '9' }],
  ]);
  WABAService.listAllMetaTemplates = async () => metaList();

  const app = express(); app.use(express.json()); app.use('/t', require(B + 'routes/templates'));
  const server = app.listen(0);
  const sync = async () => { const r = await fetch(`http://127.0.0.1:${server.address().port}/t/sync-all`, { method: 'POST' }); return { code: r.status, body: await r.json() }; };
  const exists = async (id) => (await pool.query(`SELECT status, meta_template_id FROM waba_templates WHERE id = $1`, [id])).rows[0];

  // 1. Meta unreadable → nothing changes.
  metaList = () => { throw new Error('token expired'); };
  const r0 = await sync();
  check(r0.code === 500 && await exists(gone), 'Meta list unreadable → error, nothing removed', r0.body.error);

  // 2. Meta returns nothing at all → warning, nothing removed.
  metaList = () => new Map();
  const r1 = await sync();
  check(r1.body.warning && (await exists(gone)) && (await exists(kept)), 'empty Meta list → warning, nothing removed');

  // 3. Real sync.
  metaList = () => new Map([
    ...others.map((r) => [r.template_name, { name: r.template_name, status: 'APPROVED', id: '1' }]),
    [`${tag}_kept`, { name: `${tag}_kept`, status: 'APPROVED', id: '777' }],
    [`${tag}_metadeleted`, { name: `${tag}_metadeleted`, status: 'DELETED', id: '8' }],
    [`${tag}_prefix_x`, { name: `${tag}_prefix_x`, status: 'APPROVED', id: '9' }],
  ]);
  const r2 = await sync();
  server.close();
  const k = await exists(kept);
  check(k?.status === 'approved' && k?.meta_template_id === '777', 'template still on Meta → status updated', JSON.stringify(k));
  check(!(await exists(gone)), 'submitted template missing on Meta → removed');
  check(!(await exists(metaDeleted)), 'template Meta marks DELETED → removed');
  check(!(await exists(prefix)), 'only a similarly named template on Meta → still treated as missing, removed');
  check(!!(await exists(draft)), 'draft (never submitted) → kept');
  const log = (await pool.query(`SELECT template_id FROM outreach_logs WHERE lead_id = $1`, [lead])).rows[0];
  check(log && log.template_id === null, 'outreach history kept, template link cleared');
  check(r2.body.removed?.length === 3, 'response lists removed templates', JSON.stringify(r2.body.removed));

  await pool.query(`DELETE FROM outreach_logs WHERE lead_id = $1`, [lead]);
  await pool.query(`DELETE FROM hotel_leads WHERE id = $1`, [lead]);
  await pool.query(`DELETE FROM waba_templates WHERE template_name LIKE $1`, [`${tag}%`]);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
