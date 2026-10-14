// Past-enquiry send: import a CSV with a business_name column into a group, then queue an owner-picked
// approved template to that group and check who gets it, how it is paced, and that nothing else does.
// Throwaway test DB only (scripts/setup_overnight_db.js); Meta is stubbed in-process. Run: node scripts/test_past_enquiry.js
require('dotenv').config();
const TEST_DB = process.env.TEST_DB_NAME || 'autoagent_overnight';
if (!/overnight|test/i.test(TEST_DB)) { console.error('Refusing: TEST_DB_NAME must be a throwaway test DB'); process.exit(1); }
const u = new URL(process.env.DATABASE_URL);
u.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = u.toString();
delete process.env.OUTBOUND_DRY_RUN;
process.env.OWNER_WHATSAPP = '';
process.env.WABA_API_TOKEN = 'test'; process.env.WABA_PHONE_ID = 'test';

const axios = require('axios');
const sent = [];
axios.post = async (url, body) => {
  if (body?.to) sent.push({ to: body.to, type: body.type, template: body.template?.name });
  return { data: { messages: [{ id: `wamid.t${Date.now()}${Math.random()}` }] } };
};
axios.get = async () => ({ data: { data: [] } });

const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { importAdLeads } = require('../services/resortLeadImportService');
const pipe = require('../services/resortPipelineService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '../database/migrate_resort_crm_pipeline.sql'), 'utf8'));
  await pool.query(fs.readFileSync(path.join(__dirname, '../database/migrate_resort_intro_template.sql'), 'utf8'));
  await pool.query(`UPDATE hotel_leads SET pipeline = 'resort_crm_parked' WHERE pipeline = 'resort_crm'`);
  const tag = String(Date.now()).slice(-4);
  const g = (await pool.query(`INSERT INTO lead_groups (name) VALUES ($1) RETURNING id`, [`Ad_replied_${tag}`])).rows[0].id;
  const other = (await pool.query(`INSERT INTO lead_groups (name) VALUES ($1) RETURNING id`, [`Other_${tag}`])).rows[0].id;
  const tpl = (await pool.query(
    `INSERT INTO waba_templates (template_name, template_category, body_text, status, industry)
     VALUES ($1, 'MARKETING', 'Hello Sir/Madam', 'approved', 'all') RETURNING id`, [`final_call_${tag}`])).rows[0].id;
  const draft = (await pool.query(
    `INSERT INTO waba_templates (template_name, template_category, body_text, status) VALUES ($1, 'MARKETING', 'x', 'pending_approval') RETURNING id`, [`draft_${tag}`])).rows[0].id;

  const csv = (rows) => Buffer.from(['business_name,phone_number,city,email,how_many_rooms_do_you_manage', ...rows].join('\n'));
  const p = (n) => `+9197${tag}000${n}`;
  const rows = [`"Hotel Surya Palace","${p(1)}","Sikar","s${tag}@x.com","17"`, `"77751_hotel","${p(2)}","","",""`, `"Velvet Rose","${p(3)}","","",""`];
  const before = (await pipe.summary()).queue.eligible;
  const imp = await importAdLeads(csv(rows), 'x.csv', { groupId: g, pastEnquiry: true });
  check(imp.added === 3 && imp.grouped === 3, 'import adds 3 leads and puts them in the group', JSON.stringify({ added: imp.added, grouped: imp.grouped }));
  const leads = (await pool.query(`SELECT hotel_name, owner_name FROM hotel_leads WHERE id = ANY($1) ORDER BY id`, [imp.rows.map((r) => r.lead_id)])).rows;
  check(leads[0].hotel_name === 'Hotel Surya Palace' && leads[1].hotel_name === '77751_hotel' && leads[2].hotel_name === 'Velvet Rose' && leads.every((l) => !l.owner_name),
    'business_name becomes the hotel name (no guessing a person from it)', JSON.stringify(leads));

  check((await pool.query(`SELECT COUNT(*)::int n FROM hotel_leads WHERE id = ANY($1) AND ad_form->>'past_enquiry' = 'true'`, [imp.rows.map((r) => r.lead_id)])).rows[0].n === 3, 'leads are flagged as past enquiries');
  check((await pipe.summary()).queue.eligible === before, '"Send to all" does not count past enquiries', String(before));
  // Re-import into another group: duplicates of this pipeline join that group too, nothing is added twice
  const again = await importAdLeads(csv(rows), 'x.csv', { groupId: other });
  check(again.added === 0 && again.duplicates === 3 && again.grouped === 3, 'earlier imports can be added to a group by re-importing');
  const renamed = await importAdLeads(csv([`"Hotel Surya Palace Renamed","${p(1)}","Sikar","",""`]), 'x.csv', { groupId: g, pastEnquiry: true });
  check(renamed.duplicates === 1 && (await pool.query('SELECT hotel_name FROM hotel_leads WHERE id = $1', [imp.rows[0].lead_id])).rows[0].hotel_name === 'Hotel Surya Palace Renamed', 'a named re-import updates the name of a lead imported earlier');
  await pool.query(`UPDATE hotel_leads SET hotel_name = 'Hotel Surya Palace' WHERE id = $1`, [imp.rows[0].lead_id]);
  const dry = await importAdLeads(csv(rows), 'x.csv', { dryRun: true, groupId: g });
  check(dry.grouped === 0, 'dry run touches no group');

  const ids = imp.rows.map((r) => r.lead_id);
  // One lead already replied
  await pool.query(`INSERT INTO outreach_logs (lead_id, message_type, message_text, sent_at, response_received) VALUES ($1, 'template', 'old', NOW(), TRUE)`, [ids[2]]);

  let err = null;
  await pipe.previewTemplateSend({ templateId: draft, groupId: g }).catch((e) => { err = e.message; });
  check(/not approved/.test(err || ''), 'an unapproved template is refused');
  const prev = await pipe.previewTemplateSend({ templateId: tpl, groupId: g });
  check(prev.eligible === 2, 'preview counts only leads that have not replied', JSON.stringify(prev));

  const q = await pipe.queueAll({ gapMinutes: 3, templateId: tpl, groupId: g });
  check(q.queued === 2 && q.template === `final_call_${tag}`, 'queues 2 leads', JSON.stringify({ queued: q.queued }));
  check((await pipe.queueAll({ templateId: tpl, groupId: g })).queued === 0, 'pressing again queues nobody new');
  const st = (await pool.query(`SELECT lead_id, next_touch_at, intro_template_id FROM resort_pipeline WHERE lead_id = ANY($1) ORDER BY next_touch_at`, [ids])).rows;
  const gap = st.length === 2 ? (new Date(st[1].next_touch_at) - new Date(st[0].next_touch_at)) / 60000 : -1;
  check(st.length === 2 && gap === 3 && st.every((r) => r.intro_template_id === tpl), 'paced 3 minutes apart and remembers the template', `gap=${gap}`);

  // Make both due and run the queue tick twice: one send per tick, with the picked template
  await pool.query(`UPDATE resort_pipeline SET next_touch_at = NOW() - interval '1 minute' WHERE lead_id = ANY($1)`, [ids]);
  sent.length = 0;
  await pipe.runQueueTick();
  await pipe.runQueueTick();
  check(sent.length === 2 && sent.every((s) => s.template === `final_call_${tag}`), 'each lead gets exactly the picked template, one per tick', JSON.stringify(sent));
  check(!sent.some((s) => s.to.endsWith(`${tag}0003`)), 'the lead who already replied gets nothing');
  const after = (await pool.query(`SELECT touches, last_template FROM resort_pipeline WHERE lead_id = ANY($1)`, [ids])).rows;
  check(after.every((r) => r.touches === 1 && r.last_template === `final_call_${tag}`), 'state records touch 1 with that template');

  // Approval pulled → waits instead of sending something else
  const lone = (await importAdLeads(csv([`"Solo Inn","${p(4)}","","",""`]), 'x.csv', { groupId: g })).rows[0].lead_id;
  await pipe.queueAll({ templateId: tpl, groupId: g });
  await pool.query(`UPDATE waba_templates SET status = 'rejected' WHERE id = $1`, [tpl]);
  await pool.query(`UPDATE resort_pipeline SET next_touch_at = NOW() - interval '1 minute' WHERE lead_id = $1`, [lone]);
  sent.length = 0;
  await pipe.runQueueTick();
  check(sent.length === 0, 'a template Meta no longer approves is not substituted');

  // cleanup
  await pool.query(`DELETE FROM hotel_leads WHERE id = ANY($1)`, [[...ids, lone]]);
  await pool.query(`DELETE FROM lead_groups WHERE id = ANY($1)`, [[g, other]]);
  await pool.query(`DELETE FROM waba_templates WHERE id = ANY($1)`, [[tpl, draft]]);
  await pool.query(`UPDATE hotel_leads SET pipeline = 'resort_crm' WHERE pipeline = 'resort_crm_parked'`);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  await pool.end();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
