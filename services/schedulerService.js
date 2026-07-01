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

// Parse natural language instruction → { city, count }
async function parseInstruction(instruction) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 100,
      messages: [
        {
          role: 'system',
          content: 'Extract the target city and number of leads from the instruction. Reply with JSON only: {"city": "CityName", "count": 20}. Default count to 20 if not mentioned.'
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
    return { city, count };
  }
}

// Scrape hotels from Google Places
async function scrapeLeads(city, count) {
  const googleKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!googleKey) throw new Error('GOOGLE_PLACES_API_KEY not set');

  const textQuery = `hotels in ${city}`;
  const searchResp = await axios.get(
    'https://maps.googleapis.com/maps/api/place/textsearch/json',
    { params: { query: textQuery, key: googleKey, language: 'en', region: 'in' } }
  );

  const rawResults = (searchResp.data.results || []).slice(0, count);

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

  return rawResults.map((r, i) => {
    const detail = detailed[i].status === 'fulfilled' ? detailed[i].value.data.result : {};
    const phone = detail.international_phone_number || detail.formatted_phone_number || '';
    return {
      hotel_name: r.name || '',
      owner_name: r.name || '',
      email: detail.website || '',
      whatsapp_number: phone.replace(/\D/g, ''),
      phone,
      city: extractCity(r.formatted_address, city),
      address: r.formatted_address || '',
      source: 'agent',
    };
  }).filter(p => p.whatsapp_number);
}

// Save leads, skip duplicates by whatsapp_number
async function saveLeads(leads) {
  let saved = 0;
  for (const lead of leads) {
    try {
      const existing = await pool.query(
        'SELECT id FROM hotel_leads WHERE whatsapp_number = $1 OR (hotel_name ILIKE $2 AND city ILIKE $3)',
        [lead.whatsapp_number, lead.hotel_name, lead.city]
      );
      if (existing.rows.length > 0) continue;

      await pool.query(
        `INSERT INTO hotel_leads (hotel_name, owner_name, email, whatsapp_number, city, phone, source, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'new')`,
        [lead.hotel_name, lead.owner_name, lead.email, lead.whatsapp_number, lead.city, lead.phone, lead.source]
      );
      saved++;
    } catch { /* skip on error */ }
  }
  return saved;
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

    // 1. Parse city + count from instruction
    const { city, count } = await parseInstruction(task.instruction);
    const leadCount = task.lead_count || count || 20;

    console.log(`[Scheduler] Parsed → city="${city}", count=${leadCount}`);

    // 2. Scrape Google Places
    const scraped = await scrapeLeads(city, leadCount);
    console.log(`[Scheduler] Scraped ${scraped.length} leads for ${city}`);

    // 3. Save new leads (deduplicated)
    const saved = await saveLeads(scraped);
    console.log(`[Scheduler] Saved ${saved} new leads`);

    // 4. Get approved template
    let template = null;
    if (task.template_id) {
      const t = await pool.query('SELECT * FROM waba_templates WHERE id=$1 AND status=$2', [task.template_id, 'approved']);
      template = t.rows[0] || null;
    }
    if (!template) {
      const t = await pool.query("SELECT * FROM waba_templates WHERE status='approved' ORDER BY created_at DESC LIMIT 1");
      template = t.rows[0] || null;
    }

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
    const campaignName = `Agent: ${city} – ${new Date().toLocaleDateString('en-IN')}`;
    const campResult = await pool.query(
      `INSERT INTO campaigns (campaign_name, template_id, target_city, target_type, status, created_by)
       VALUES ($1, $2, $3, 'city', 'draft', 'agent') RETURNING *`,
      [campaignName, template.id, city]
    );
    const campaign = campResult.rows[0];

    // 6. Launch — send to all new leads in this city
    const leadsResult = await pool.query(
      `SELECT * FROM hotel_leads WHERE LOWER(city) = LOWER($1) AND status = 'new'`,
      [city]
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

console.log('🤖 Agent scheduler started — checks every minute for pending tasks');

module.exports = { runTask, parseInstruction };
