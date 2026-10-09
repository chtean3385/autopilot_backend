// End-to-end test for "Indian Business Pages" (ibphub.com) association directories such as
// vatvaassociation.org: the homepage links to /directory, which is an empty {{result_link}} shell the
// browser fills from POST /xhr/get-clients.php (15 per page). The crawler must spot the shell, read
// the JSON feed page by page until a short page, and save every member with its detail-page URL.
// Fake site on 127.0.0.1. No AI, no sends.
// Run: node scripts/test_directory_ibp_feed.js (needs scripts/setup_overnight_db.js's autoagent_overnight DB).
const path = require('path');
const B = path.join(__dirname, '..') + '/';
require(B + 'node_modules/dotenv').config({ path: B + '.env' });
process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/[^/]+$/, '/autoagent_overnight');
process.env.OUTBOUND_DRY_RUN = 'true';

const aiUsage = require(B + 'utils/aiUsage');
aiUsage.trackedCompletion = async () => { const e = new Error('Incorrect API key provided (test stub)'); e.status = 401; throw e; };

const express = require(B + 'node_modules/express');
const pool = require(B + 'config/db');
const Crawler = require(B + 'services/directoryCrawlerService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const setSetting = (k, v) => pool.query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [k, String(v)]);

const run = Date.now() % 100000;
const TOTAL = 34; // → feed pages of 15, 15, 4
const members = Array.from({ length: TOTAL }, (_, i) => ({
  sCompanyName: `IBP Member ${run} ${String(i).padStart(2, '0')}`,
  sPerson1: `Person ${i}`, sPerson2: i === 0 ? 'Second Person' : null,
  sMobile: `98${String(run).padStart(5, '0')}${String(i).padStart(3, '0')}`, sMobile2: '', sPhone1: '079-12345678',
  sEmail: i % 2 ? `m${i}.${run}@example.org` : '', sEmail2: '',
  sWebsite: i === 0 ? 'www.member-zero.in' : null,
  sAddress: `Plot ${i}, Phase-2, GIDC, Vatva`, sCityName: 'Ahmedabad', sStateName: 'Gujarat', sPincode: '382445',
  sCategoryStr: 'Chemicals', sSubCategoryStr: 'Pigment Powders', sProductStr: 'Pigments',
}));
const feedCalls = [];

function startSite() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const base = () => `http://127.0.0.1:${app.port}`;
  app.get('/robots.txt', (req, res) => res.status(404).send('Not Found'));
  app.get('/sitemap.xml', (req, res) => res.status(404).send('Not Found'));
  app.get('/', (req, res) => res.send('<html><body><a href="/directory">VIA Directory</a><a href="/contact">Contact</a></body></html>'));
  app.get('/directory', (req, res) => res.send(`<html><body><div id="clients_div"></div>
    <script id="client_html" type="text/template"><a href="{{result_link}}">{{title}}</a></script>
    <script src="/js/leading-client.js?v=12"></script></body></html>`));
  app.post('/xhr/get-clients.php', (req, res) => {
    const page = parseInt(req.body.page, 10) || 1;
    feedCalls.push({ page, keyword: req.body.keyword });
    const data = members.slice((page - 1) * 15, page * 15)
      .map((m, i) => ({ ...m, result_link: `${base()}/ibp-member-${(page - 1) * 15 + i}` }));
    res.type('text/html').send(JSON.stringify({ data })); // the real site answers text/html too
  });
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => { app.port = s.address().port; resolve(s); }); });
}

(async () => {
  const server = await startSite();
  await setSetting('DIRECTORY_CRAWL_DELAY_MS', 1);
  const { rows: [src] } = await pool.query(
    `INSERT INTO directory_sources (url, name, city, status) VALUES ($1, 'Fake IBP directory', 'Ahmedabad', 'approved') RETURNING id`,
    [`http://127.0.0.1:${server.address().port}/`]
  );

  // Turn 1: homepage → /directory queued. Turn 2: shell → all 3 feed pages in the same turn.
  const first = await Crawler.crawlSource(src.id, { maxPages: 20 });
  check(first.pages === 1 && first.linksQueued === 1, 'turn 1: homepage leads to /directory', JSON.stringify(first));
  const stats = await Crawler.crawlSource(src.id, { maxPages: 20 });
  check(stats.ibp_shell === 1, 'directory shell recognised', JSON.stringify(stats));
  check(stats.ibp_feed === 3, 'whole feed read in one turn, until the short page', `feed pages=${stats.ibp_feed}`);
  check(feedCalls.every((c) => c.keyword === ''), 'feed asked for the whole list (empty keyword)');
  check(stats.pendingLeft === 0, 'nothing left in the queue');

  const { rows } = await pool.query(`SELECT * FROM directory_entries WHERE source_id=$1 ORDER BY company`, [src.id]);
  check(rows.length === TOTAL, 'every member saved', `${rows.length}/${TOTAL}`);
  const zero = rows[0];
  check(zero.contact_person === 'Person 0' && zero.phone_e164 === `91${members[0].sMobile}`, 'contact person + mobile', `${zero.contact_person} ${zero.phone_e164}`);
  check(zero.website === 'https://www.member-zero.in' && zero.category === 'Pigment Powders', 'website + category', `${zero.website} ${zero.category}`);
  check(zero.address === 'Plot 0, Phase-2, GIDC, Vatva, Ahmedabad, Gujarat, 382445', 'address joined', zero.address);
  check(/\/ibp-member-0$/.test(zero.page_url), 'page_url is the member\'s own page', zero.page_url);
  const capped = await (async () => {
    const { rows: [s2] } = await pool.query(
      `INSERT INTO directory_sources (url, name, city, status) VALUES ($1, 'Fake IBP capped', 'Ahmedabad', 'approved') RETURNING id`,
      [`http://127.0.0.1:${server.address().port}/directory`]
    );
    return Crawler.crawlSource(s2.id, { maxPages: 2 });
  })();
  check(capped.pages === 2 && capped.pendingLeft === 1, 'per-turn page limit still holds', JSON.stringify(capped));
  check(rows[1].email === `m1.${run}@example.org`, 'email saved', rows[1].email);

  await pool.query(`DELETE FROM settings WHERE key = 'DIRECTORY_CRAWL_DELAY_MS'`);
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
