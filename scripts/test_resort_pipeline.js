// End-to-end test for the Dream Stay (resort CRM) pipeline — _docs/resort-crm/plan.md tasks 3-8:
// Meta-ad import (UTF-16 TSV) → agent → templates → intro/follow-up/last with the right template per lead →
// replies (price / demo booking / screenshot / stop) → failed delivery → Call list.
//
// Throwaway test DB only (scripts/setup_overnight_db.js). OpenAI and Meta are stubbed in-process —
// nothing leaves the machine. Run: node scripts/test_resort_pipeline.js
require('dotenv').config();
const TEST_DB = process.env.TEST_DB_NAME || 'autoagent_overnight';
if (!/overnight|test/i.test(TEST_DB)) { console.error('Refusing: TEST_DB_NAME must be a throwaway test DB'); process.exit(1); }
const u = new URL(process.env.DATABASE_URL);
u.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = u.toString();
delete process.env.OUTBOUND_DRY_RUN;
process.env.OWNER_WHATSAPP = '';
process.env.WABA_API_TOKEN = 'test'; process.env.WABA_PHONE_ID = 'test';

// ── Stubs (installed before any service is loaded) ──
const axios = require('axios');
const sent = []; // { to, type, template, text, image }
axios.post = async (url, body) => {
  if (body?.to) sent.push({ to: body.to, type: body.type, template: body.template?.name, text: body.text?.body, image: body.image?.link });
  return { data: { messages: [{ id: `wamid.t${Date.now()}${Math.random()}` }], id: 'meta1', status: 'PENDING' } };
};
axios.get = async () => ({ data: { data: [] } }); // getTemplateDetails → no Meta structure → positional/mapping body params
const ai = require('../utils/aiUsage');
const aiPlan = { gate: 'CHAT', draft: 'Sure!', demo: null, image: 'none' };
ai.trackedCompletion = async (client, params, { purpose }) => {
  const reply = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });
  if (purpose === 'resort_reply_gate') return reply({ gate: aiPlan.gate, reason: 'test' });
  if (purpose === 'reply_draft') { aiPlan.lastDraftPrompt = params.messages.map((m) => m.content).join('\n'); return reply({ text: aiPlan.draft, status: 'CONTINUE', memory: { summary: 's' } }); }
  if (purpose === 'reply_score') return reply({ score: 5, feedback: 'ok' });
  if (purpose === 'resort_reply_extract') return reply(aiPlan.demo
    ? { demo_agreed: true, demo_date: aiPlan.demo[0], demo_time: aiPlan.demo[1], demo_slot_text: aiPlan.demo[2], image: aiPlan.image }
    : { demo_agreed: false, image: aiPlan.image });
  return reply({});
};

const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { importAdLeads } = require('../services/resortLeadImportService');
const { ensureAgent } = require('../services/resortCrmAgentService');
const pipe = require('../services/resortPipelineService');
const { handleResortReply } = require('../services/resortReplyService');
const { runFollowUps } = require('../services/schedulerService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const last10 = (p) => String(p).slice(-10);

// A Meta export: UTF-16LE + BOM, tab-separated, unnamed trailing notes column.
function metaExport(rows) {
  const header = ['id', 'created_time', 'platform', 'what_best_describes_your_business?', 'how_many_rooms_do_you_manage?',
    'do_you_currently_use_hotel_software?', 'when_do_you_plan_to_implement_software?', 'would_you_like_a_free_live_demo?',
    'email', 'full_name', 'phone_number', 'website', 'city', 'lead_status', ''];
  const text = [header, ...rows].map((r) => r.join('\t')).join('\r\n');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, '../database/migrate_resort_crm_pipeline.sql'), 'utf8'));
  // Leads already in this test DB (e.g. a manual preview import) would take the daily quota — park them for the run.
  await pool.query(`UPDATE hotel_leads SET pipeline = 'resort_crm_parked' WHERE pipeline = 'resort_crm'`);
  // Start from no Dream Stay templates (a crashed earlier run can leave them approved).
  await pool.query(`UPDATE outreach_logs SET template_id = NULL WHERE template_id IN (SELECT id FROM waba_templates WHERE industry = 'resort_crm')`);
  await pool.query(`DELETE FROM waba_templates WHERE industry = 'resort_crm'`);
  const tag = String(Date.now()).slice(-4);
  const phones = [`+9198${tag}0001`, `+9198${tag}0002`, `+9198${tag}0003`];
  const recent = new Date(Date.now() - 2 * 86400000).toISOString();
  const file = metaExport([
    ['l1', '2026-06-01T10:00:00', 'ig', 'hotel', '45962', 'no', 'immediately', 'yes', `a${tag}@x.com`, 'Geogy Thomas', `p:${phones[0]}`, 'xyz.com', 'kochi', 'complete', 'tomorrow 11 am call'],
    ['l2', recent, 'fb', 'resort', '26-50', 'yes', 'within_3_months', 'yes', `b${tag}@x.com`, 'The mountain king', `p:${phones[1]}`, '', 'manali', 'complete', ''],
    ['l3', '2026-06-02T10:00:00', 'ig', 'guest_house', '', '', 'just_exploring', 'no', `c${tag}@x.com`, 'Pawan Kumar', `p:${phones[2]}`, '', 'lucknow', 'complete', 'switch off'],
  ]);

  // Import
  const dry = await importAdLeads(file, 'x.csv', { dryRun: true });
  check(dry.added === 3 && (await pool.query(`SELECT 1 FROM hotel_leads WHERE email = $1`, [`a${tag}@x.com`])).rowCount === 0, 'dry run writes nothing');
  const imp = await importAdLeads(file, 'x.csv');
  check(imp.added === 3, 'import adds 3 leads', JSON.stringify({ added: imp.added, dup: imp.duplicates, invalid: imp.invalid }));
  check((await importAdLeads(file, 'x.csv')).duplicates === 3, 're-import = 3 duplicates');
  const ids = imp.rows.map((r) => r.lead_id);
  const leads = (await pool.query(`SELECT * FROM hotel_leads WHERE id = ANY($1) ORDER BY id`, [ids])).rows;
  check(leads[0].ad_form.rooms === '11-25' && leads[0].website === '' && !JSON.stringify(leads[0].ad_form).includes('11 am'),
    'room band fixed, junk website dropped, call notes not stored', JSON.stringify(leads[0].ad_form));
  check(leads.every((l) => l.pipeline === 'resort_crm' && l.email_status === 'not_checked' && l.channel === 'whatsapp'), 'leads are in the resort lane, WhatsApp only');

  // Agent + templates
  await ensureAgent();
  await pipe.ensureTemplates();
  const submitted = await pipe.submitTemplates();
  check(submitted.length >= 6 && submitted.every((s) => s.ok), 'templates submitted (stubbed Meta)', String(submitted.length));
  check(!sent.some((s) => s.to), 'submitting templates messages nobody');

  // Switched off → nothing
  await pool.query(`DELETE FROM settings WHERE key LIKE 'RESORT_%'`);
  const off = await pipe.runPipeline('manual');
  check(off.skipped === 'disabled', 'pipeline does nothing while switched off');

  await pool.query(`INSERT INTO settings (key, value) VALUES ('RESORT_PIPELINE_ENABLED', 'true'), ('RESORT_NEW_PER_DAY', '2') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const waiting = await pipe.runPipeline('manual');
  check(waiting.sent === 0 && waiting.waiting_template === 2, 'templates not approved yet → waits, sends nothing', JSON.stringify(waiting));

  await pool.query(`UPDATE waba_templates SET status = 'approved' WHERE industry = 'resort_crm' AND template_name <> 'dreamstay_enquiry_followup'`);
  await pool.query(`UPDATE resort_pipeline SET next_touch_at = NOW() WHERE lead_id = ANY($1)`, [ids]);
  const t1 = await pipe.runPipeline('manual');
  const sentTo = (i) => sent.filter((s) => s.to && last10(s.to) === last10(leads[i].whatsapp_number));
  check(t1.sent === 2 && sentTo(2).length === 0, 'daily quota 2: the two demo=yes leads go first, explorer waits', JSON.stringify(t1));
  check(sentTo(0)[0]?.template === 'dreamstay_intro_late_v1' && sentTo(1)[0]?.template === 'dreamstay_intro_fresh_v1',
    'old form → "sorry it took a while" intro, 2-day-old form → "thank you for asking" intro');
  const loggedIntro = (await pool.query(`SELECT message_text FROM outreach_logs WHERE lead_id = $1`, [ids[0]])).rows[0]?.message_text || '';
  check(loggedIntro.startsWith('Hi Geogy,') && loggedIntro.includes('your hotel in Kochi'), 'intro personalised (name + property) and logged', loggedIntro.slice(0, 60));
  const loggedIntro2 = (await pool.query(`SELECT message_text FROM outreach_logs WHERE lead_id = $1`, [ids[1]])).rows[0]?.message_text || '';
  check(loggedIntro2.startsWith('Hi there,') && loggedIntro2.includes('your resort in Manali'), 'business-name lead greeted "there", not "The"');

  // Generic follow-ups never touch them
  const before = sent.length;
  await pool.query(`UPDATE outreach_logs SET sent_at = NOW() - INTERVAL '5 days' WHERE lead_id = ANY($1)`, [ids]);
  await runFollowUps('manual');
  check(!sent.slice(before).some((s) => ids.some((_, i) => s.to && last10(s.to) === last10(leads[i].whatsapp_number))), 'generic runFollowUps never messages these leads');

  // Touch 2 picks by form answer
  await pool.query(`UPDATE resort_pipeline SET next_touch_at = NOW() WHERE lead_id = ANY($1) AND status = 'active'`, [ids]);
  await pipe.runPipeline('manual');
  check(sentTo(0)[1]?.template === 'dreamstay_fu_register_v1' && sentTo(1)[1]?.template === 'dreamstay_fu_switch_v1',
    'follow-up matches the form: no software → register/Excel angle, has software → switch angle');

  // Replies
  const reload = async (i) => (await pool.query(`SELECT * FROM hotel_leads WHERE id = $1`, [ids[i]])).rows[0];
  const reply = async (i, text) => {
    await pool.query(`UPDATE outreach_logs SET response_received = TRUE, response_text = $2, response_received_at = NOW()
      WHERE id = (SELECT id FROM outreach_logs WHERE lead_id = $1 ORDER BY sent_at DESC LIMIT 1)`, [ids[i], text]);
    return handleResortReply(await reload(i), text);
  };

  Object.assign(aiPlan, { gate: 'PRICE', draft: 'We have different modules, so we make a personalised estimate for your property. Which day and time suits you for a quick demo?', demo: null, image: 'none' });
  const p = await reply(0, 'What is the price?');
  const s0 = (await pool.query(`SELECT * FROM resort_pipeline WHERE lead_id = $1`, [ids[0]])).rows[0];
  const l0 = await reload(0);
  check(p.sent && p.gate === 'PRICE' && l0.needs_attention && /price/i.test(l0.needs_attention_reason) && s0.status === 'replied',
    'price question → AI answers (no number), owner flagged, templates stopped', l0.needs_attention_reason);
  check(aiPlan.lastDraftPrompt.includes('Do not give any number') && aiPlan.lastDraftPrompt.includes('Gujarat Pathik') && aiPlan.lastDraftPrompt.includes('rooms 11-25'),
    'drafter gets the price rule, ALL knowledge sections and the ad-form answers');

  Object.assign(aiPlan, { gate: 'CHAT', draft: 'Here is how the dashboard looks — happy to walk you through it live. Which day suits you?', image: 'dashboard' });
  const before2 = sent.length;
  await reply(0, 'Can you show me the software?');
  check(sent.slice(before2).some((s) => s.type === 'image' && s.image.endsWith('slide-01.png')), 'asked to see it → real Dashboard screenshot sent');
  Object.assign(aiPlan, { draft: 'It shows each room as a card with its status.', image: 'dashboard' });
  const before3 = sent.length;
  await reply(0, 'and the dashboard again?');
  check(!sent.slice(before3).some((s) => s.type === 'image'), 'same screenshot never sent twice');

  Object.assign(aiPlan, { draft: 'Done — Thursday 16 Oct, 4 pm. Chetan will call you then for the demo.', demo: ['2026-10-16', '16:00', 'Thu 16 Oct, 4:00 pm'], image: 'none' });
  await reply(0, 'Thursday 4 pm is fine');
  const sDemo = (await pool.query(`SELECT * FROM resort_pipeline WHERE lead_id = $1`, [ids[0]])).rows[0];
  const lDemo = await reload(0);
  check(sDemo.status === 'demo_booked' && sDemo.demo_slot === 'Thu 16 Oct, 4:00 pm' && lDemo.status === 'demo_qualified' && /Demo booked/.test(lDemo.needs_attention_reason),
    'date + time agreed → demo booked, lead flagged for owner', `${sDemo.status} | ${sDemo.demo_slot} | ${sDemo.demo_at?.toISOString()}`);
  check(sDemo.demo_at && sDemo.demo_at.toISOString() === '2026-10-16T10:30:00.000Z', '4 pm IST stored as 10:30 UTC');

  Object.assign(aiPlan, { gate: 'STOP', demo: null });
  const st = await reply(1, 'not interested');
  check(st.reason === 'not_interested' && (await reload(1)).status === 'not_interested', 'clear no → stop, nothing sent');

  // Failed delivery (Meta webhook) → Call list; third lead: touch 1 then fails
  await pool.query(`UPDATE resort_pipeline SET next_touch_at = NOW() WHERE lead_id = $1`, [ids[2]]);
  await pool.query(`DELETE FROM resort_pipeline WHERE lead_id = $1`, [ids[2]]);
  check(await pipe.sendNowForLead(ids[2]) === 'sent' && sentTo(2)[0]?.template === 'dreamstay_intro_late_v1', 'owner "send now" test button sends the intro');
  await pipe.onSendFailed(ids[2], '131049 marketing cap');
  const l2 = await reload(2);
  check(l2.call_needed_at && /WhatsApp not delivered/.test(l2.call_reason), 'failed delivery → Call list');

  // Last touch → no_response (fresh lead with no reply)
  await pool.query(`UPDATE resort_pipeline SET status = 'active', touches = 3, next_touch_at = NOW() WHERE lead_id = $1`, [ids[2]]);
  await pipe.runPipeline('manual');
  check((await pool.query(`SELECT status FROM resort_pipeline WHERE lead_id = $1`, [ids[2]])).rows[0].status === 'no_response', 'after the 3rd message with no reply → no_response');

  // ── Utility template + one-click queue (131049 fix) ──
  check(!submitted.some((s) => s.template === 'dreamstay_enquiry_followup'), 'owner-made utility template is never submitted by us');
  const qPhones = [`+9197${tag}0004`, `+9197${tag}0005`, `+9197${tag}0006`];
  const qImp = await importAdLeads(metaExport([
    ['q1', recent, 'ig', 'hotel', '1-10', 'no', 'immediately', 'yes', `d${tag}@x.com`, 'Asha Rao', `p:${qPhones[0]}`, '', 'goa', 'complete', ''],
    ['q2', recent, 'fb', 'hotel', '1-10', 'no', 'immediately', 'yes', `e${tag}@x.com`, 'Ravi Shah', `p:${qPhones[1]}`, '', 'surat', 'complete', ''],
    ['q3', recent, 'fb', 'resort', '1-10', 'no', 'just_exploring', 'no', `f${tag}@x.com`, 'Neha Jain', `p:${qPhones[2]}`, '', 'udaipur', 'complete', ''],
  ]), 'q.csv');
  const qIds = qImp.rows.map((r) => r.lead_id);
  // q2: its marketing intro was blocked by Meta 131049 (as happened live) → failed + on the Call list.
  await pool.query(`INSERT INTO resort_pipeline (lead_id, status, touches, stop_reason) VALUES ($1, 'failed', 1,
    'This message was not delivered to maintain healthy ecosystem engagement.')`, [qIds[1]]);
  await pool.query(`UPDATE hotel_leads SET call_needed_at = NOW(), call_reason = 'Dream Stay ad lead — WhatsApp not delivered' WHERE id = $1`, [qIds[1]]);

  let threw = await pipe.queueAll().then(() => false, () => true);
  check(threw, 'queue refuses while the utility template is not approved');
  await pool.query(`UPDATE waba_templates SET status = 'approved', template_category = 'MARKETING' WHERE template_name = 'dreamstay_enquiry_followup'`);
  threw = await pipe.queueAll().then(() => false, () => true);
  check(threw, 'queue refuses if Meta approved it as MARKETING (131049 would still apply)');
  await pool.query(`UPDATE waba_templates SET template_category = 'UTILITY' WHERE template_name = 'dreamstay_enquiry_followup'`);

  const qs = await pipe.queueAll({ gapMinutes: 2 });
  const qRows = (await pool.query(`SELECT lead_id, next_touch_at, queued, status FROM resort_pipeline WHERE lead_id = ANY($1) ORDER BY next_touch_at`, [qIds])).rows;
  check(qs.queued === 3 && qs.retries === 1 && qRows.every((r) => r.queued && r.status === 'active'), 'queues the 2 new leads + the 131049-blocked one', JSON.stringify(qs));
  const gaps = qRows.slice(1).map((r, i) => Math.round((new Date(r.next_touch_at) - new Date(qRows[i].next_touch_at)) / 60000));
  check(gaps.every((g) => g === 2), 'sends spaced exactly 2 minutes apart', gaps.join(','));
  check(!(await pool.query(`SELECT call_needed_at FROM hotel_leads WHERE id = $1`, [qIds[1]])).rows[0].call_needed_at, 'retried lead taken off the Call list');

  const beforeQ = sent.length;
  await pool.query(`UPDATE resort_pipeline SET next_touch_at = NOW() - INTERVAL '1 minute' WHERE lead_id = ANY($1)`, [qIds]); // all "due"
  await pipe.runPipeline('manual');
  check(sent.length === beforeQ, 'the regular tick never sends queued rows (no burst)');
  await pipe.runQueueTick();
  const qSent = sent.slice(beforeQ);
  check(qSent.length === 1 && qSent[0].template === 'dreamstay_enquiry_followup', 'queue tick sends ONE message, the utility template', JSON.stringify(qSent.map((s) => s.template)));
  await pipe.runQueueTick(); await pipe.runQueueTick();
  check(sent.length - beforeQ === 3, 'next ticks send the rest one by one');
  const retried = (await pool.query(`SELECT status, touches, queued FROM resort_pipeline WHERE lead_id = $1`, [qIds[1]])).rows[0];
  check(retried.status === 'active' && retried.touches === 1 && !retried.queued, 'blocked lead got the utility message and continues in the normal pipeline', JSON.stringify(retried));
  const again = await pipe.queueAll();
  check(again.queued === 0, 'pressing again queues nobody (each lead gets the utility message once)');

  // Stop sending: unsent queued leads go back to "not started".
  await pool.query(`DELETE FROM outreach_logs WHERE lead_id = $1`, [qIds[2]]);
  await pool.query(`DELETE FROM resort_pipeline WHERE lead_id = $1`, [qIds[2]]);
  await pipe.queueAll();
  const c = await pipe.cancelQueue();
  check(c.cancelled === 1 && !(await pool.query(`SELECT 1 FROM resort_pipeline WHERE lead_id = $1`, [qIds[2]])).rowCount, 'Stop sending puts unsent leads back to not started');
  ids.push(...qIds);

  const sum = await pipe.summary();
  check(sum.leads >= 3 && sum.demo_booked >= 1, 'summary counts', JSON.stringify(sum));

  // Clean up
  await pool.query(`DELETE FROM hotel_leads WHERE id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM settings WHERE key LIKE 'RESORT_%'`);
  await pool.query(`DELETE FROM waba_templates WHERE industry = 'resort_crm'`);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  await pool.end();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
