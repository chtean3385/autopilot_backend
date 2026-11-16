// Test for the WhatsApp 24h service-window guard (2026-11-16): WABAService.serviceWindow /
// sendTextMessage / sendImageMessage never call Meta for a free-form message to a lead who hasn't
// messaged in 24h (Meta error 131047 "Re-engagement message"), and the migration/backfill is idempotent.
//
// Throwaway test DB only; axios is stubbed — nothing reaches Meta.
// Run: TEST_DB_NAME=autoagent_overnight node scripts/test_wa_window_guard.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const TEST_DB = process.env.TEST_DB_NAME || 'autoagent_overnight';
if (!/overnight|test/i.test(TEST_DB)) { console.error('Refusing: TEST_DB_NAME must be a throwaway test DB'); process.exit(1); }
const u = new URL(process.env.DATABASE_URL);
u.pathname = `/${TEST_DB}`;
process.env.DATABASE_URL = u.toString();
delete process.env.OUTBOUND_DRY_RUN;
process.env.WABA_API_TOKEN = 'test'; process.env.WABA_PHONE_ID = 'test';
process.env.WHATSAPP_PAUSED = 'false'; // the kill switch is on by default (utils/waPause.js); axios is stubbed anyway

const axios = require('axios');
let metaCalls = 0;
axios.post = async () => { metaCalls++; return { data: { messages: [{ id: 'wamid.TEST' }] } }; };

const pool = require('../config/db');
const WABAService = require('../services/wabaService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const tag = String(Date.now()).slice(-6);
const phone = (n) => `9199${tag}${n}0`.slice(0, 12); // 12-digit Indian-style number, unique per case
const ids = [];

async function lead(n, lastInbound) {
  const { rows } = await pool.query(
    `INSERT INTO hotel_leads (hotel_name, owner_name, whatsapp_number, last_inbound_at)
     VALUES ($1, 'o', $2, ${lastInbound}) RETURNING id`, [`windowtest ${tag} ${n}`, phone(n)]);
  ids.push(rows[0].id);
  return phone(n);
}

(async () => {
  // migration is idempotent: apply the real file twice (column already exists → no-op, no error)
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrate_last_inbound_at.sql'), 'utf8');
  let migOk = true;
  try { await pool.query(sql); await pool.query(sql); } catch (e) { migOk = false; console.log(e.message); }
  check(migOk, 'migrate_last_inbound_at.sql applies twice without error');

  const open = await lead(1, `NOW() - INTERVAL '2 hours'`);
  const closed = await lead(2, `NOW() - INTERVAL '3 days'`);
  const never = await lead(3, 'NULL');
  const edge = await lead(4, `NOW() - INTERVAL '23 hours'`);
  const stranger = `91777${tag}9`; // not a lead (e.g. the owner's own number)

  let w = await WABAService.serviceWindow(open);
  check(w.known && w.open, 'lead who wrote 2h ago → window open');
  w = await WABAService.serviceWindow(closed);
  check(w.known && !w.open, 'lead who wrote 3 days ago → window closed');
  w = await WABAService.serviceWindow(never);
  check(w.known && !w.open, 'lead who never wrote → window closed');
  w = await WABAService.serviceWindow(edge);
  check(w.known && w.open, 'lead who wrote 23h ago → still open');
  w = await WABAService.serviceWindow(stranger);
  check(!w.known && w.open, 'non-lead number (owner) is never blocked');
  w = await WABAService.serviceWindow('+' + open);
  check(w.known && w.open, 'number with + / formatting still matches the lead');

  metaCalls = 0;
  let r = await WABAService.sendTextMessage(open, 'hi');
  check(r.success === true && metaCalls === 1, 'open window → text goes to Meta');
  metaCalls = 0;
  r = await WABAService.sendTextMessage(closed, 'hi');
  check(r.success === false && r.windowClosed === true && metaCalls === 0, 'closed window → NOT sent to Meta, windowClosed flag set', r.error?.slice(0, 60));
  r = await WABAService.sendTextMessage(never, 'hi');
  check(r.windowClosed === true && metaCalls === 0, 'never-replied lead → NOT sent');
  r = await WABAService.sendImageMessage(closed, 'https://example.com/a.png', 'cap');
  check(r.windowClosed === true && metaCalls === 0, 'closed window → image NOT sent either');
  r = await WABAService.sendTextMessage(stranger, 'owner alert');
  check(r.success === true && metaCalls === 1, 'non-lead number (owner alert fallback) still sends');

  // Templates are the legitimate way to reach a closed-window lead — must be untouched
  metaCalls = 0;
  r = await WABAService.sendTemplateMessage(closed, 'some_template', []);
  check(r.success === true && metaCalls === 1, 'template to a closed-window lead is still allowed');

  await pool.query(`DELETE FROM hotel_leads WHERE id = ANY($1::int[])`, [ids]);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  await pool.end();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED', e); await pool.query(`DELETE FROM hotel_leads WHERE id = ANY($1::int[])`, [ids]).catch(() => {}); process.exit(1); });
