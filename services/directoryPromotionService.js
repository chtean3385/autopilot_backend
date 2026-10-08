const pool = require('../config/db');
const LeadService = require('./leadService');
const { findEmail } = require('./enrichmentService');
const { normalizeMobileNumber } = require('../utils/phone');
const { refreshScores } = require('./leadScoreService');

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
//   - the website lookup also fills a missing contact person / mobile from the business's own site
//   - a lead promoted without an email but with a website is retried later (backfillWebsiteEmails,
//     up to EMAIL_LOOKUP_MAX_ATTEMPTS, a day apart) — a site that was down once isn't lost
//   - every new/updated lead gets its completeness score refreshed (leadScoreService)

const SHARED_EMAIL_THRESHOLD = 3;
const DEFAULT_BATCH = 25;
const EMAIL_LOOKUP_MAX_ATTEMPTS = 3;
const EMAIL_LOOKUP_RETRY_HOURS = 24;
const DEFAULT_BACKFILL_BATCH = 10;

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
  let siteOwner = null;
  let sitePhone = null;
  let lookedUp = false;
  // The business's own website: email if the directory had none, plus a contact person / mobile
  // when the directory didn't list those either.
  if (entry.website && (!email || !entry.contact_person || !entry.phone_e164)) {
    lookedUp = !email;
    try {
      const found = await findEmail({ id: null, hotel_name: entry.company, website: entry.website });
      if (!email) {
        foundEmail = found?.email ? String(found.email).toLowerCase() : null;
        email = await usableEmail(foundEmail, source);
        if (email) emailSource = 'website';
      }
      siteOwner = found?.ownerName ? String(found.ownerName).trim() : null;
      sitePhone = found?.phone ? normalizeMobileNumber(String(found.phone)) : null;
    } catch (err) {
      console.error(`[DirectoryPromotion] findEmail failed for entry ${entry.id}:`, err.message);
    }
  }

  const phone = entry.phone_e164 || sitePhone || null;
  // No email and no mobile yet is still worth keeping when there's a website (the backfill may find
  // an email later — e.g. the site was down just now) or a landline a human can call. Such a lead
  // scores cold and the cadence never picks it until a usable channel appears.
  if (!email && !phone && !entry.website && !entry.phone_raw) {
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
    owner_name: titleCase(entry.contact_person || siteOwner || '').slice(0, 255),
    email: email || '',
    whatsapp_number: phone || '',
    phone: phone ? null : (entry.phone_raw ? String(entry.phone_raw).slice(0, 20) : null),
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
  if (result.inserted[0]) {
    // Columns addLeads doesn't take: the directory's address, and whether the website email lookup
    // already ran once (the backfill retries only what's still missing).
    await pool.query(
      `UPDATE hotel_leads SET address = $2, email_lookup_attempts = $3, last_email_lookup_at = $4 WHERE id = $1`,
      [leadId, entry.address || null, lookedUp ? 1 : 0, lookedUp ? new Date() : null]
    );
    await refreshScores([leadId]);
  }
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

// Website email backfill: directory leads that have a website but still no email get the website
// looked at again (EMAIL_LOOKUP_MAX_ATTEMPTS total, EMAIL_LOOKUP_RETRY_HOURS apart). A found email
// goes through the same rules as at promotion (not the directory's own / not shared by 3+ entries /
// not already another lead's), is stored as 'found', and emailVerificationWorker verifies it within
// the hour. channel='email' is what that worker selects on; the cadence uses both channels anyway.
async function backfillWebsiteEmails({ limit = DEFAULT_BACKFILL_BATCH } = {}) {
  const { rows } = await pool.query(
    `SELECT hl.id, hl.hotel_name, hl.website, hl.owner_name, s.url AS source_url
     FROM hotel_leads hl
     JOIN LATERAL (SELECT source_id FROM directory_entries WHERE lead_id = hl.id ORDER BY id LIMIT 1) de ON TRUE
     JOIN directory_sources s ON s.id = de.source_id
     WHERE hl.source = 'directory'
       AND COALESCE(TRIM(hl.email), '') = ''
       AND COALESCE(TRIM(hl.website), '') <> ''
       AND hl.email_lookup_attempts < $1
       AND (hl.last_email_lookup_at IS NULL OR hl.last_email_lookup_at < NOW() - make_interval(hours => $2))
       AND hl.status NOT IN ('not_interested', 'opted_out', 'dead')
     ORDER BY hl.email_lookup_attempts, hl.id
     LIMIT $3`,
    [EMAIL_LOOKUP_MAX_ATTEMPTS, EMAIL_LOOKUP_RETRY_HOURS, limit]
  );

  const stats = { checked: rows.length, found: 0, none: 0, errors: 0 };
  for (const lead of rows) {
    await pool.query(
      `UPDATE hotel_leads SET email_lookup_attempts = email_lookup_attempts + 1, last_email_lookup_at = NOW() WHERE id = $1`,
      [lead.id]
    );
    try {
      const found = await findEmail({ id: lead.id, hotel_name: lead.hotel_name, website: lead.website });
      let email = await usableEmail(found?.email, { url: lead.source_url });
      if (email) {
        const taken = await pool.query(
          'SELECT 1 FROM hotel_leads WHERE LOWER(email) = $1 AND id <> $2 LIMIT 1', [email, lead.id]
        );
        if (taken.rows[0]) email = null;
      }
      const owner = !lead.owner_name && found?.ownerName ? titleCase(String(found.ownerName)).slice(0, 255) : null;
      if (email) {
        await pool.query(
          `UPDATE hotel_leads
           SET email = $2, email_status = 'found', email_source = 'website', channel = 'email',
               email_verify_attempts = 0, owner_name = COALESCE(NULLIF($3, ''), owner_name), updated_at = NOW()
           WHERE id = $1 AND COALESCE(TRIM(email), '') = ''`,
          [lead.id, email, owner]
        );
        await pool.query('UPDATE directory_entries SET email = COALESCE(email, $2) WHERE lead_id = $1', [lead.id, email]);
        stats.found++;
      } else {
        if (owner) await pool.query(`UPDATE hotel_leads SET owner_name = $2 WHERE id = $1 AND COALESCE(owner_name, '') = ''`, [lead.id, owner]);
        stats.none++;
      }
    } catch (err) {
      console.error(`[DirectoryPromotion] website email backfill failed for lead ${lead.id}:`, err.message);
      stats.errors++;
    }
  }
  if (rows.length) {
    await refreshScores(rows.map((r) => r.id));
    console.log(`[DirectoryPromotion] website email backfill: ${JSON.stringify(stats)}`);
  }
  return stats;
}

module.exports = { promoteEntries, backfillWebsiteEmails, setCategoryFilter, titleCase, matchesFilter, EMAIL_LOOKUP_MAX_ATTEMPTS };
