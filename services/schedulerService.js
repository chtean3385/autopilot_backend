const axios = require('axios');
const schedule = require('node-schedule');
const OpenAI = require('openai');
const pool = require('../config/db');
const WABAService = require('./wabaService');
const LeadService = require('./leadService');

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
`).then(() => console.log('[Scheduler] agent_tasks table ready'))
  .catch(err => console.error('[Scheduler] Table init error:', err.message));

// Parse natural language instruction → { city, count, businessType }
async function parseInstruction(instruction) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      messages: [
        {
          role: 'system',
          content: 'Extract the business type, target city, and number of leads from the instruction. Reply with JSON only: {"businessType": "restaurants", "city": "CityName", "count": 20}. Use the exact number mentioned — do NOT default to 20 if a number is given. businessType should be the plural category of business (e.g. "hotels", "restaurants", "gyms", "salons", "pharmacies"). If not clear, use "businesses".'
        },
        { role: 'user', content: instruction }
      ],
      response_format: { type: 'json_object' },
    });
    return JSON.parse(res.choices[0].message.content);
  } catch {
    // Fallback: simple regex parse
    const countMatch = instruction.match(/\b(\d+)\b/);
    const count = countMatch ? parseInt(countMatch[1]) : 20;
    const words = instruction.split(/\s+/);
    const inIdx = words.findIndex(w => w.toLowerCase() === 'in');
    const city = inIdx !== -1 ? words[inIdx + 1]?.replace(/[^a-zA-Z]/g, '') : 'Delhi';
    return { city, count, businessType: 'businesses' };
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

// Scrape any business type from Google Places — paginates to reach requested count
async function scrapeLeads(city, count, businessType = 'businesses') {
  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!googleKey) throw new Error('GOOGLE_PLACES_API_KEY not set');

  const searchQuery = `${businessType} in ${city}`;
  console.log(`[Scraper] Searching: "${searchQuery}"`);

  const allResults = [];
  let pageToken = null;

  // Google Places Text Search returns 20/page max — paginate to reach count
  do {
    const params = { query: searchQuery, key: googleKey, language: 'en', region: 'in' };
    if (pageToken) params.pagetoken = pageToken;

    const searchResp = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      { params }
    );

    const results = searchResp.data.results || [];
    allResults.push(...results);
    pageToken = searchResp.data.next_page_token || null;

    // Google requires a 2s delay before next_page_token becomes valid
    if (pageToken && allResults.length < count) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } while (pageToken && allResults.length < count);

  const rawResults = allResults.slice(0, count);

  const detailed = await Promise.allSettled(
    rawResults.map(r =>
      axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
        params: {
          place_id: r.place_id,
          fields: 'name,formatted_phone_number,international_phone_number,website',
          key: googleKey,
          language: 'en'
        }
      })
    )
  );

  const extractCity = (address, fallback) => {
    if (!address) return fallback || '';
    const parts = address.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!/\d{4,}/.test(parts[i]) && parts[i].length > 2) return parts[i];
    }
    return fallback || '';
  };

  const leads = [];
  for (let i = 0; i < rawResults.length; i++) {
    const r = rawResults[i];
    const detail = detailed[i].status === 'fulfilled' ? detailed[i].value.data.result : {};
    const rawPhone = detail.international_phone_number || detail.formatted_phone_number || '';
    const mobile = normalizeMobileNumber(rawPhone);

    if (!mobile) {
      console.log(`[Scraper] Skipping "${r.name}" — not a mobile number: ${rawPhone}`);
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

  return leads;
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

  await pool.query(
    `UPDATE agent_tasks SET status='running', started_at=NOW() WHERE id=$1`,
    [taskId]
  );

  try {
    console.log(`[Scheduler] Task ${taskId}: "${task.instruction}"`);

    // 1. Parse business type, city, count from instruction
    const { city, count, businessType = 'businesses' } = await parseInstruction(task.instruction);
    const leadCount = task.lead_count || count || 50;

    console.log(`[Scheduler] Parsed → businessType="${businessType}" city="${city}", count=${leadCount}`);

    // 2. Scrape Google Places for the given business type
    const scraped = await scrapeLeads(city, leadCount, businessType);
    console.log(`[Scheduler] Scraped ${scraped.length} leads for ${businessType} in ${city}`);

    // 3. Save new leads (deduplicated) — returns saved lead IDs
    const savedIds = await saveLeads(scraped);
    const saved = savedIds.length;
    console.log(`[Scheduler] Saved ${saved} new leads`);

    // 3b. Auto-create/update business+city group
    await upsertCityGroup(city, businessType, savedIds);

    // 4. Get approved template
    const template = await getApprovedTemplate(task.template_id);

    if (!template || saved === 0) {
      const reason = !template ? 'No approved template found' : 'No new leads to contact';
      await pool.query(
        `UPDATE agent_tasks SET status='done', completed_at=NOW(), leads_scraped=$1, leads_saved=$2,
         messages_sent=0, error_message=$3 WHERE id=$4`,
        [scraped.length, saved, reason, taskId]
      );
      return;
    }

    // 5. Create campaign
    const campaignName = `Agent: ${businessType} in ${city} – ${new Date().toLocaleDateString('en-IN')}`;
    const campResult = await pool.query(
      `INSERT INTO campaigns (campaign_name, template_id, target_city, target_type, status, created_by)
       VALUES ($1, $2, $3, 'city', 'draft', 'agent') RETURNING *`,
      [campaignName, template.id, city]
    );
    const campaign = campResult.rows[0];

    // 6. Send initial message to all newly saved leads only
    const leadsResult = await pool.query(
      `SELECT * FROM hotel_leads WHERE id = ANY($1::int[])`,
      [savedIds]
    );
    const leads = leadsResult.rows;

    let sent = 0;
    for (const lead of leads) {
      const wabaResult = await WABAService.sendPersonalizedTemplate(lead, template);
      if (wabaResult.success) {
        await LeadService.logOutreach(lead.id, campaign.id, template.id, wabaResult.messageId);
        sent++;
      }
    }

    await pool.query(
      `UPDATE campaigns SET status='active', total_leads=$1 WHERE id=$2`,
      [leads.length, campaign.id]
    );

    await pool.query(
      `UPDATE agent_tasks SET status='done', completed_at=NOW(),
       leads_scraped=$1, leads_saved=$2, messages_sent=$3, campaign_id=$4
       WHERE id=$5`,
      [scraped.length, saved, sent, campaign.id, taskId]
    );

    console.log(`[Scheduler] Task ${taskId} done — scraped:${scraped.length} saved:${saved} sent:${sent}`);

  } catch (err) {
    console.error(`[Scheduler] Task ${taskId} failed:`, err.message);
    await pool.query(
      `UPDATE agent_tasks SET status='failed', completed_at=NOW(), error_message=$1 WHERE id=$2`,
      [err.message, taskId]
    );
  }
}

// Follow up with leads that haven't responded.
// Runs daily: sends follow-up every 2 days, up to 5 follow-ups (10 days total).
// After 5 follow-ups with no response → mark as 'dead'.
async function runFollowUps() {
  console.log('[FollowUp] Checking leads for follow-up...');

  try {
    // Leads that:
    // - status = 'new' (no response yet, not opted out, not dead)
    // - have at least 1 prior outreach
    // - last outreach was >= 2 days ago
    const result = await pool.query(`
      SELECT hl.*,
             COUNT(ol.id)::int      AS outreach_count,
             MAX(ol.sent_at)        AS last_outreach
      FROM hotel_leads hl
      INNER JOIN outreach_logs ol ON ol.lead_id = hl.id
      WHERE hl.status = 'new'
        AND hl.whatsapp_number IS NOT NULL
      GROUP BY hl.id
      HAVING MAX(ol.sent_at) <= NOW() - INTERVAL '2 days'
    `);

    console.log(`[FollowUp] ${result.rows.length} lead(s) due for follow-up or expiry`);

    const template = await getApprovedTemplate(null);

    for (const lead of result.rows) {
      const outreachCount = lead.outreach_count;

      // 1 initial + 5 follow-ups = 6 total contacts over 10 days
      if (outreachCount >= 6) {
        await pool.query(
          `UPDATE hotel_leads SET status='dead', updated_at=NOW() WHERE id=$1`,
          [lead.id]
        );
        console.log(`[FollowUp] Lead ${lead.id} "${lead.hotel_name}" → dead (${outreachCount} contacts, no response)`);
        continue;
      }

      if (!template) {
        console.warn('[FollowUp] No approved template — skipping follow-up sends');
        break;
      }

      const wabaResult = await WABAService.sendPersonalizedTemplate(lead, template);
      if (wabaResult.success) {
        await LeadService.logOutreach(lead.id, null, template.id, wabaResult.messageId);
        console.log(`[FollowUp] Lead ${lead.id} "${lead.hotel_name}" — follow-up #${outreachCount} sent`);
      } else {
        console.warn(`[FollowUp] Lead ${lead.id} send failed: ${wabaResult.error}`);
      }
    }
  } catch (err) {
    console.error('[FollowUp] Error:', err.message);
  }
}

// Check every minute for pending tasks that are due
let running = false;

schedule.scheduleJob('* * * * *', async () => {
  if (running) return;
  running = true;
  try {
    const result = await pool.query(
      `SELECT * FROM agent_tasks WHERE status='pending' AND run_at <= NOW() ORDER BY run_at ASC LIMIT 1`
    );
    if (result.rows.length > 0) {
      await runTask(result.rows[0]);
    }
  } catch (err) {
    console.error('[Scheduler] Cron error:', err.message);
  } finally {
    running = false;
  }
});

// Daily at 10:00 AM — follow up with non-responding leads
schedule.scheduleJob('0 10 * * *', async () => {
  await runFollowUps();
});

console.log('🤖 Agent scheduler started — checks every minute for tasks, daily follow-ups at 10AM');

module.exports = { runTask, parseInstruction, runFollowUps };
