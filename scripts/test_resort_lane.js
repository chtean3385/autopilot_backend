// Test for the Resort CRM pipeline lane (_docs/resort-crm/plan.md, task 2): hotel_leads.pipeline leads
// must never be picked by any generic send path — WhatsApp follow-ups (runFollowUps), sequence
// enrollment, campaigns/agent tasks/campaign worker (guarded statically: every query that excludes
// directory leads must also exclude pipeline leads).
//
// Runs against the throwaway test DB only (scripts/setup_overnight_db.js). Meta calls are stubbed
// (axios is patched in-process) — nothing is sent.
// Run: node scripts/test_resort_lane.js
require('dotenv').config();
const TEST_DB = process.env.TEST_DB_NAME || 'autoagent_overnight';
if (!/overnight|test/i.test(TEST_DB)) { console.error('Refusing: TEST_DB_NAME must be a throwaway test DB'); process.exit(1); }
const u = new URL(process.env.DATABASE_URL);
u.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = u.toString();
delete process.env.OUTBOUND_DRY_RUN;
process.env.OWNER_WHATSAPP = ''; // owner alerts become a logged no-op
process.env.WABA_API_TOKEN = 'test'; process.env.WABA_PHONE_ID = 'test';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sentTo = [];
axios.post = async (url, body) => {
  if (body?.to) sentTo.push(String(body.to));
  return { data: { messages: [{ id: `wamid.test${Date.now()}${Math.random()}` }] } };
};

const pool = require('../config/db');
const { runFollowUps } = require('../services/schedulerService');
const SequenceService = require('../services/sequenceService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const tag = `t${Date.now()}`;

// Every non-test JS file: a line that excludes directory leads with "cadence_managed = FALSE" must
// also exclude pipeline leads — so a new send path copied from an old one can't forget it.
function staticGuard() {
  const root = path.join(__dirname, '..');
  const bad = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (['node_modules', 'scripts', '.git'].includes(name)) continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/cadence_managed\s*=\s*FALSE/i.test(line) && !/pipeline IS NULL/i.test(line)) bad.push(`${path.relative(root, p)}:${i + 1}`);
        });
      }
    }
  };
  walk(root);
  return bad;
}

(async () => {
  const migration = fs.readFileSync(path.join(__dirname, '../database/migrate_resort_crm_pipeline.sql'), 'utf8');
  await pool.query(migration);
  await pool.query(migration); // idempotent
  check(true, 'migration applies twice');

  // Importer parsing (task 3): Excel-damaged room bands, greeting names, Meta phone format.
  const { fixRooms, firstName, normalizeRow } = require('../services/resortLeadImportService');
  check(['46296', '45962', 'Nov-25', '01-Oct', '26-50', ''].map(fixRooms).join('|') === '1-10|11-25|11-25|1-10|26-50|',
    'room bands repaired', ['46296', '45962', 'Nov-25', '01-Oct', '26-50', ''].map(fixRooms).join('|'));
  check(firstName('Geogy Thomas') === 'Geogy' && firstName('The mountain king') === '' && firstName('LAVIKA STAYS') === '',
    'first name only for people, not business names');
  const n = normalizeRow({ full_name: 'hilal      this working no 6006210988', phone_number: 'p:+919816784331', city: 'srinagar' });
  check(n.lead?.whatsapp_number === '919816784331' && n.lead.owner_name === 'Hilal' && n.lead.city === 'Srinagar', 'Meta row normalised', JSON.stringify(n.lead));

  const bad = staticGuard();
  check(bad.length === 0, 'every cadence_managed exclusion also excludes pipeline leads', bad.join(', '));

  // Two leads, identical except for pipeline: both "due" for a cold follow-up (template sent 3 days ago, no reply).
  const mk = async (suffix, pipeline) => (await pool.query(
    `INSERT INTO hotel_leads (hotel_name, owner_name, city, whatsapp_number, email, email_status, channel, status, business_category, pipeline)
     VALUES ($1, 'Test Owner', 'Testcity', $2, $3, 'verified', $4, 'new', 'hotel', $5) RETURNING id`,
    [`Lane ${tag} ${suffix}`, `9199${String(Date.now()).slice(-6)}${suffix === 'normal' ? '1' : '2'}`,
     `${suffix}.${tag}@example.com`, 'whatsapp', pipeline])).rows[0];
  const normal = await mk('normal', null);
  const resort = await mk('resort', 'resort_crm');
  for (const l of [normal, resort]) {
    await pool.query(
      `INSERT INTO outreach_logs (lead_id, message_type, sent_at) VALUES ($1, 'template', NOW() - INTERVAL '3 days')`,
      [l.id]);
  }
  for (const n of [1, 2]) {
    await pool.query(
      `INSERT INTO waba_templates (template_name, template_category, body_text, status, industry)
       VALUES ($1, 'MARKETING', 'Hello {{1}}, quick follow-up idea ' || $2, 'approved', 'all') ON CONFLICT (template_name) DO NOTHING`,
      [`lane_test_${tag}_${n}`, n]);
  }
  const phones = (await pool.query('SELECT id, whatsapp_number FROM hotel_leads WHERE id = ANY($1)', [[normal.id, resort.id]])).rows;
  const phoneOf = (id) => phones.find((p) => p.id === id).whatsapp_number;

  await pool.query(`DELETE FROM job_locks WHERE job_name ILIKE '%follow%'`).catch(() => {});
  const stats = await runFollowUps('manual');
  check(sentTo.some((t) => t.endsWith(phoneOf(normal.id).slice(-10))), 'runFollowUps still sends to a normal due lead', JSON.stringify(stats));
  check(!sentTo.some((t) => t.endsWith(phoneOf(resort.id).slice(-10))), 'runFollowUps never sends to a resort_crm lead');

  // Sequence enrollment: an email-channel resort lead must be refused even when verified.
  await pool.query(`UPDATE hotel_leads SET channel = 'email' WHERE id = $1`, [resort.id]);
  const seq = (await pool.query(`SELECT id FROM sequences ORDER BY id LIMIT 1`)).rows[0];
  if (seq) {
    const r = await SequenceService.enrollLeads(seq.id, [resort.id]);
    check(r.enrolled === 0, 'sequence enrollment skips resort_crm leads', JSON.stringify(r));
  } else {
    check(true, 'sequence enrollment check skipped (no sequence in test DB)');
  }

  await pool.query('DELETE FROM outreach_logs WHERE lead_id = ANY($1)', [[normal.id, resort.id]]);
  await pool.query('DELETE FROM hotel_leads WHERE id = ANY($1)', [[normal.id, resort.id]]);
  await pool.query(`DELETE FROM waba_templates WHERE template_name LIKE $1`, [`lane_test_${tag}_%`]);

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  await pool.end();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
