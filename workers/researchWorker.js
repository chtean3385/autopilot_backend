const schedule = require('node-schedule');
const pool = require('../config/db');
const { getOrCreateResearch, RESEARCH_MAX_ATTEMPTS } = require('../services/leadResearchService');

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
      `SELECT DISTINCT ON (hl.id) hl.id, hl.hotel_name, hl.owner_name, hl.city, hl.business_category, hl.website
       FROM lead_sequences ls
       JOIN hotel_leads hl ON hl.id = ls.lead_id
       LEFT JOIN lead_research lr ON lr.lead_id = hl.id
       WHERE ls.status = 'active'
         AND hl.website IS NOT NULL AND hl.website <> ''
         AND lr.lead_id IS NULL
         AND COALESCE(hl.research_attempts, 0) < $1
         AND (hl.last_research_attempt_at IS NULL OR hl.last_research_attempt_at < NOW() - INTERVAL '${RETRY_BACKOFF_MINUTES} minutes')
       ORDER BY hl.id, hl.created_at ASC
       LIMIT $2`,
      [RESEARCH_MAX_ATTEMPTS, BATCH_LIMIT]
    );

    stats.candidates = result.rows.length;
    if (stats.candidates === 0) return stats;

    console.log(`[ResearchWorker] Researching ${stats.candidates} lead(s)...`);

    for (const lead of result.rows) {
      await pool.query(
        `UPDATE hotel_leads
         SET research_attempts = COALESCE(research_attempts, 0) + 1, last_research_attempt_at = NOW()
         WHERE id = $1`,
        [lead.id]
      );
      try {
        const { research } = await getOrCreateResearch(lead);
        if (research) stats.researched++; else stats.failed++;
      } catch (err) {
        console.error(`[ResearchWorker] Research failed for lead ${lead.id}:`, err.message);
        stats.failed++;
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

schedule.scheduleJob('*/5 * * * *', runResearchPass);

console.log('🔬 Research worker started - researches sequence-enrolled leads every 5 minutes');

module.exports = { runResearchPass };
