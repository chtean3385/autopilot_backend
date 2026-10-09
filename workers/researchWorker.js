const schedule = require('node-schedule');
const pool = require('../config/db');
const { track } = require('../utils/jobTracker');
const { getOrCreateResearch, researchSiteFor, FREE_MAIL_SQL, RESEARCH_MAX_ATTEMPTS } = require('../services/leadResearchService');
const { isAiAvailable } = require('../utils/aiUsage');

// Front-loads website research for sequence-enrolled leads, decoupled from send time.
// Previously sequenceEmailWorker.js crawled a lead's site inline the moment its first email
// came due — slow (a 12-page crawl + GPT call inside the 15-min send tick) and silent (a lead
// with no website, or a crawl that failed, just got the generic no-research prompt forever with
// nothing in the UI explaining why). Now: this worker researches every active-sequence lead with
// a website ahead of time, and sequenceEmailWorker.js's gate simply waits for the result instead
// of triggering the crawl itself.
const BATCH_LIMIT = 20;
const RETRY_BACKOFF_MINUTES = 30;
const DELAY_BETWEEN_LEADS_MS = 750;

let isRunning = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runResearchPass() {
  if (isRunning) {
    console.log('[ResearchWorker] Previous run still in progress — skipping this tick');
    return { skipped: true };
  }
  isRunning = true;

  const stats = { candidates: 0, researched: 0, failed: 0 };

  try {
    // Any lead actively enrolled in an email sequence, with a website, no lead_research row yet,
    // under the attempt cap, and past the retry backoff. Not scoped to next_run_at — the point is
    // to get research done well before a step is actually due, not just-in-time.
    const result = await pool.query(
      `SELECT DISTINCT ON (hl.id) hl.id, hl.hotel_name, hl.owner_name, hl.city, hl.business_category, hl.website, hl.email
       FROM hotel_leads hl
       LEFT JOIN lead_research lr ON lr.lead_id = hl.id
       WHERE (EXISTS (SELECT 1 FROM lead_sequences ls WHERE ls.lead_id = hl.id AND ls.status = 'active')
              -- directory leads in the email/WhatsApp cadence (services/cadenceService.js) need it too
              OR EXISTS (SELECT 1 FROM lead_cadence lc WHERE lc.lead_id = hl.id AND lc.status IN ('active', 'resting')))
         -- a website, or (none saved) email on the company's own domain → research that domain
         AND ((hl.website IS NOT NULL AND hl.website <> '')
              OR (hl.email LIKE '%@%.%' AND split_part(LOWER(hl.email), '@', 2) !~ ${FREE_MAIL_SQL}))
         AND lr.lead_id IS NULL
         AND COALESCE(hl.research_attempts, 0) < $1
         AND (hl.last_research_attempt_at IS NULL OR hl.last_research_attempt_at < NOW() - INTERVAL '${RETRY_BACKOFF_MINUTES} minutes')
       ORDER BY hl.id, hl.created_at ASC
       LIMIT $2`,
      [RESEARCH_MAX_ATTEMPTS, BATCH_LIMIT]
    );

    stats.candidates = result.rows.length;
    if (stats.candidates === 0) return stats;
    if (!isAiAvailable()) {
      console.log('[ResearchWorker] OpenAI out of credit/budget — skipping pass (no attempts used)');
      return stats;
    }

    console.log(`[ResearchWorker] Researching ${stats.candidates} lead(s)...`);

    for (const lead of result.rows) {
      await pool.query(
        `UPDATE hotel_leads
         SET research_attempts = COALESCE(research_attempts, 0) + 1, last_research_attempt_at = NOW()
         WHERE id = $1`,
        [lead.id]
      );
      try {
        const site = researchSiteFor(lead);
        const { research } = await getOrCreateResearch({ ...lead, website: site });
        if (research) {
          stats.researched++;
          // The email's domain turned out to be a real site → save it as the lead's website.
          if (!lead.website && site) {
            await pool.query(`UPDATE hotel_leads SET website = $2 WHERE id = $1 AND COALESCE(website, '') = ''`, [lead.id, site]);
          }
        } else stats.failed++;
      } catch (err) {
        console.error(`[ResearchWorker] Research failed for lead ${lead.id}:`, err.message);
        stats.failed++;
      }
      // The failure was OpenAI billing (no credit / budget cap), not this lead — give the
      // attempt back and stop the pass instead of burning every remaining lead's attempts too.
      if (!isAiAvailable()) {
        await pool.query(
          `UPDATE hotel_leads SET research_attempts = GREATEST(COALESCE(research_attempts, 1) - 1, 0) WHERE id = $1`,
          [lead.id]
        );
        console.log('[ResearchWorker] OpenAI out of credit/budget — attempt refunded, stopping pass');
        break;
      }
      await sleep(DELAY_BETWEEN_LEADS_MS);
    }

    console.log(`[ResearchWorker] Pass complete — ${stats.researched} researched, ${stats.failed} failed`);
  } catch (err) {
    console.error('[ResearchWorker] Error in research pass:', err.message);
    stats.error = err.message;
  } finally {
    isRunning = false;
  }
  return stats;
}

schedule.scheduleJob('*/5 * * * *', () => track('research', runResearchPass).catch(() => {}));

console.log('🔬 Research worker started - researches sequence-enrolled leads every 5 minutes');

module.exports = { runResearchPass };
