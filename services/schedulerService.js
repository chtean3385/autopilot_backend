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
`).then(async () => {
  console.log('[Scheduler] agent_tasks table ready');
  // Fix 2: migrate pre-approval-gate tasks so cron doesn't run them without user review
  await pool.query(`UPDATE agent_tasks SET status='needs_approval' WHERE status='pending' AND parsed_params IS NULL`);
}).catch(err => console.error('[Scheduler] Table init error:', err.message));

// Refine the user's instruction using GPT.
// Returns { refinedInstruction, refinementNote, parsed, canRun }
// canRun=false only if the city is completely missing and unfixable.
async function refineInstruction(instruction) {
  try {
    const res = await openai.chat.completions.create({
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
    });
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
// Fetches aggressively (up to 60 results — Google's max) to ensure we hit the requested count
// after filtering out landlines. Returns as many valid mobile leads as found (ideally >= count).
async function scrapeLeads(city, count, businessType = 'businesses', filterHasWebsite = false, maxReviews = null) {
  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!googleKey) throw new Error('GOOGLE_PLACES_API_KEY not set');

  const searchQuery = `${businessType} in ${city}`;
  // Always fetch the maximum Google allows (60) so we have headroom after landline filtering
  const fetchTarget = Math.max(count * 2, 40);

  console.log(`[Scraper] Searching: "${searchQuery}" (want ${count}, fetching up to ${fetchTarget})`);

  const allResults = [];
  let pageToken = null;

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

    if (pageToken && allResults.length < fetchTarget) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } while (pageToken && allResults.length < fetchTarget);

  const rawResults = allResults.slice(0, fetchTarget);
  console.log(`[Scraper] Fetched ${rawResults.length} raw results from Google`);

  // Fix 4: chunk Detail calls to stay within Google's ~10 QPS rate limit
  const CHUNK_SIZE = 10;
  const detailed = [];
  for (let ci = 0; ci < rawResults.length; ci += CHUNK_SIZE) {
    const chunk = rawResults.slice(ci, ci + CHUNK_SIZE);
    const chunkResults = await Promise.allSettled(
      chunk.map(r =>
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
    detailed.push(...chunkResults);
    if (ci + CHUNK_SIZE < rawResults.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

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

    if (filterHasWebsite && detail.website) {
      console.log(`[Scraper] Skipping "${r.name}" — already has website: ${detail.website}`);
      continue;
    }

    if (maxReviews !== null && (r.user_ratings_total || 0) >= maxReviews) {
      console.log(`[Scraper] Skipping "${r.name}" — too many reviews: ${r.user_ratings_total}`);
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

  console.log(`[Scraper] ${leads.length} valid mobile leads found (requested: ${count})`);
  return leads.slice(0, count);
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
    const scraped = await scrapeLeads(city, leadCount, businessType, filterHasWebsite, maxReviews);
    console.log(`[Scheduler] Scraped ${scraped.length} leads for ${businessType} in ${city}`);

    // 3. Save new leads (deduplicated) — returns saved lead IDs
    const savedIds = await saveLeads(scraped);
    const saved = savedIds.length;
    console.log(`[Scheduler] Saved ${saved} new leads`);

    if (saved === 0) {
      await pool.query(
        `UPDATE agent_tasks SET status='done', completed_at=NOW(), leads_scraped=$1, leads_saved=0,
         messages_sent=0, error_message=$2 WHERE id=$3`,
        [scraped.length, 'No new leads found (all duplicates or filtered)', taskId]
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
    await pool.query(
      `UPDATE agent_tasks SET status='preview', leads_scraped=$1, leads_saved=$2, campaign_id=$3 WHERE id=$4`,
      [scraped.length, saved, campaign.id, taskId]
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
        continue;
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
      `SELECT * FROM agent_tasks WHERE status IN ('pending', 'scheduled_send') AND run_at <= NOW() ORDER BY run_at ASC LIMIT 1`
    );
    if (result.rows.length > 0) {
      const task = result.rows[0];
      if (task.status === 'scheduled_send') {
        await sendTask(task.id);
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

// Daily at 10:00 AM — follow up with non-responding leads
schedule.scheduleJob('0 10 * * *', async () => {
  await runFollowUps();
});

console.log('🤖 Agent scheduler started — checks every minute for tasks, daily follow-ups at 10AM');

module.exports = { runTask, sendTask, parseInstruction, refineInstruction, runFollowUps };
