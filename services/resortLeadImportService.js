// Resort CRM pipeline, task 3 (_docs/resort-crm/plan.md): import Meta lead-ad exports for our own
// hotel CRM (Dream Stay) as hotel_leads with pipeline = 'resort_crm'. Nothing is sent here — the
// resort pipeline worker is the only thing that contacts these leads.
//
// Meta's "Download leads" CSV is UTF-16LE, tab-separated, with a trailing unnamed column that the team
// used for call notes. Owner decision 2026-10-11: those notes are dropped (never stored, so the AI can
// never quote them). Room-count answers like "1-10" / "11-25" come back as Excel date serials when the
// file was opened in Excel ("46296", "45962") and are converted back here.
const { parse: parseCsvSync } = require('csv-parse/sync');
const pool = require('../config/db');
const { parseLeadsFile } = require('./importService');
const { normalizeMobileNumber } = require('../utils/phone');

const PIPELINE = 'resort_crm';
const ROOM_BANDS = ['1-10', '11-25', '26-50', '51-100', '100+'];

// Meta exports text files as UTF-16LE with a BOM; everything else is treated as UTF-8.
function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.slice(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) { // UTF-16BE: swap to LE
    const swapped = Buffer.from(buffer.slice(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

async function parseRows(buffer, originalname) {
  const isText = !(buffer[0] === 0x50 && buffer[1] === 0x4b) && !buffer.slice(0, 64).toString('utf8').includes('<?xml');
  if (!isText) return (await parseLeadsFile(buffer, originalname)).rows;
  const text = decodeText(buffer);
  const header = text.split(/\r?\n/, 1)[0];
  const delimiter = header.split('\t').length > header.split(',').length ? '\t' : ',';
  return parseCsvSync(text, {
    columns: (cols) => cols.map((c, i) => c.trim() || `__extra_${i}`), // unnamed trailing column = call notes
    delimiter, skip_empty_lines: true, trim: true, relax_column_count: true, relax_quotes: true,
  });
}

// "46296" → "1-10" (Excel read "1-10" as 1 Oct); "45962" → "11-25" (read as Nov 2025). Picks whichever
// reading of the serial date matches a real answer band; anything else is passed through as typed.
// Same damage as text: "Nov-25" → "11-25", "01-Oct" → "1-10".
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function fixRooms(raw) {
  const v = String(raw || '').trim();
  const band = (candidates) => candidates.find((b) => ROOM_BANDS.includes(b));
  if (/^\d{5}$/.test(v)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(v) * 86400000);
    const day = d.getUTCDate(), month = d.getUTCMonth() + 1, yy = d.getUTCFullYear() % 100;
    return band([`${day}-${month}`, `${month}-${yy}`]) || v;
  }
  const monYy = v.match(/^([a-z]{3})-(\d{1,2})$/i);   // "Nov-25"
  if (monYy && MONTHS.includes(monYy[1].toLowerCase())) return band([`${MONTHS.indexOf(monYy[1].toLowerCase()) + 1}-${Number(monYy[2])}`]) || v;
  const ddMon = v.match(/^(\d{1,2})-([a-z]{3})$/i);   // "01-Oct"
  if (ddMon && MONTHS.includes(ddMon[2].toLowerCase())) return band([`${Number(ddMon[1])}-${MONTHS.indexOf(ddMon[2].toLowerCase()) + 1}`]) || v;
  return v || null;
}

const BUSINESS_WORDS = /\b(hotel|resort|stays?|inn|palace|villa|homestay|guest ?house|lodge|residency|retreat|pvt|private|limited|ltd|group|hospitality|tours|travels|king|camp|cottages?)\b/i;
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const TYPE_LABEL = { hotel: 'Hotel', resort: 'Resort', guest_house: 'Guest house', other: 'Property' };

// A person's first name for the greeting, or '' when the form name is really a business name.
function firstName(fullName) {
  const name = String(fullName || '').trim();
  if (!name || BUSINESS_WORDS.test(name)) return '';
  const first = name.split(/\s+/)[0].replace(/[^A-Za-z\u0900-\u097F.'-]/g, '');
  return first.length >= 2 ? titleCase(first) : '';
}

function pick(row, ...keys) {
  for (const k of keys) {
    const hit = Object.keys(row).find((h) => h.toLowerCase().replace(/[^a-z]/g, '') === k.replace(/[^a-z]/g, ''));
    if (hit && String(row[hit]).trim()) return String(row[hit]).trim();
  }
  return '';
}

// One Meta form row → a hotel_leads insert (or { error }).
function normalizeRow(row) {
  const phoneRaw = pick(row, 'phone_number', 'phone').replace(/^p:/i, '');
  const whatsapp = normalizeMobileNumber(phoneRaw);
  const fullName = pick(row, 'full_name', 'name').replace(/\s{2,}.*$/, ''); // "hilal      this working no …" → "hilal"
  const city = titleCase(pick(row, 'city'));
  const type = pick(row, 'what_best_describes_your_business?', 'what_best_describes_your_business').toLowerCase() || 'other';
  if (!whatsapp) return { error: `no valid mobile number (${phoneRaw || 'empty'})`, name: fullName };

  const isBusinessName = BUSINESS_WORDS.test(fullName);
  const ad_form = {
    business_type: type,
    rooms: fixRooms(pick(row, 'how_many_rooms_do_you_manage?', 'how_many_rooms_do_you_manage')),
    uses_software: pick(row, 'do_you_currently_use_hotel_software?', 'do_you_currently_use_hotel_software') || null,
    timeline: pick(row, 'when_do_you_plan_to_implement_software?', 'when_do_you_plan_to_implement_software') || null,
    wants_demo: pick(row, 'would_you_like_a_free_live_demo?', 'would_you_like_a_free_live_demo') || null,
    form_name: fullName || null,
    first_name: firstName(fullName) || null,
    // When they filled the form (only the newer exports have it) — picks the intro template's wording.
    submitted_at: pick(row, 'created_time') || null,
    platform: { ig: 'instagram', fb: 'facebook' }[pick(row, 'platform').toLowerCase()] || null,
    meta_lead_id: pick(row, 'id') || null,
  };
  const website = pick(row, 'website');
  return {
    lead: {
      hotel_name: isBusinessName ? titleCase(fullName) : `${TYPE_LABEL[type] || 'Property'}${city ? ` in ${city}` : ''}`,
      owner_name: isBusinessName ? '' : titleCase(fullName),
      email: pick(row, 'email').toLowerCase(),
      whatsapp_number: whatsapp,
      city,
      // Placeholders people type to get past a required field ("xyz.com", "aaa.com", "ns.con") are dropped.
      website: /^(https?:\/\/)?(www\.)?((x+y*z*|a+|abc|test|na|none|ns)\.(com?|in|con))\/?$/i.test(website) ? '' : website,
      business_category: type === 'guest_house' ? 'guest house' : type,
      ad_form,
    },
  };
}

// Returns a per-row report. dryRun = parse + dedupe only, nothing written.
async function importAdLeads(buffer, originalname, { dryRun = false } = {}) {
  const rows = await parseRows(buffer, originalname);
  const report = { total: rows.length, added: 0, duplicates: 0, invalid: 0, rows: [] };
  const seenInFile = new Set();

  for (const row of rows) {
    const { lead, error, name } = normalizeRow(row);
    if (error) { report.invalid++; report.rows.push({ name, result: 'invalid', reason: error }); continue; }
    const label = { name: lead.owner_name || lead.hotel_name, city: lead.city, phone: lead.whatsapp_number, ...lead.ad_form };

    if (seenInFile.has(lead.whatsapp_number)) { report.duplicates++; report.rows.push({ ...label, result: 'duplicate', reason: 'twice in this file' }); continue; }
    seenInFile.add(lead.whatsapp_number);

    // Same mobile (last 10 digits) or same email already in the CRM → leave that lead alone; another
    // engine may be mid-conversation with it.
    const dup = (await pool.query(
      `SELECT id, pipeline FROM hotel_leads
        WHERE RIGHT(regexp_replace(COALESCE(whatsapp_number, ''), '\\D', '', 'g'), 10) = RIGHT($1, 10)
           OR ($2 <> '' AND LOWER(email) = $2)
        LIMIT 1`,
      [lead.whatsapp_number, lead.email])).rows[0];
    if (dup) {
      report.duplicates++;
      report.rows.push({ ...label, result: 'duplicate', lead_id: dup.id, reason: dup.pipeline === PIPELINE ? 'already imported' : 'already a lead in the CRM' });
      continue;
    }

    if (!dryRun) {
      const ins = await pool.query(
        `INSERT INTO hotel_leads
           (hotel_name, owner_name, email, whatsapp_number, city, website, source, status, channel,
            email_status, business_category, pipeline, ad_form)
         VALUES ($1, $2, $3, $4, $5, $6, 'meta_ad', 'new', 'whatsapp', 'not_checked', $7, $8, $9)
         RETURNING id`,
        [lead.hotel_name, lead.owner_name, lead.email, lead.whatsapp_number, lead.city, lead.website,
         lead.business_category, PIPELINE, JSON.stringify(lead.ad_form)]);
      label.lead_id = ins.rows[0].id;
    }
    report.added++;
    report.rows.push({ ...label, result: dryRun ? 'would_add' : 'added' });
  }
  return report;
}

module.exports = { importAdLeads, parseRows, normalizeRow, fixRooms, firstName, PIPELINE };
