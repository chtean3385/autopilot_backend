// Directory crawl pacing: a site that answers 500 must be cooled down (not hammered), its pages put
// back in the queue, "Crawl now" refused during the cool-down, and the live queue must show it.
// Runs against the throwaway test DB only (scripts/setup_overnight_db.js), with a local fake site.
//   node scripts/test_directory_pacing.js
require('dotenv').config();
const http = require('http');
const dev = new URL(process.env.DATABASE_URL);
dev.pathname = `/${process.env.TEST_DB_NAME || 'autoagent_overnight'}`;
process.env.DATABASE_URL = dev.toString();
process.env.DIRECTORY_CRAWL_DELAY_MS = '20';
process.env.DIRECTORY_BLOCK_FAILS = '5';
const pool = require('../config/db');
const Directory = require('../services/directoryCrawlerService');
const { getQueue } = require('../services/directoryQueueService');

let hits = 0;
const PORT = 5099;
const server = http.createServer((req, res) => {
  if (req.url === '/robots.txt') return res.end(`User-agent: *\nSitemap: http://localhost:${PORT}/sitemap.xml\n`);
  if (req.url === '/sitemap.xml') {
    const urls = Array.from({ length: 12 }, (_, i) => `<url><loc>http://localhost:${PORT}/member-${i}</loc></url>`).join('');
    return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  }
  hits++;
  res.statusCode = 500;
  res.end('');
});

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const url = `http://localhost:${PORT}/`;
  await pool.query(`DELETE FROM directory_sources WHERE url = $1`, [url]);
  const { rows: [src] } = await pool.query(
    `INSERT INTO directory_sources (url, name, status) VALUES ($1, 'Fake blocking site', 'approved') RETURNING id`, [url]);

  const stats = await Directory.crawlSource(src.id, { maxPages: 12 });
  check(stats.blockedBySite === true, `crawl stops when the site refuses (stats: ${JSON.stringify(stats)})`);
  check(stats.pages === 5, `stopped after 5 failed pages, not all 12 (tried ${stats.pages})`);
  const pagesHit = hits;

  const { rows: [after] } = await pool.query(`SELECT * FROM directory_sources WHERE id = $1`, [src.id]);
  check(after.block_count === 1, `block_count = 1 (got ${after.block_count})`);
  const hoursLeft = (new Date(after.cooldown_until) - Date.now()) / 3600000;
  check(hoursLeft > 5.9 && hoursLeft <= 6.01, `cooled down ~6 h (got ${hoursLeft.toFixed(2)} h)`);
  const { rows: [pg] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM directory_crawl_pages WHERE source_id = $1`, [src.id]);
  check(pg.pending === stats.queued && pg.failed === 0, `the 5 failed pages went back in the queue (pending ${pg.pending}, failed ${pg.failed})`);

  const again = await Directory.crawlSource(src.id, { maxPages: 12 });
  check(again.skipped && again.cooldownUntil, '"Crawl now" during the cool-down is refused');
  check(hits === pagesHit, `no request reached the site during the cool-down (${hits - pagesHit} extra)`);

  const { rows: picked } = await pool.query(
    `SELECT id FROM directory_sources WHERE status IN ('approved','crawling')
       AND (cooldown_until IS NULL OR cooldown_until <= NOW()) AND id = $1`, [src.id]);
  check(picked.length === 0, 'the 10-minute worker skips a cooling site');

  const q = await getQueue();
  const row = q.queue.find((x) => x.id === src.id);
  check(row?.state === 'cooling', `live queue shows it as cooling (state ${row?.state})`);
  check(row?.nextCrawlAt && Date.parse(row.nextCrawlAt) >= Date.parse(after.cooldown_until) - 1000,
    'live queue schedules its next crawl after the cool-down');

  await pool.query(`DELETE FROM directory_sources WHERE id = $1`, [src.id]);
  server.close();
  await pool.end();
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
