const pool = require('../config/db');
const LeadService = require('./leadService');
const { findEmail } = require('./enrichmentService');

// Directory outreach step 2 (_docs/directory-outreach-plan.md): turns crawled directory_entries into
// hotel_leads (cadence_managed = TRUE). Promotion contacts nobody — the cadence worker (off by default)
// decides if/when. Each entry ends in exactly one state: lead_id set (new or existing lead) or a
// skip_reason. Rules:
//   - category_filter on the source (comma-separated keywords) → non-matching entries skipped
//   - an email that appears on 3+ entries is an association/CA/secretary address → never used
//   - no email but a website → existing enrichmentService.findEmail() looks on their own site
//   - email verification happens inside LeadService.addLeads() (mails.so), exactly as for every
//     other email lead; unverifiable just means the cadence uses WhatsApp only
//   - an existing lead with the same mobile or email is linked, never modified or re-contacted

const SHARED_EMAIL_THRESHOLD = 3;
const DEFAULT_BATCH = 25;

// Short vowel-less tokens are acronyms (LLP, CNC, PVC, HDG) — keep them upper-case, except the
// common abbreviations below, which read as words ("Pvt. Ltd.", "Mfg.").
const ABBREVIATIONS = new Set(['pvt', 'ltd', 'mfg', 'bros', 'st', 'dr', 'mr', 'mrs', 'shri', 'smt']);
function titleCase(text) {
  if (!text) return '';
  const s = String(text).trim();
  if (s !== s.toUpperCase()) return s; // already mixed case — the directory wrote it that way on purpose
  return s.toLowerCase().replace(/[a-z][a-z'.]*/g, (w) => {
    const letters = w.replace(/[^a-z]/g, '');
    if (letters.length > 0 && letters.length <= 4 && !/[aeiou]/.test(letters) && !ABBREVIATIONS.has(letters)) {
      return w.toUpperCase();
    }
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

function emailDomain(email) {
  return String(email || '').split('@')[1]?.toLowerCase() || '';
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function matchesFilter(entry, filter) {
  const keywords = String(filter || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (keywords.length === 0) return true;
  const haystack = `${entry.category || ''} ${entry.products || ''} ${entry.company || ''}`.toLowerCase();
  return keywords.some((k) => haystack.includes(k));
}

async function isSharedEmail(email) {
  if (!email) return false;
  const r = await pool.query(
    'SELECT COUNT(*)::int AS n FROM directory_entries WHERE LOWER(email) = LOWER($1)', [email]
  );
  return r.rows[0].n >= SHARED_EMAIL_THRESHOLD;
}

async function usableEmail(rawEmail, source) {
  const email = String(rawEmail || '').replace(/[​-‍⁠﻿\s]/g, '').toLowerCase();
  if (!/^[^@]+@[^@]+\.[a-z]{2,}$/.test(email)) return null;
  if (emailDomain(email) === hostOf(source.url)) return null; // the association's own mailbox
  if (await isSharedEmail(email)) return null;
  return email.toLowerCase();
}

async function findExistingLead(phone, email) {
  if (phone) {
    const r = await pool.query('SELECT id FROM hotel_leads WHERE whatsapp_number = $1 LIMIT 1', [phone]);
    if (r.rows[0]) return r.rows[0].id;
  }
  if (email) {
    const r = await pool.query('SELECT id FROM hotel_leads WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (r.rows[0]) return r.rows[0].id;
  }
  return null;
}

async function markEntry(entryId, { leadId = null, skipReason = null, email } = {}) {
  await pool.query(
    `UPDATE directory_entries
     SET lead_id = $2, skip_reason = $3, promoted_at = CASE WHEN $2::int IS NOT NULL THEN NOW() ELSE promoted_at END,
         email = COALESCE($4, email)
     WHERE id = $1`,
    [entryId, leadId, skipReason, email || null]
  );
}

async function promoteEntry(entry, source) {
  if (!matchesFilter(entry, source.category_filter)) {
    await markEntry(entry.id, { skipReason: 'category_filtered' });
    return 'category_filtered';
  }

  let email = await usableEmail(entry.email, source);
  let emailSource = email ? 'directory' : null;
  let foundEmail = null;
  if (!email && entry.website) {
    try {
      const found = await findEmail({ id: null, hotel_name: entry.company, website: entry.website });
      foundEmail = found?.email ? String(found.email).toLowerCase() : null;
      email = await usableEmail(foundEmail, source);
      if (email) emailSource = 'website';
    } catch (err) {
      console.error(`[DirectoryPromotion] findEmail failed for entry ${entry.id}:`, err.message);
    }
  }

  const phone = entry.phone_e164 || null;
  if (!email && !phone) {
    await markEntry(entry.id, { skipReason: 'no_contact', email: foundEmail });
    return 'no_contact';
  }

  const existingId = await findExistingLead(phone, email);
  if (existingId) {
    await markEntry(entry.id, { leadId: existingId, skipReason: 'existing_lead', email: foundEmail });
    return 'existing_lead';
  }

  const result = await LeadService.addLeads([{
    hotel_name: titleCase(entry.company).slice(0, 255),
    owner_name: titleCase(entry.contact_person || '').slice(0, 255),
    email: email || '',
    whatsapp_number: phone || '',
    phone: phone ? null : (entry.phone_raw || null),
    city: entry.city || source.city || '',
    website: entry.website || '',
    business_category: entry.category || null,
    source: 'directory',
    // channel = 'email' makes addLeads run mails.so on the address; the cadence worker uses both
    // channels regardless of this column for cadence_managed leads.
    channel: email ? 'email' : 'whatsapp',
    email_source: emailSource,
    cadence_managed: true,
    niche: source.niche ? String(source.niche).trim().toLowerCase().slice(0, 100) : null, // picks this niche's templates
  }]);

  if (!result.success) throw new Error(result.error || 'addLeads failed');
  const leadId = result.inserted[0]?.id || result.skippedList[0]?.id || null;
  if (!leadId) throw new Error('addLeads returned no lead id');
  await markEntry(entry.id, {
    leadId,
    skipReason: result.inserted[0] ? null : 'existing_lead', // addLeads' own name+city duplicate check
    email: foundEmail,
  });
  return result.inserted[0] ? `promoted:${result.inserted[0].email_status}` : 'existing_lead';
}

// Promote up to `limit` not-yet-handled entries of one source (or all non-rejected sources).
async function promoteEntries({ sourceId = null, limit = DEFAULT_BATCH } = {}) {
  const { rows } = await pool.query(
    `SELECT e.*, s.url AS source_url, s.city AS source_city, s.niche AS source_niche, s.category_filter, s.status AS source_status
     FROM directory_entries e
     JOIN directory_sources s ON s.id = e.source_id
     WHERE e.lead_id IS NULL AND e.skip_reason IS NULL
       AND s.status <> 'rejected'
       AND ($1::int IS NULL OR e.source_id = $1)
     ORDER BY e.id
     LIMIT $2`,
    [sourceId, limit]
  );

  const stats = {};
  for (const row of rows) {
    const source = { id: row.source_id, url: row.source_url, city: row.source_city, niche: row.source_niche, category_filter: row.category_filter };
    try {
      const outcome = await promoteEntry(row, source);
      stats[outcome] = (stats[outcome] || 0) + 1;
    } catch (err) {
      console.error(`[DirectoryPromotion] entry ${row.id} failed:`, err.message);
      stats.errors = (stats.errors || 0) + 1;
    }
  }
  if (rows.length) console.log(`[DirectoryPromotion] ${rows.length} entr(ies): ${JSON.stringify(stats)}`);
  return { processed: rows.length, ...stats };
}

// Changing a source's filter re-opens entries previously skipped by the old filter.
async function setCategoryFilter(sourceId, filter) {
  const r = await pool.query(
    `UPDATE directory_sources SET category_filter = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [sourceId, String(filter || '').trim() || null]
  );
  await pool.query(
    `UPDATE directory_entries SET skip_reason = NULL WHERE source_id = $1 AND skip_reason = 'category_filtered'`,
    [sourceId]
  );
  return r.rows[0];
}

module.exports = { promoteEntries, setCategoryFilter, titleCase, matchesFilter };
