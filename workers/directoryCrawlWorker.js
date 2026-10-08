const schedule = require('node-schedule');
const pool = require('../config/db');
const { crawlSource } = require('../services/directoryCrawlerService');
const { promoteEntries, backfillWebsiteEmails } = require('../services/directoryPromotionService');
const { refreshScores } = require('../services/leadScoreService');

// Directory outreach steps 1+2 — every 10 min: promotes a batch of crawled entries to leads (no AI
// needed, contacts nobody), retries the website email lookup for leads still missing an email,
// refreshes every lead's completeness score, then crawls the next batch of pages (DIRECTORY_PAGES_PER_TICK)
// of ONE approved source, least-recently-crawled first, so several sources share time fairly.
// Catch-up safe: the page queue lives in directory_crawl_pages, so missed ticks just mean the
// crawl finishes later. Only sources the owner approved are ever touched.
let isRunning = false;

async function runDirectoryCrawlTick() {
  if (isRunning) return { skipped: true };
  isRunning = true;
  try {
    const promoted = await promoteEntries();
    const backfill = await backfillWebsiteEmails();
    // Catches score changes made elsewhere (e.g. emailVerificationWorker verifying an email).
    const rescored = await refreshScores();
    const { rows } = await pool.query(
      `SELECT id FROM directory_sources
       WHERE status IN ('approved', 'crawling')
       ORDER BY last_crawled_at ASC NULLS FIRST, id ASC
       LIMIT 1`
    );
    if (!rows[0]) return { promoted, backfill, rescored, idle: true };
    // Rule-parsable pages need no AI; pages that do are parked as needs_ai inside crawlSource.
    return { promoted, backfill, rescored, crawl: await crawlSource(rows[0].id) };
  } catch (err) {
    console.error('[DirectoryCrawler] tick failed:', err.message);
    return { error: err.message };
  } finally {
    isRunning = false;
  }
}

schedule.scheduleJob('*/10 * * * *', () => { runDirectoryCrawlTick(); });
console.log('📚 Directory crawl worker started - crawls approved directory sources every 10 minutes');

module.exports = { runDirectoryCrawlTick };
