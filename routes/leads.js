const express = require('express');
const axios = require('axios');
const multer = require('multer');
const LeadService = require('../services/leadService');
const { parseLeadsFile } = require('../services/importService');
const { findEmail } = require('../services/enrichmentService');
const { getOrCreateResearch } = require('../services/leadResearchService');
const pool = require('../config/db');
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const MAX_BULK_DOMAINS = 50;
const BULK_DOMAIN_CONCURRENCY = 4;

// Runs fn over items with at most `limit` in flight at once.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// RAW debug: shows exact query + first result from Text Search + its Place Details
router.get('/search-raw', async (req, res) => {
  const { q, city } = req.query;
  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!googleKey) return res.status(400).json({ error: 'No GOOGLE_PLACES_API_KEY' });

  const textQuery = city ? `${q || 'hotels'} in ${city}` : (q || 'hotels');
  try {
    const searchResp = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      { params: { query: textQuery, key: googleKey, language: 'en', region: 'in' } }
    );
    const first = searchResp.data.results?.[0];
    let detailRaw = null;
    if (first?.place_id) {
      const dr = await axios.get(
        'https://maps.googleapis.com/maps/api/place/details/json',
        { params: { place_id: first.place_id, fields: 'name,formatted_phone_number,international_phone_number,website', key: googleKey } }
      );
      detailRaw = dr.data.result;
    }
    res.json({
      query_sent: textQuery,
      text_search_status: searchResp.data.status,
      total_results: searchResp.data.results?.length || 0,
      first_result_text_search: first || null,
      first_result_place_details: detailRaw,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Lightweight name list for duplicate checking in search results
router.get('/names', async (req, res) => {
  try {
    const result = await pool.query('SELECT hotel_name, city FROM hotel_leads ORDER BY hotel_name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get distinct cities with new-lead counts (for campaign targeting dropdown)
router.get('/cities', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT city, COUNT(*) AS total_leads,
             COUNT(*) FILTER (WHERE status = 'new') AS new_leads
      FROM hotel_leads
      WHERE city IS NOT NULL AND city != ''
      GROUP BY city
      ORDER BY new_leads DESC, city ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search for hotel leads via Google Places API
router.get('/search', async (req, res) => {
  const { q, city } = req.query;
  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;

  if (!googleKey && (!serperKey || serperKey === 'your_serper_key')) {
    return res.status(400).json({ error: 'No search API key configured.' });
  }

  const extractCity = (address, fallback) => {
    if (!address) return fallback || '';
    const parts = address.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!/\d{4,}/.test(parts[i]) && parts[i].length > 2) return parts[i];
    }
    return fallback || '';
  };

  try {
    if (googleKey) {
      const textQuery = city ? `${q || 'hotels'} in ${city}` : (q || 'hotels');
      const searchResp = await axios.get(
        'https://maps.googleapis.com/maps/api/place/textsearch/json',
        { params: { query: textQuery, key: googleKey, language: 'en', region: 'in' } }
      );
      const rawResults = searchResp.data.results || [];
      console.log(`[Google TextSearch] ${rawResults.length} results for: "${textQuery}"`);

      const detailed = await Promise.allSettled(
        rawResults.map(r =>
          axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
            params: { place_id: r.place_id, fields: 'name,formatted_phone_number,international_phone_number,website', key: googleKey, language: 'en' }
          })
        )
      );

      const places = rawResults.map((r, i) => {
        const detail = detailed[i].status === 'fulfilled' ? detailed[i].value.data.result : {};
        const phone = detail.international_phone_number || detail.formatted_phone_number || '';
        return {
          hotel_name: r.name || '',
          owner_name: '',
          email: detail.website || '',
          whatsapp_number: phone.replace(/\D/g, ''),
          phone,
          city: extractCity(r.formatted_address, city),
          address: r.formatted_address || '',
          rating: r.rating || null,
          reviews: r.user_ratings_total || 0,
          source: 'google',
          _raw: { ...r, detail }
        };
      });

      const withPhone = places.filter(p => p.phone).length;
      console.log(`[Google Places] ${places.length} results, ${withPhone} with phone`);
      return res.json(places);
    }

    // Serper fallback
    const query = city ? `${q || 'hotels'} in ${city}` : (q || 'hotels');
    const response = await axios.post(
      'https://google.serper.dev/places',
      { q: query, gl: 'in', hl: 'en' },
      { headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' } }
    );
    const rawPhone = (p) => p.phoneNumber || p.phone || p.telephone || p.formattedPhoneNumber || '';
    const places = (response.data.places || []).map(p => ({
      hotel_name: p.title,
      owner_name: '',
      email: p.website || '',
      whatsapp_number: rawPhone(p).replace(/\D/g, ''),
      phone: rawPhone(p),
      city: extractCity(p.address, city),
      address: p.address || '',
      rating: p.rating || null,
      reviews: p.ratingCount || 0,
      source: 'google',
      _raw: p
    }));
    res.json(places);
  } catch (err) {
    console.error('[Search Error]', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Get all leads — paginated, enriched with score + group + campaign + message_sent
router.get('/', async (req, res) => {
  const { city, status, q, channel, page = 1, pageSize = 25 } = req.query;
  const limit = Math.min(Math.max(Number(pageSize) || 25, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const conditions = [];
  const params = [];

  function addParam(val) {
    params.push(val);
    return `$${params.length}`;
  }

  if (city) conditions.push(`hl.city ILIKE ${addParam(`%${city}%`)}`);
  if (status) conditions.push(`hl.status = ${addParam(status)}`);
  if (channel) conditions.push(`hl.channel = ${addParam(channel)}`);
  if (q) {
    const p = addParam(`%${q}%`);
    conditions.push(`(hl.hotel_name ILIKE ${p} OR hl.whatsapp_number LIKE ${p} OR hl.owner_name ILIKE ${p})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM hotel_leads hl ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const limitP = addParam(limit);
    const offsetP = addParam(offset);

    const query = `
      SELECT hl.*,
        LEAST(100,
          CASE WHEN hl.whatsapp_number IS NOT NULL AND hl.whatsapp_number != '' THEN 20 ELSE 0 END
          + CASE WHEN hl.owner_name IS NOT NULL AND hl.owner_name != ''
                      AND LOWER(hl.owner_name) != LOWER(hl.hotel_name) THEN 10 ELSE 0 END
          + CASE WHEN hl.status = 'demo_qualified' THEN 50
                 WHEN hl.status = 'responded' THEN 35
                 WHEN hl.status = 'interested' THEN 25
                 ELSE 0 END
          + 0
          + CASE WHEN hl.email IS NOT NULL AND hl.email != '' THEN 5 ELSE 0 END
          + CASE WHEN EXISTS(
                   SELECT 1 FROM outreach_logs WHERE lead_id = hl.id AND response_received = true
                 ) THEN 20 ELSE 0 END
          + CASE WHEN hl.created_at > NOW() - INTERVAL '7 days' THEN 10 ELSE 0 END
        ) AS lead_score,
        (SELECT STRING_AGG(lg.name, ', ' ORDER BY lg.name)
         FROM lead_group_members lgm
         JOIN lead_groups lg ON lg.id = lgm.group_id
         WHERE lgm.lead_id = hl.id) AS groups,
        (SELECT c.campaign_name
         FROM outreach_logs ol
         JOIN campaigns c ON c.id = ol.campaign_id
         WHERE ol.lead_id = hl.id
         ORDER BY ol.sent_at DESC LIMIT 1) AS last_campaign,
        (SELECT s.name FROM lead_sequences ls JOIN sequences s ON s.id = ls.sequence_id
         WHERE ls.lead_id = hl.id ORDER BY ls.created_at DESC LIMIT 1) AS sequence_name,
        (SELECT ls.status FROM lead_sequences ls
         WHERE ls.lead_id = hl.id ORDER BY ls.created_at DESC LIMIT 1) AS sequence_status,
        EXISTS(SELECT 1 FROM outreach_logs WHERE lead_id = hl.id) AS message_sent
      FROM hotel_leads hl
      ${where}
      ORDER BY lead_score DESC, hl.created_at DESC
      LIMIT ${limitP} OFFSET ${offsetP}
    `;

    const result = await pool.query(query, params);
    res.json({ leads: result.rows, total, page: Number(page), pageSize: limit });
  } catch (err) {
    console.error('[Leads GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Add leads (bulk)
router.post('/bulk', async (req, res) => {
  const { leads } = req.body;
  const result = await LeadService.addLeads(leads);
  res.json(result);
});

// Parse an uploaded CSV/Excel file into columns + rows for the import column-mapping UI
router.post('/import/parse', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const { columns, rows } = await parseLeadsFile(req.file.buffer, req.file.originalname);
    if (rows.length === 0) return res.status(400).json({ error: 'No data rows found in file.' });
    res.json({ columns, rows });
  } catch (err) {
    console.error('[Import Parse]', err.message);
    res.status(400).json({ error: err.message || 'Failed to parse file.' });
  }
});

// Bulk domain list — owner pastes company domains/websites, agent scrapes each for a
// contact email via enrichmentService and saves the found ones as channel='email' leads.
router.post('/bulk-domains', async (req, res) => {
  const { domains } = req.body;
  if (!Array.isArray(domains) || domains.length === 0) {
    return res.status(400).json({ error: 'No domains provided.' });
  }
  const cleaned = [...new Set(domains.map(d => String(d || '').trim()).filter(Boolean))];
  if (cleaned.length === 0) return res.status(400).json({ error: 'No valid domains provided.' });
  if (cleaned.length > MAX_BULK_DOMAINS) {
    return res.status(400).json({ error: `Too many domains — max ${MAX_BULK_DOMAINS} per request.` });
  }

  const results = await mapWithConcurrency(cleaned, BULK_DOMAIN_CONCURRENCY, async (website) => {
    try {
      const { email, ownerName, phone } = await findEmail({ website, hotel_name: website });
      return { website, email, ownerName, phone, found: !!email };
    } catch (err) {
      return { website, email: null, ownerName: null, phone: null, found: false, error: err.message };
    }
  });

  const toInsert = results.filter(r => r.found).map(r => ({
    hotel_name: r.ownerName || r.website,
    owner_name: r.ownerName || '',
    email: r.email,
    phone: r.phone || '',
    website: r.website,
    whatsapp_number: '',
    city: '',
    source: 'domain_list',
    channel: 'email',
    email_source: 'domain_list',
    email_status: 'found',
  }));

  const insertResult = toInsert.length > 0
    ? await LeadService.addLeads(toInsert)
    : { success: true, added: 0, skipped: 0, inserted: [], skippedList: [] };

  res.json({ results, ...insertResult });
});

// Update full lead
// email_status is COALESCEd rather than overwritten unconditionally — it's an override path
// for when mails.so returns 'risky'/'unknown' on a real, catch-all-hosted address (the automatic
// verifier can't tell that apart from a genuine bounce); omitting it must leave the stored
// verifier result untouched rather than nulling it out.
const EMAIL_STATUS_VALUES = ['found', 'verified', 'unverifiable', 'unknown'];
router.put('/:id', async (req, res) => {
  const { hotel_name, owner_name, whatsapp_number, email, city, status, email_status } = req.body;
  if (email_status !== undefined && email_status !== null && !EMAIL_STATUS_VALUES.includes(email_status)) {
    return res.status(400).json({ error: `email_status must be one of: ${EMAIL_STATUS_VALUES.join(', ')}` });
  }
  try {
    const result = await pool.query(
      `UPDATE hotel_leads
       SET hotel_name=$1, owner_name=$2, whatsapp_number=$3, email=$4, city=$5, status=$6,
           email_status=COALESCE($7, email_status), updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [hotel_name, owner_name, whatsapp_number, email, city, status, email_status || null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update lead status only
router.put('/:id/status', async (req, res) => {
  const { status } = req.body;
  const result = await LeadService.updateLeadStatus(req.params.id, status);
  res.json(result);
});

// Get-or-create the AI research profile for a lead (one GPT-5.5 call, cached in lead_research,
// every run also appended to lead_research_versions). ?force=true recomputes: lead_research is
// updated in place, and the previous result survives as an older version in the history.
router.post('/:id/research', async (req, res) => {
  const force = req.query.force === 'true';
  try {
    const leadResult = await pool.query('SELECT * FROM hotel_leads WHERE id=$1', [req.params.id]);
    const lead = leadResult.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (!lead.website) return res.status(400).json({ error: 'Lead has no website to research' });

    const { research, wasCached } = await getOrCreateResearch(lead, { force });
    if (!research) return res.status(502).json({ error: 'Research failed — could not crawl or analyze the site' });

    res.json({ cached: wasCached, research });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual "Run Now": fire the lead's next sequence email immediately (test/inspection tool).
// Same pipeline as the 15-min worker tick — research → compose → send → advance step — but
// skips the next_run_at wait and the sequence daily cap. Required inline to avoid changing
// worker start order at boot (server.js loads workers after routes).
router.post('/:id/run-sequence', async (req, res) => {
  try {
    const { runSequenceForLead } = require('../workers/sequenceEmailWorker');
    const result = await runSequenceForLead(Number(req.params.id));
    if (result.outcome === 'busy') return res.status(409).json(result);
    if (result.outcome === 'not_enrolled') return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full research history for a lead, newest first — every past researchCompany() run, including
// versions since replaced in lead_research by a ?force=true re-run.
router.get('/:id/research/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM lead_research_versions WHERE lead_id=$1 ORDER BY version DESC`,
      [req.params.id]
    );
    res.json({ versions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete one lead
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM hotel_leads WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete multiple leads
router.post('/delete-bulk', async (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'No ids provided' });
  try {
    await pool.query('DELETE FROM hotel_leads WHERE id = ANY($1::int[])', [ids]);
    res.json({ success: true, deleted: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
