// Opportunity Hunter test (2026-11-19, _docs/opportunity-hunter.md).
// Part 1 (no AI): pre-filter, owner skip rules, contact extraction, decision logic.
// Part 2 (real OpenAI, ~8 cheap gpt-4o-mini calls): the owner's real sample posts + a vacancy + junk →
//   expected email / manual WhatsApp / skip; drafts never mention money.
// Part 3: send (OUTBOUND_DRY_RUN — nothing leaves the machine) → pipeline='opportunity' lead, email_logs
//   row; every other send path skips it; a reply marks it replied and is never AI-answered.
//
// Throwaway test DB only. Run: TEST_DB_NAME=autoagent_overnight node scripts/test_opportunity_hunter.js [--no-ai]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TEST_DB = process.env.TEST_DB_NAME || 'autoagent_overnight';
if (!/overnight|test/i.test(TEST_DB)) { console.error('Refusing: TEST_DB_NAME must be a throwaway test DB'); process.exit(1); }
const u = new URL(process.env.DATABASE_URL);
u.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = u.toString();
process.env.OUTBOUND_DRY_RUN = 'true';
process.env.WABA_API_TOKEN = ''; process.env.WABA_PHONE_ID = ''; process.env.OWNER_WHATSAPP = '';

const pool = require('../config/db');
const hunter = require('../services/opportunityHunterService');
const { prefilter, hardSkipReason, extractContacts, decide, MONEY_RE } = hunter._internal;
const { _internal: readerInternal } = require('../services/waGroupReaderService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`); };
const tag = Date.now().toString(36);

const POSTS = {
  naman: `Hiring: Freelance Corporate Website Designer & Developer (Naman AI Labs — Recruitment Portal Experience a Plus)
Naman AI Labs is looking for a creative, experienced, and reliable Freelance Website Designer & Developer to collaborate with us on an upcoming professional website project.
📋 Scope of Work: Corporate Website Design, WordPress, HTML5, CSS3, responsive. Bonus: recruitment portals, job boards, applicant tracking.
💼 Engagement: Freelance / Project-Based Contract
Work Mode: Remote / Pan-India
📧 Email: Namanaiagentic+${tag}@gmail.com`,
  bench: `Job Title: Frontend Engineer (React.js / TypeScript)
Client: Enterprise SaaS
Location: [RemoteSpecify Time Zone Overlap with London, UK & EST, US Timezone]
Contact 9358196588
5 yrs exp
Need bench resource
Role Overview: build responsive interfaces with React.js, TypeScript and Redux for a SaaS platform. Collaborate with product managers and designers.`,
  pocketfm: `Urgent need App developer for one of my project.
Budget 50k-70k INR (Designing + Development + deployment + all services included)
App is similar to the pocketFM
Apply here: hello+${tag}@eliweb.in`,
  woo: `We are urgently looking for a skilled, reliable, and deadline-oriented freelance WordPress & WooCommerce Developer to join our growing fashion e-commerce startup.
Scope: build a clothing store on WooCommerce, variants, filters, checkout, payment gateway, speed optimisation, maintenance.
💼 Engagement: Freelance / Project-Based & Ongoing Support
📌 Type: Remote
📞 Contact / WhatsApp: 9512206112
apply here: jigarbamaniya2000+${tag}@gmail.com`,
  appstore: `Hiring: App Store Rejection & Compliance Specialist (Guideline 2.1 Resolution)
We are looking for an experienced App Store submissions and compliance expert to help us resolve a recent app rejection on a new Apple Developer account under Guideline 2.1 – Information Needed.
• Rejection Audit & Strategy • Submission & Appeal Package: clarification responses, demo videos, demo login • Resolution & Approval until live on the App Store.
• apply here: info+${tag}@softovita.com`,
  solulab: `Hiring: React Native Developer (Solulab — Shopify Mobile Commerce Platform | 2–5 Years Experience)
Solulab is hiring a skilled React Native Developer to help build an innovative, reusable platform that converts Shopify stores into branded Android and iOS shopping apps.
What We Look For: 2–5 years of professional software development experience, React Native, TypeScript, Shopify APIs.
Working Hours: 3:00 PM – 12:00 AM IST.
📧 Email: aditii+${tag}@solulab.co`,
  office: `Hiring Freelance PHP Laravel developer for 3 month project. Work from our Ahmedabad office (Prahladnagar). Send CV to hr+${tag}@acmesoft.in`,
  junk: `🔥 I am a freelance full stack developer with 6 years experience in React, Node and Laravel. Available for projects! Check my portfolio and DM me on 9876543210 for websites and apps at the best price.`,
};
const EXPECT = { naman: 'draft', bench: 'manual', pocketfm: 'draft', woo: 'draft', appstore: 'draft', solulab: 'skipped', office: 'skipped', junk: 'skipped' };

(async () => {
  console.log('── Part 1: rules (no AI)');
  check(!prefilter('ok thanks').pass, 'pre-filter drops short chatter');
  check(!prefilter('Good morning everyone, have a wonderful and blessed day ahead 🌞🌞🌞').pass, 'pre-filter drops greetings');
  check(prefilter(POSTS.pocketfm).pass, 'pre-filter keeps a real request');
  check(/Full-time/.test(hardSkipReason('Hiring full time developer, freelance ok') || ''), 'full-time skipped even with "freelance"');
  check(/Work from office/.test(hardSkipReason(POSTS.office) || ''), 'work from office skipped');
  check(hardSkipReason(POSTS.naman) === null, 'remote freelance post not hard-skipped');
  check(hardSkipReason(POSTS.woo) === null, '"join our growing startup" + freelance not hard-skipped');
  const c = extractContacts(`Mail A.B@x.co or call +91 98765 43210 / 09512206112. Team: 2–5 years, budget 50k-70k`);
  check(c.emails.join() === 'a.b@x.co', 'email extracted', c.emails.join());
  check(c.phones.join() === '919876543210,919512206112', 'Indian phones normalised', c.phones.join());
  const q = (type, extra = {}) => ({ engagement_type: type, work_location: { type: 'remote' }, scores: { service_fit: 25, clarity: 18, budget_signal: 0, source_quality: 8 }, ...extra });
  check(decide({ qual: q('freelance'), contacts: { emails: ['a@b.co'], phones: ['919512206112'] }, freshness: 15, minScore: 55 }).decision === 'email', 'email + phone → email');
  check(decide({ qual: q('project'), contacts: { emails: [], phones: ['919512206112'] }, freshness: 15, minScore: 55 }).decision === 'manual', 'phone only → manual WhatsApp');
  check(decide({ qual: q('job_vacancy'), contacts: { emails: ['a@b.co'], phones: [] }, freshness: 15, minScore: 55 }).decision === 'skip', 'job vacancy → skip');
  check(decide({ qual: q('freelance', { work_location: { type: 'office', place: 'Pune' } }), contacts: { emails: ['a@b.co'], phones: [] }, freshness: 15, minScore: 55 }).decision === 'skip', 'office location → skip');
  check(decide({ qual: q('freelance', { apply_email: 'evil@x.com' }), contacts: { emails: ['a@b.co'], phones: [] }, freshness: 15, minScore: 55 }).email === 'a@b.co', 'AI cannot invent an email');
  check(decide({ qual: q('freelance'), contacts: { emails: ['me@dreamstechnology.in'], phones: [] }, freshness: 15, minScore: 55, own: ['dreamstechnology.in'] }).decision === 'skip', 'own-domain email is never applied to');
  check(MONEY_RE.test('Within your ₹50–70k budget we can') && !MONEY_RE.test('We build fast WooCommerce stores'), 'money guard');
  check(readerInternal.parseLink('https://chat.whatsapp.com/AbCdEf1234567890xyz')?.kind === 'group', 'group link parsed');
  check(readerInternal.parseLink('https://whatsapp.com/channel/0029VaAbCdEf1234567890')?.kind === 'channel', 'channel link parsed');
  check(readerInternal.messageText({ ephemeralMessage: { message: { extendedTextMessage: { text: 'hi there' } } } }) === 'hi there', 'text read from wrapped message');

  if (process.argv.includes('--no-ai')) return;

  console.log('\n── Part 2: real posts through the AI');
  const sender = (await pool.query(
    `INSERT INTO email_senders (label, provider, from_email, from_name, api_key, daily_cap, status)
     VALUES ($1, 'brevo', 'chetan@dreamstechnology.in', 'Chetan Makwana', 'dry-run', 300, 'active') RETURNING *`, [`opp-test-${tag}`])).rows[0];
  await pool.query(`INSERT INTO settings (key, value) VALUES ('OPP_HUNTER_SENDER_ID', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [String(sender.id)]);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('OPP_HUNTER_MODE', 'draft') ON CONFLICT (key) DO UPDATE SET value = 'draft'`);
  const results = {};
  let aiOk = true;
  try { aiOk = (await require('../utils/aiUsage').probeKey()).ok; } catch { aiOk = false; }
  if (!aiOk) console.log('SKIP  Part 2 — no valid OpenAI key here (Part 3 uses a hand-made draft)');
  for (const [k, text] of Object.entries(aiOk ? POSTS : {})) {
    const r = await hunter.analyzeText(text);
    const o = r.opportunity;
    results[k] = o;
    const status = o?.status || (r.filteredOut ? 'filtered_out' : '?');
    check(status === EXPECT[k], `${k}: ${EXPECT[k]}`, `got ${status} · ${o?.engagement_type || ''} · score ${o?.score ?? '-'} · ${o?.skip_reason || ''}`);
    if (o?.draft_body) {
      check(!MONEY_RE.test(`${o.draft_subject}\n${o.draft_body}`), `${k}: email draft has no money talk`);
      check(o.draft_body.split(/\s+/).length <= 160, `${k}: draft is short`, `${o.draft_body.split(/\s+/).length} words`);
    }
    if (o?.wa_draft) check(!MONEY_RE.test(o.wa_draft), `${k}: WhatsApp draft has no money talk`);
  }
  if (aiOk) console.log('\nSample email draft (Naman):\n---\n' + (results.naman?.draft_subject || '') + '\n\n' + (results.naman?.draft_body || '') + '\n---');
  if (aiOk) console.log('Sample WhatsApp draft (bench):\n---\n' + (results.bench?.wa_draft || '') + '\n---');
  if (aiOk) {
    const again = await hunter.analyzeText(POSTS.naman);
    check(again.duplicate && again.opportunity?.id === results.naman?.id, 'same post twice = one opportunity');
  } else {
    const msgId = await hunter.ingestMessage({ chatJid: 'manual', waMessageId: `t-${tag}`, sender: 'test', text: POSTS.appstore });
    results.appstore = (await pool.query(
      `INSERT INTO opportunities (message_id, text_hash, source_name, post_text, title, engagement_type, decision, score, email, status, draft_subject, draft_body)
       VALUES ($1, $2, 'Pasted', $3, 'App Store 2.1 rejection', 'project', 'email', 72, $4, 'draft', 'App Store Guideline 2.1 rejection – Dreams Technology', 'Hi,

We saw you need help with a Guideline 2.1 rejection. This is work we do regularly.')
       RETURNING *`, [msgId, hunter._internal.hashText(POSTS.appstore), POSTS.appstore, `info+${tag}@softovita.com`])).rows[0];
    const dup = await hunter.ingestMessage({ chatJid: 'manual', waMessageId: `t-${tag}`, sender: 'test', text: POSTS.appstore });
    check(dup === null, 'same WhatsApp message stored once');
  }

  console.log('\n── Part 3: send (dry run) + isolation + reply');
  const o = results.appstore;
  if (o) {
    const s = await hunter.sendOpportunity(o.id);
    check(s.ok && s.dryRun, 'send ok (dry run)', JSON.stringify(s));
    const after = await hunter.getById(o.id);
    check(after.status === 'sent' && after.sender_id === sender.id, 'opportunity marked sent from the chosen mailbox');
    const lead = (await pool.query(`SELECT * FROM hotel_leads WHERE id = $1`, [after.lead_id])).rows[0];
    check(lead?.pipeline === 'opportunity' && lead.whatsapp_number === '', 'lead is pipeline=opportunity with no WhatsApp number');
    const log = (await pool.query(`SELECT * FROM email_logs WHERE lead_id = $1 AND direction = 'out'`, [lead.id])).rows;
    check(log.length === 1 && log[0].error === null, 'one email_logs row');
    check((await hunter.sendOpportunity(o.id)).ok === false, 'cannot send twice');
    const enroll = await require('../services/sequenceService').enrollLeads(
      (await pool.query(`SELECT id FROM sequences ORDER BY id LIMIT 1`)).rows[0]?.id || 0, [lead.id]);
    check(!enroll.enrolled, 'sequence enrollment skips opportunity leads', JSON.stringify(enroll));
    const followupPick = await pool.query(
      `SELECT 1 FROM hotel_leads hl WHERE hl.id = $1 AND hl.cadence_managed = FALSE AND hl.pipeline IS NULL`, [lead.id]);
    check(followupPick.rows.length === 0, 'WhatsApp follow-up / campaign filters (pipeline IS NULL) exclude it');
    await hunter.handleReply(lead, { subject: 'Re: App Store', text: 'Yes please share details', sender });
    check((await hunter.getById(o.id)).status === 'replied', 'reply → opportunity replied (owner handles)');
    const aiReplies = await pool.query(`SELECT 1 FROM email_logs WHERE lead_id = $1 AND direction = 'out'`, [lead.id]);
    check(aiReplies.rows.length === 1, 'no automatic reply sent');
  }

  // cleanup
  const opps = Object.values(results).filter(Boolean);
  const leadIds = (await pool.query(`SELECT lead_id FROM opportunities WHERE id = ANY($1) AND lead_id IS NOT NULL`, [opps.map((x) => x.id)])).rows.map((r) => r.lead_id);
  await pool.query(`DELETE FROM opportunities WHERE id = ANY($1)`, [opps.map((x) => x.id)]);
  await pool.query(`DELETE FROM opportunity_messages WHERE chat_jid = 'manual' AND (text LIKE $1 OR wa_message_id = $2)`, [`%${tag}%`, `t-${tag}`]);
  await pool.query(`DELETE FROM opportunity_messages WHERE chat_jid = 'manual' AND (text = $1 OR text = $2)`, [POSTS.bench, POSTS.junk]);
  if (leadIds.length) {
    await pool.query(`DELETE FROM email_logs WHERE lead_id = ANY($1)`, [leadIds]);
    await pool.query(`DELETE FROM agent_actions WHERE lead_id = ANY($1)`, [leadIds]);
    await pool.query(`DELETE FROM hotel_leads WHERE id = ANY($1)`, [leadIds]);
  }
  await pool.query(`DELETE FROM email_senders WHERE id = $1`, [sender.id]);
  await pool.query(`DELETE FROM settings WHERE key IN ('OPP_HUNTER_SENDER_ID', 'OPP_HUNTER_MODE')`);
})().then(async () => {
  console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASSED'}`);
  await pool.end();
  process.exit(failures ? 1 : 0);
}).catch(async (err) => {
  console.error('Test crashed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
