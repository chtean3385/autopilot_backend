const axios = require('axios');
const schedule = require('node-schedule');
const OpenAI = require('openai');
const pool = require('../config/db');
const WABAService = require('./wabaService');
const LeadService = require('./leadService');
const { findEmail } = require('./enrichmentService');
const SequenceService = require('./sequenceService');
const SchedulerStatusService = require('./schedulerStatusService');
const { notifyAdmin } = require('./adminNotifyService');
const { trackedCompletion } = require('../utils/aiUsage');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Auto-create table on startup
pool.query(`
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id SERIAL PRIMARY KEY,
    instruction TEXT NOT NULL,
    city VARCHAR(100),
    lead_count INTEGER DEFAULT 20,
    template_id INTEGER REFERENCES waba_templates(id),
    status VARCHAR(50) DEFAULT 'pending',
    run_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    leads_scraped INTEGER DEFAULT 0,
    leads_saved INTEGER DEFAULT 0,
    messages_sent INTEGER DEFAULT 0,
    campaign_id INTEGER REFERENCES campaigns(id),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )
`).then(async () => {
  console.log('[Scheduler] agent_tasks table ready');
  // Fix 2: migrate pre-approval-gate tasks so cron doesn't run them without user review
  await pool.query(`UPDATE agent_tasks SET status='needs_approval' WHERE status='pending' AND parsed_params IS NULL`);
  // Email-channel agent tasks: same table, extra columns (no campaign/template concept for email —
  // discovery auto-enrolls straight into a sequence instead of a reviewed WhatsApp send step).
  await pool.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'whatsapp'`);
  await pool.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS sequence_id INTEGER REFERENCES sequences(id)`);
  await pool.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES lead_groups(id)`);
  await pool.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS emails_found INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS emails_verified INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS leads_enrolled INTEGER DEFAULT 0`);
}).catch(err => console.error('[Scheduler] Table init error:', err.message));

// Refine the user's instruction using GPT.
// Returns { refinedInstruction, refinementNote, parsed, canRun }
// canRun=false only if the city is completely missing and unfixable.
async function refineInstruction(instruction) {
  try {
    const res = await trackedCompletion(openai, {
      model: 'gpt-4o-mini',
      max_tokens: 900,
      messages: [
        {
          role: 'system',
          content: `You are a lead generation assistant for an Indian B2B WhatsApp outreach tool called Dreams Technology.

What the tool CAN do:
- Search any business type (restaurants, hotels, gyms, salons, pharmacies, dental clinics, etc.) in any Indian city via Google Places
- Filter out businesses that already have a website (website field comes from Google Places Details API)
- Send WhatsApp template messages to found businesses
- An AI bot auto-replies on WhatsApp to qualify leads for a demo
- Auto follow-up every 2 days for 10 days if no reply

What it CANNOT do:
- Filter by Google rating or reviews
- Search outside India
- Send emails or make calls

Your job:
1. Fix typos and grammar in the instruction — do NOT add words that are not in the original
2. Extract business type, city, and count from the instruction
3. Keep the user's original intent exactly — do NOT add filters or conditions they did not mention
4. CRITICAL: filterHasWebsite must be true ONLY when the user explicitly says "no website", "without website", "don't have website", "without a website listing" or very similar. If they did NOT mention website at all, set filterHasWebsite: false. Do NOT assume or add this filter by default.
5. If city is completely missing, note it in refinementNote
6. Generate a WhatsApp bot system prompt tailored to the specific business type for qualifying leads

The systemPrompt you generate must:
- Be for a WhatsApp sales bot representing Dreams Technology (Indian business software company)
- Be tailored to the specific business type — understand their pain points, language, and needs
- Focus on qualifying: is the person a decision maker, do they have a problem our software solves, will they take a free demo?
- Use short WhatsApp-style replies (1-3 sentences), conversational, can mix Hindi/Hinglish naturally
- NEVER say it is an AI
- End every reply with exactly one tag on a new line: [CONTINUE], [QUALIFIED], or [NOT_INTERESTED]

Example — user says "find 30 IT companies in Gandhinagar" (NO website mention):
{
  "refinedInstruction": "Find 30 IT companies in Gandhinagar and send WhatsApp outreach today",
  "refinementNote": "Fixed typos. No website filter applied as user did not mention it.",
  "parsed": {
    "businessType": "IT companies",
    "city": "Gandhinagar",
    "count": 30,
    "filterHasWebsite": false
  },
  "systemPrompt": "...",
  "canRun": true
}

Example — user says "find dental clinics in Mumbai who don't have website" (explicit website mention):
{
  "refinedInstruction": "Find 30 dental clinics in Mumbai without a website and send WhatsApp outreach today",
  "refinementNote": "Website filter applied — will skip clinics that already have a website listed on Google.",
  "parsed": {
    "businessType": "dental clinics",
    "city": "Mumbai",
    "count": 30,
    "filterHasWebsite": true
  },
  "systemPrompt": "...",
  "canRun": true
}

Now respond with JSON only for the user's actual instruction:`
        },
        { role: 'user', content: instruction }
      ],
      response_format: { type: 'json_object' },
    }, { purpose: 'task_refine_instruction' });
    const result = JSON.parse(res.choices[0].message.content);
    return {
      refinedInstruction: result.refinedInstruction || instruction,
      refinementNote: result.refinementNote || '',
      parsed: result.parsed || {},
      systemPrompt: result.systemPrompt || null,
      canRun: result.canRun !== false,
    };
  } catch (err) {
    console.error('[Scheduler] refineInstruction error:', err.message);
    // Fallback: basic parse, send back as-is
    const countMatch = instruction.match(/\b(\d+)\b/);
    const count = countMatch ? parseInt(countMatch[1]) : 20;
    const words = instruction.split(/\s+/);
    const inIdx = words.findIndex(w => w.toLowerCase() === 'in');
    const city = inIdx !== -1 ? words[inIdx + 1]?.replace(/[^a-zA-Z]/g, '') : '';
    return {
      refinedInstruction: instruction,
      refinementNote: 'GPT unavailable — using instruction as-is.',
      parsed: { businessType: 'businesses', city, count },
      systemPrompt: null,
      canRun: !!city,
    };
  }
}

async function parseInstruction(instruction) {
  const r = await refineInstruction(instruction);
  return r.parsed;
}

// Matches one or more bare URLs in free text (trailing sentence punctuation stripped).
const URL_REGEX = /https?:\/\/[^\s,"'<>]+/gi;
function extractUrls(instruction) {
  const matches = instruction.match(URL_REGEX) || [];
  return [...new Set(matches.map(u => u.replace(/[.,;:)\]]+$/, '')))];
}

// Same idea as refineInstruction, but for the email channel: no WhatsApp bot system prompt
// to generate, no website/review filters (a website is *required* for email discovery — no
// website means there's nowhere to scrape a contact email from, so that's implicit, not a filter).
async function refineEmailInstruction(instruction) {
  // A direct link means "scrape exactly this site" — skip the city-based Google Places
  // search (and the GPT call) entirely rather than failing because no city was mentioned.
  const directUrls = extractUrls(instruction);
  if (directUrls.length > 0) {
    return {
      refinedInstruction: instruction,
      refinementNote: `Direct link${directUrls.length > 1 ? 's' : ''} detected — scraping ${directUrls.length} site(s) directly instead of searching Google Places, so no city is needed.`,
      parsed: { businessType: 'businesses', city: '', count: directUrls.length, directUrls },
      canRun: true,
    };
  }

  try {
    const res = await trackedCompletion(openai, {
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: `You are a lead generation assistant for an Indian B2B cold-email outreach tool called Dreams Technology.

What the tool CAN do:
- Search any business type in any Indian city via Google Places
- Only businesses with a website listed on Google are usable (their site gets scraped for a contact email — no website means no email can be found)
- Scrape each business's website and use GPT to extract the best contact email + owner name
- Verify each email with a deliverability checker before it's allowed into a sequence
- Auto-enroll verified leads into a follow-up email sequence that sends and follows up forever until they reply or opt out

What it CANNOT do:
- Search outside India
- Find emails for businesses without a website
- Send WhatsApp messages or make calls

Your job:
1. Fix typos and grammar in the instruction — do NOT add words that are not in the original
2. Extract business type, city, and count (how many leads to find) from the instruction
3. Keep the user's original intent exactly — do NOT add filters or conditions they did not mention
4. If city is completely missing, note it in refinementNote

Respond with JSON only: {"refinedInstruction": string, "refinementNote": string, "parsed": {"businessType": string, "city": string, "count": number}, "canRun": boolean}`
        },
        { role: 'user', content: instruction }
      ],
      response_format: { type: 'json_object' },
    }, { purpose: 'email_task_refine_instruction' });
    const result = JSON.parse(res.choices[0].message.content);
    return {
      refinedInstruction: result.refinedInstruction || instruction,
      refinementNote: result.refinementNote || '',
      parsed: result.parsed || {},
      canRun: result.canRun !== false,
    };
  } catch (err) {
    console.error('[Scheduler] refineEmailInstruction error:', err.message);
    const countMatch = instruction.match(/\b(\d+)\b/);
    const count = countMatch ? parseInt(countMatch[1]) : 20;
    const words = instruction.split(/\s+/);
    const inIdx = words.findIndex(w => w.toLowerCase() === 'in');
    const city = inIdx !== -1 ? words[inIdx + 1]?.replace(/[^a-zA-Z]/g, '') : '';
    return {
      refinedInstruction: instruction,
      refinementNote: 'GPT unavailable — using instruction as-is.',
      parsed: { businessType: 'businesses', city, count },
      canRun: !!city,
    };
  }
}

// Normalize raw phone → 12-digit WhatsApp-ready Indian mobile (91XXXXXXXXXX)
// Returns null for landlines or invalid numbers.
//
// Indian landline detection using Google's international_phone_number format:
//   Mobiles:   "+91 98765 43210"  → digit groups after +91: one group of 10
//   Landlines: "+91 79 2345 6789" → digit groups after +91: STD (2-3 digits) + local (6-8 digits)
//
// We detect landlines by checking if the number after +91 is split into
// a short STD prefix (2-3 digits) followed by 6-8 digit local number.
function normalizeMobileNumber(rawPhone) {
  const str = (rawPhone || '').trim();

  // If Google gave us international format (+91 ...), analyse the spacing
  const intlMatch = str.match(/^\+91\s+(.+)$/);
  if (intlMatch) {
    const afterCode = intlMatch[1].trim();
    const parts = afterCode.split(/\s+/);

    if (parts.length >= 2) {
      // First part is STD code (2-4 digits), rest is local number
      // Mobile numbers from Google come as a single group or 2 groups of 5
      const firstLen = parts[0].replace(/\D/g, '').length;
      const restDigits = parts.slice(1).join('').replace(/\D/g, '');

      // Landline pattern: short first group (2-4 digits) + 6-8 digit local
      if (firstLen <= 4 && restDigits.length >= 6 && restDigits.length <= 8) {
        console.log(`[Scraper] Rejecting landline (STD format): ${str}`);
        return null;
      }
    }
  }

  // Strip all non-digits and validate as Indian mobile
  const digits = str.replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('91')) {
    const mobile = digits.slice(2);
    if (/^[6-9]\d{9}$/.test(mobile)) return digits;
    return null;
  }

  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) {
    return '91' + digits;
  }

  // 11 digits with leading 0 (local STD format like 07912345678) — likely landline
  if (digits.length === 11 && digits.startsWith('0')) {
    const withoutZero = digits.slice(1);
    if (/^[6-9]\d{9}$/.test(withoutZero)) return '91' + withoutZero;
    return null;
  }

  return null;
}

// Scrape any business type from Google Places.
// Fetches page by page (20 results each, max 3 pages = 60 from Google).
// Stops as soon as we have enough valid mobile leads OR Google runs out of pages.
async function scrapeLeads(city, count, businessType = 'businesses', filterHasWebsite = false, maxReviews = null) {
  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!googleKey) throw new Error('GOOGLE_PLACES_API_KEY not set');

  const searchQuery = `${businessType} in ${city}`;
  console.log(`[Scraper] Searching: "${searchQuery}" — need ${count} mobile leads`);

  const extractCity = (address, fallback) => {
    if (!address) return fallback || '';
    const parts = address.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!/\d{4,}/.test(parts[i]) && parts[i].length > 2) return parts[i];
    }
    return fallback || '';
  };

  const leads = [];
  let rawCount = 0;
  let landlineCount = 0;
  let noPhoneCount = 0;
  let pageToken = null;
  let pageNum = 0;

  do {
    pageNum++;
    const params = { query: searchQuery, key: googleKey, language: 'en', region: 'in' };
    if (pageToken) params.pagetoken = pageToken;

    const searchResp = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      { params }
    );

    // Google Places returns HTTP 200 even for quota/auth/request errors — the real signal is
    // the `status` field. Silently treating those as "0 results" (as this used to) reports a
    // misleading "no leads found" when the actual cause is e.g. a quota cap or a bad API key.
    const apiStatus = searchResp.data.status;
    if (apiStatus !== 'OK' && apiStatus !== 'ZERO_RESULTS') {
      throw new Error(`Google Places API error: ${apiStatus}${searchResp.data.error_message ? ' — ' + searchResp.data.error_message : ''}`);
    }

    const pageResults = searchResp.data.results || [];
    pageToken = searchResp.data.next_page_token || null;
    rawCount += pageResults.length;

    console.log(`[Scraper] Page ${pageNum}: ${pageResults.length} results from Google (${leads.length}/${count} mobile found so far)`);

    // Fetch Place Details for this page in parallel (10 at a time)
    const detailed = await Promise.allSettled(
      pageResults.map(r =>
        axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
          params: {
            place_id: r.place_id,
            fields: 'name,formatted_phone_number,international_phone_number,website',
            key: googleKey,
            language: 'en',
          }
        })
      )
    );

    for (let i = 0; i < pageResults.length; i++) {
      if (leads.length >= count) break; // have enough, stop processing this page

      const r = pageResults[i];
      const detail = detailed[i].status === 'fulfilled' ? detailed[i].value.data.result : {};
      const rawPhone = detail.international_phone_number || detail.formatted_phone_number || '';

      if (!rawPhone) {
        noPhoneCount++;
        console.log(`[Scraper] Skip "${r.name}" — no phone`);
        continue;
      }

      const mobile = normalizeMobileNumber(rawPhone);
      if (!mobile) {
        landlineCount++;
        console.log(`[Scraper] Skip "${r.name}" — landline: ${rawPhone}`);
        continue;
      }

      if (filterHasWebsite && detail.website) {
        console.log(`[Scraper] Skip "${r.name}" — has website`);
        continue;
      }

      if (maxReviews !== null && (r.user_ratings_total || 0) >= maxReviews) {
        console.log(`[Scraper] Skip "${r.name}" — ${r.user_ratings_total} reviews`);
        continue;
      }

      leads.push({
        hotel_name: r.name || '',
        owner_name: r.name || '',
        email: detail.website || '',
        whatsapp_number: mobile,
        phone: rawPhone,
        city: extractCity(r.formatted_address, city),
        business_category: businessType,
        source: 'agent',
      });
    }

    // Wait before next page token becomes valid (Google requirement)
    if (pageToken && leads.length < count) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

  } while (pageToken && leads.length < count);

  console.log(`[Scraper] Done — Google returned ${rawCount} total | Landline: ${landlineCount} | No phone: ${noPhoneCount} | Valid mobile: ${leads.length}/${count} requested`);

  return {
    leads,
    stats: { rawFromGoogle: rawCount, landline: landlineCount, noPhone: noPhoneCount, validMobile: leads.length },
  };
}

// Runs fn over items with at most `limit` in flight at once (same pattern as routes/leads.js's
// bulk-domains concurrency helper — kept local since it's a tiny, generic 10-liner).
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

// Email-channel equivalent of scrapeLeads: no phone/mobile requirement (email doesn't need one),
// but a website IS required since that's the only way to find a contact email. Stops once we have
// `count` businesses with a website OR Google runs out of pages.
async function scrapePlacesForWebsites(city, count, businessType = 'businesses') {
  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!googleKey) throw new Error('GOOGLE_PLACES_API_KEY not set');

  const searchQuery = `${businessType} in ${city}`;
  console.log(`[EmailScraper] Searching: "${searchQuery}" — need ${count} leads with a website`);

  const extractCity = (address, fallback) => {
    if (!address) return fallback || '';
    const parts = address.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!/\d{4,}/.test(parts[i]) && parts[i].length > 2) return parts[i];
    }
    return fallback || '';
  };

  const candidates = [];
  let rawCount = 0;
  let noWebsiteCount = 0;
  let pageToken = null;
  let pageNum = 0;

  do {
    pageNum++;
    const params = { query: searchQuery, key: googleKey, language: 'en', region: 'in' };
    if (pageToken) params.pagetoken = pageToken;

    const searchResp = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      { params }
    );

    const apiStatus = searchResp.data.status;
    if (apiStatus !== 'OK' && apiStatus !== 'ZERO_RESULTS') {
      throw new Error(`Google Places API error: ${apiStatus}${searchResp.data.error_message ? ' — ' + searchResp.data.error_message : ''}`);
    }

    const pageResults = searchResp.data.results || [];
    pageToken = searchResp.data.next_page_token || null;
    rawCount += pageResults.length;

    console.log(`[EmailScraper] Page ${pageNum}: ${pageResults.length} results from Google (${candidates.length}/${count} with website so far)`);

    const detailed = await Promise.allSettled(
      pageResults.map(r =>
        axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
          params: { place_id: r.place_id, fields: 'name,website', key: googleKey, language: 'en' }
        })
      )
    );

    for (let i = 0; i < pageResults.length; i++) {
      if (candidates.length >= count) break;

      const r = pageResults[i];
      const detail = detailed[i].status === 'fulfilled' ? detailed[i].value.data.result : {};

      if (!detail.website) {
        noWebsiteCount++;
        console.log(`[EmailScraper] Skip "${r.name}" — no website`);
        continue;
      }

      candidates.push({
        hotel_name: r.name || '',
        website: detail.website,
        city: extractCity(r.formatted_address, city),
        business_category: businessType,
      });
    }

    if (pageToken && candidates.length < count) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

  } while (pageToken && candidates.length < count);

  console.log(`[EmailScraper] Done — Google returned ${rawCount} total | No website: ${noWebsiteCount} | With website: ${candidates.length}/${count} requested`);

  return {
    candidates,
    stats: { rawFromGoogle: rawCount, noWebsite: noWebsiteCount, withWebsite: candidates.length },
  };
}

// Save leads, skip duplicates by whatsapp_number or (business_name + city).
// Returns array of saved lead IDs.
async function saveLeads(leads) {
  const savedIds = [];
  for (const lead of leads) {
    try {
      // Check duplicate by number OR by name+city combo
      const existing = await pool.query(
        `SELECT id FROM hotel_leads
         WHERE whatsapp_number = $1
            OR (LOWER(hotel_name) = LOWER($2) AND LOWER(city) = LOWER($3))`,
        [lead.whatsapp_number, lead.hotel_name, lead.city]
      );
      if (existing.rows.length > 0) {
        console.log(`[Scraper] Duplicate skipped: "${lead.hotel_name}" (${lead.whatsapp_number})`);
        continue;
      }

      const result = await pool.query(
        `INSERT INTO hotel_leads
           (hotel_name, owner_name, email, whatsapp_number, city, phone, source, business_category, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new')
         RETURNING id`,
        [lead.hotel_name, lead.owner_name, lead.email, lead.whatsapp_number,
         lead.city, lead.phone, lead.source, lead.business_category || null]
      );
      if (result.rows[0]) savedIds.push(result.rows[0].id);
    } catch (err) {
      console.error(`[Scraper] saveLeads error for "${lead.hotel_name}":`, err.message);
    }
  }
  return savedIds;
}

// Upsert a city group and add the given lead IDs into it
async function upsertCityGroup(city, businessType, leadIds) {
  if (!leadIds.length) return null;

  const groupName = `${businessType} in ${city}`;
  const groupResult = await pool.query(
    `INSERT INTO lead_groups (name, description)
     VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [groupName, `${businessType} scraped from ${city}`]
  );
  const groupId = groupResult.rows[0].id;

  for (const leadId of leadIds) {
    await pool.query(
      `INSERT INTO lead_group_members (group_id, lead_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [groupId, leadId]
    );
  }

  console.log(`[Scheduler] Group "${groupName}" (id=${groupId}) — added ${leadIds.length} leads`);
  return groupId;
}

// Get the best available approved template (task-specific or latest approved)
async function getApprovedTemplate(templateId) {
  if (templateId) {
    const t = await pool.query(
      `SELECT * FROM waba_templates WHERE id=$1 AND status='approved'`,
      [templateId]
    );
    if (t.rows[0]) return t.rows[0];
  }
  const t = await pool.query(
    `SELECT * FROM waba_templates WHERE status='approved' ORDER BY created_at DESC LIMIT 1`
  );
  return t.rows[0] || null;
}

// Run a single agent task end-to-end
async function runTask(task) {
  const taskId = task.id;

  // Fix 1: compare-and-swap — only one caller (approve route or cron) wins the race
  const claim = await pool.query(
    `UPDATE agent_tasks SET status='running', started_at=NOW() WHERE id=$1 AND status='pending' RETURNING id`,
    [taskId]
  );
  if (claim.rowCount === 0) {
    console.log(`[Scheduler] Task ${taskId} already claimed by another process — skipping`);
    return;
  }

  try {
    console.log(`[Scheduler] Task ${taskId}: "${task.instruction}"`);

    // 1. Use stored parsed_params (set during analysis) or fall back to parsing now
    let parsedParams = task.parsed_params;
    if (typeof parsedParams === 'string') parsedParams = JSON.parse(parsedParams);
    if (!parsedParams || !parsedParams.city) {
      parsedParams = await parseInstruction(task.instruction);
    }

    const { city, count, businessType = 'businesses', filterHasWebsite = false, maxReviews = null } = parsedParams;
    if (!city) {
      throw new Error('City could not be determined from instruction. Please specify a city name.');
    }
    const leadCount = task.lead_count || count || 20;

    console.log(`[Scheduler] Params → businessType="${businessType}" city="${city}" count=${leadCount} filterHasWebsite=${filterHasWebsite} maxReviews=${maxReviews}`);

    // 2. Scrape Google Places
    const { leads: scraped, stats } = await scrapeLeads(city, leadCount, businessType, filterHasWebsite, maxReviews);
    console.log(`[Scheduler] Scrape stats for ${businessType} in ${city}:`, stats);

    // 3. Save new leads (deduplicated) — returns saved lead IDs
    const savedIds = await saveLeads(scraped);
    const saved = savedIds.length;
    console.log(`[Scheduler] Saved ${saved} new leads (${scraped.length} valid mobile found, ${leadCount} requested, ${stats.rawFromGoogle} raw from Google)`);

    if (saved === 0) {
      await pool.query(
        `UPDATE agent_tasks SET status='done', completed_at=NOW(), leads_scraped=$1, leads_saved=0,
         messages_sent=0, error_message=$2 WHERE id=$3`,
        [stats.rawFromGoogle, `No new leads found — Google returned ${stats.rawFromGoogle} results but ${stats.landline} were landlines, ${stats.noPhone} had no phone, rest were duplicates`, taskId]
      );
      return;
    }

    // 4. Auto-create/update business+city group, get back groupId
    const groupId = await upsertCityGroup(city, businessType, savedIds);

    // 5. Create campaign (draft — not sent yet; admin reviews leads first)
    const campaignName = `Agent: ${businessType} in ${city} – ${new Date().toLocaleDateString('en-IN')}`;
    const campResult = await pool.query(
      `INSERT INTO campaigns (campaign_name, template_id, target_city, target_type, status, created_by, system_prompt, business_type, group_id)
       VALUES ($1, $2, $3, 'city', 'draft', 'agent', $4, $5, $6) RETURNING *`,
      [campaignName, task.template_id || null, city, task.system_prompt || null, businessType, groupId]
    );
    const campaign = campResult.rows[0];

    // 6. Set task to 'preview' — wait for admin to review leads then trigger send
    // leads_scraped = raw Google count so UI can show "Google returned X, mobile only: Y"
    await pool.query(
      `UPDATE agent_tasks SET status='preview', leads_scraped=$1, leads_saved=$2, campaign_id=$3 WHERE id=$4`,
      [stats.rawFromGoogle, saved, campaign.id, taskId]
    );

    console.log(`[Scheduler] Task ${taskId} → preview (${saved} leads ready for review)`);

  } catch (err) {
    console.error(`[Scheduler] Task ${taskId} failed:`, err.message);
    await pool.query(
      `UPDATE agent_tasks SET status='failed', completed_at=NOW(), error_message=$1 WHERE id=$2`,
      [err.message, taskId]
    );
  }
}

// Email-channel equivalent of runTask, end-to-end and fully automatic (no preview/send-review
// step — the owner decided auto-enroll is the right default): Places search for businesses with
// a website → scrape each site for a contact email → verify + store (LeadService.addLeads does
// the verification) → auto-enroll every verified lead into the sequence chosen when the task was
// created. From here sequenceEmailWorker/emailReplyWorker take over forever with zero more clicks.
async function runEmailTask(task) {
  const taskId = task.id;

  const claim = await pool.query(
    `UPDATE agent_tasks SET status='running', started_at=NOW() WHERE id=$1 AND status='pending' RETURNING id`,
    [taskId]
  );
  if (claim.rowCount === 0) {
    console.log(`[Scheduler] Email task ${taskId} already claimed by another process — skipping`);
    return;
  }

  try {
    console.log(`[Scheduler] Email task ${taskId}: "${task.instruction}"`);

    let parsedParams = task.parsed_params;
    if (typeof parsedParams === 'string') parsedParams = JSON.parse(parsedParams);
    if (!parsedParams || (!parsedParams.city && !parsedParams.directUrls?.length)) {
      const refined = await refineEmailInstruction(task.instruction);
      parsedParams = refined.parsed;
    }

    const { city, count, businessType = 'businesses', directUrls } = parsedParams;
    if (!city && !directUrls?.length) throw new Error('City could not be determined from instruction. Please specify a city name.');
    if (!task.sequence_id) throw new Error('No sequence selected for this task — pick one before approving.');

    const leadCount = task.lead_count || count || 20;

    // 1. Find businesses with a website — either the direct link(s) given in the instruction,
    // or (the normal case) a Google Places search by city + business type.
    let candidates, stats;
    if (directUrls?.length) {
      console.log(`[Scheduler] Email params → ${directUrls.length} direct URL(s), skipping Places search`);
      candidates = directUrls.map(url => ({ hotel_name: url, website: url, city: city || '', business_category: businessType }));
      stats = { rawFromGoogle: candidates.length, noWebsite: 0, withWebsite: candidates.length };
    } else {
      console.log(`[Scheduler] Email params → businessType="${businessType}" city="${city}" count=${leadCount}`);
      ({ candidates, stats } = await scrapePlacesForWebsites(city, leadCount, businessType));
    }

    // 2. Scrape each site for a contact email (bounded concurrency, same as bulk-domains route)
    const emailResults = await mapWithConcurrency(candidates, 4, async (c) => {
      try {
        const { email, ownerName, phone } = await findEmail({ website: c.website, hotel_name: c.hotel_name });
        return { ...c, email, ownerName, phone };
      } catch (err) {
        return { ...c, email: null, ownerName: null, phone: null };
      }
    });
    const withEmail = emailResults.filter(r => r.email);

    if (withEmail.length === 0) {
      const failMsg = directUrls?.length
        ? `No emails found — scraped ${directUrls.length} site(s) directly but none had a reachable contact email (mailto link or plain-text address in the static HTML — JS-rendered contact info can't be seen).`
        : `No emails found — Google returned ${stats.rawFromGoogle} results but ${stats.noWebsite} had no website, and none of the rest had a scrapeable contact email`;
      await pool.query(
        `UPDATE agent_tasks SET status='done', completed_at=NOW(), leads_scraped=$1, emails_found=0,
         emails_verified=0, leads_enrolled=0,
         error_message=$2 WHERE id=$3`,
        [stats.rawFromGoogle, failMsg, taskId]
      );
      return;
    }

    // 3. Store — LeadService.addLeads verifies each email and dedupes by email address
    const toInsert = withEmail.map(r => ({
      hotel_name: r.ownerName || r.hotel_name,
      owner_name: r.ownerName || '',
      email: r.email,
      phone: r.phone || '',
      website: r.website,
      city: r.city,
      source: 'agent',
      business_category: r.business_category,
      channel: 'email',
      email_source: 'agent',
    }));
    const insertResult = await LeadService.addLeads(toInsert);
    const verifiedIds = insertResult.inserted.filter(l => l.email_status === 'verified').map(l => l.id);

    // 4. Group (for the task's "view leads" panel) + auto-enroll verified leads into the sequence
    const allSavedIds = insertResult.inserted.map(l => l.id);
    const groupId = await upsertCityGroup(city || 'Direct Links', businessType, allSavedIds);

    let enrolled = 0;
    if (verifiedIds.length > 0) {
      const enrollResult = await SequenceService.enrollLeads(task.sequence_id, verifiedIds);
      enrolled = enrollResult.enrolled || 0;
    }

    await pool.query(
      `UPDATE agent_tasks SET status='done', completed_at=NOW(),
       leads_scraped=$1, emails_found=$2, leads_saved=$3, emails_verified=$4, leads_enrolled=$5, group_id=$6
       WHERE id=$7`,
      [stats.rawFromGoogle, withEmail.length, insertResult.added, verifiedIds.length, enrolled, groupId, taskId]
    );

    console.log(`[Scheduler] Email task ${taskId} done — found:${withEmail.length} saved:${insertResult.added} verified:${verifiedIds.length} enrolled:${enrolled}`);

  } catch (err) {
    console.error(`[Scheduler] Email task ${taskId} failed:`, err.message);
    await pool.query(
      `UPDATE agent_tasks SET status='failed', completed_at=NOW(), error_message=$1 WHERE id=$2`,
      [err.message, taskId]
    );
  }
}

// Phase 2: send WhatsApp messages to leads in the task's campaign group.
// Called by admin after reviewing the lead list.
async function sendTask(taskId) {
  const taskResult = await pool.query(`SELECT * FROM agent_tasks WHERE id=$1`, [taskId]);
  const task = taskResult.rows[0];
  if (!task) throw new Error('Task not found');
  if (task.status !== 'preview' && task.status !== 'scheduled_send') throw new Error('Task is not in preview state');

  await pool.query(`UPDATE agent_tasks SET status='running' WHERE id=$1`, [taskId]);

  try {
    const campResult = await pool.query(`SELECT * FROM campaigns WHERE id=$1`, [task.campaign_id]);
    const campaign = campResult.rows[0];
    if (!campaign) throw new Error('Campaign not found');
    if (!campaign.group_id) throw new Error('Campaign has no lead group');

    const template = await getApprovedTemplate(campaign.template_id || task.template_id);
    if (!template) throw new Error('No approved WhatsApp template available');

    const leadsResult = await pool.query(
      `SELECT hl.* FROM hotel_leads hl
       JOIN lead_group_members lgm ON lgm.lead_id = hl.id
       WHERE lgm.group_id = $1`,
      [campaign.group_id]
    );
    const leads = leadsResult.rows;
    console.log(`[Scheduler] sendTask ${taskId} — sending to ${leads.length} leads`);

    let sent = 0;
    for (const lead of leads) {
      const wabaResult = await WABAService.sendPersonalizedTemplate(lead, template);
      if (wabaResult.success) {
        await LeadService.logOutreach(lead.id, campaign.id, template.id, wabaResult.messageId);
        sent++;
      }
    }

    await pool.query(
      `UPDATE campaigns SET status='active', total_leads=$1, template_id=$2 WHERE id=$3`,
      [leads.length, template.id, campaign.id]
    );
    await pool.query(
      `UPDATE agent_tasks SET status='done', completed_at=NOW(), messages_sent=$1 WHERE id=$2`,
      [sent, taskId]
    );

    console.log(`[Scheduler] Task ${taskId} done — sent:${sent}`);
    return sent;

  } catch (err) {
    console.error(`[Scheduler] sendTask ${taskId} failed:`, err.message);
    await pool.query(
      `UPDATE agent_tasks SET status='failed', completed_at=NOW(), error_message=$1 WHERE id=$2`,
      [err.message, taskId]
    );
    throw err;
  }
}

// Follow up with leads that haven't responded, and re-engage stalled conversations.
// Runs daily: sends follow-up every 2 days, up to 6 template touches total.
// 'new' leads (never replied) → 'dead' after the cap.
// 'responded' leads (replied, then went quiet) → 'stalled' after the cap.
async function runFollowUps(trigger = 'cron') {
  console.log(`[FollowUp] Checking leads for follow-up... (trigger=${trigger})`);

  const stats = { due: 0, sent: 0, expired: 0, failed: 0, noTemplate: 0 };

  try {
    // Leads that:
    // - status 'new' (never replied) or 'responded' (conversation went quiet)
    // - have at least 1 prior outreach
    // - nothing sent to them in the last 2 days
    // Cap counts template sends only — agent conversation replies don't count.
    const result = await pool.query(`
      SELECT hl.*,
             COUNT(ol.id) FILTER (WHERE ol.message_type = 'template')::int AS template_count,
             MAX(ol.sent_at)        AS last_outreach
      FROM hotel_leads hl
      INNER JOIN outreach_logs ol ON ol.lead_id = hl.id
      WHERE hl.status IN ('new', 'responded')
        AND hl.whatsapp_number IS NOT NULL
      GROUP BY hl.id
      HAVING MAX(ol.sent_at) <= NOW() - INTERVAL '2 days'
    `);

    stats.due = result.rows.length;
    console.log(`[FollowUp] ${stats.due} lead(s) due for follow-up or expiry`);

    const template = await getApprovedTemplate(null);

    for (const lead of result.rows) {
      const outreachCount = lead.template_count;

      // 1 initial + 5 follow-ups = 6 template touches max
      if (outreachCount >= 6) {
        const finalStatus = lead.status === 'responded' ? 'stalled' : 'dead';
        await pool.query(
          `UPDATE hotel_leads SET status=$1, updated_at=NOW() WHERE id=$2`,
          [finalStatus, lead.id]
        );
        stats.expired++;
        console.log(`[FollowUp] Lead ${lead.id} "${lead.hotel_name}" → ${finalStatus} (${outreachCount} template sends, no response)`);
        continue;
      }

      if (!template) {
        stats.noTemplate++;
        console.warn('[FollowUp] No approved template — skipping follow-up sends');
        continue;
      }

      const wabaResult = await WABAService.sendPersonalizedTemplate(lead, template);
      if (wabaResult.success) {
        await LeadService.logOutreach(lead.id, null, template.id, wabaResult.messageId);
        stats.sent++;
        console.log(`[FollowUp] Lead ${lead.id} "${lead.hotel_name}" — follow-up #${outreachCount} sent`);
      } else {
        stats.failed++;
        console.warn(`[FollowUp] Lead ${lead.id} send failed: ${wabaResult.error}`);
      }
    }
  } catch (err) {
    console.error('[FollowUp] Error:', err.message);
    stats.error = err.message;
  }

  await SchedulerStatusService.recordRun('whatsapp_followups', trigger, stats);
  await notifyAdmin(
    `🕙 *WhatsApp Follow-ups ran* (${trigger === 'manual' ? 'manual trigger' : 'daily 10AM check'})\n\n` +
    `Checked: ${stats.due} lead(s) due\n` +
    `✅ Sent: ${stats.sent}\n` +
    `⚰️ Expired (6-touch cap reached): ${stats.expired}\n` +
    (stats.noTemplate ? `⚠️ Skipped — no approved template: ${stats.noTemplate}\n` : '') +
    (stats.failed ? `⚠️ Send failures: ${stats.failed}\n` : '') +
    (stats.error ? `❌ Error: ${stats.error}\n` : '')
  );

  return stats;
}

// Check every minute for pending tasks that are due
let running = false;

schedule.scheduleJob('* * * * *', async () => {
  if (running) return;
  running = true;
  try {
    const result = await pool.query(
      `SELECT * FROM agent_tasks WHERE status IN ('pending', 'scheduled_send') AND run_at <= NOW() ORDER BY run_at ASC LIMIT 1`
    );
    if (result.rows.length > 0) {
      const task = result.rows[0];
      if (task.status === 'scheduled_send') {
        await sendTask(task.id);
      } else if (task.channel === 'email') {
        await runEmailTask(task);
      } else {
        await runTask(task);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Cron error:', err.message);
  } finally {
    running = false;
  }
});

// Daily at 12:00 PM IST — follow up with non-responding leads
// (explicit tz because Render/most hosts run the container clock in UTC)
schedule.scheduleJob({ rule: '0 12 * * *', tz: 'Asia/Kolkata' }, async () => {
  await runFollowUps('cron');
});

console.log('🤖 Agent scheduler started — checks every minute for tasks, daily follow-ups at 10AM');

module.exports = {
  runTask, sendTask, parseInstruction, refineInstruction, runFollowUps,
  runEmailTask, refineEmailInstruction,
};
