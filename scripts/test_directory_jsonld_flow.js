// End-to-end test for the idbf.in-style directory flow: JS cookie stub → sitemap → JSON-LD business
// pages → promotion (website email lookup, address, contact person) → website email backfill retry →
// lead completeness score/tier → leads list route (tier filter, no lead_score ambiguity) → cadence
// intake order (hot first). Fake directory on 127.0.0.1, fake business websites on localhost (a
// *.localtest.me, which resolves to this machine — a different host, so they count as the business's own site). No AI, no sends.
// Run: node scripts/test_directory_jsonld_flow.js (needs scripts/setup_overnight_db.js's autoagent_overnight DB).
const fs = require('fs');
const path = require('path');
const B = path.join(__dirname, '..') + '/';
require(B + 'node_modules/dotenv').config({ path: B + '.env' });
process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/[^/]+$/, '/autoagent_overnight');
process.env.OUTBOUND_DRY_RUN = 'true';

// No AI: crawler JSON-LD needs none; findEmail falls back to the site's mailto link.
const aiUsage = require(B + 'utils/aiUsage');
aiUsage.trackedCompletion = async () => { const e = new Error('Incorrect API key provided (test stub)'); e.status = 401; throw e; };

const express = require(B + 'node_modules/express');
const axios = require(B + 'node_modules/axios');
const pool = require(B + 'config/db');
const Crawler = require(B + 'services/directoryCrawlerService');
const Promotion = require(B + 'services/directoryPromotionService');
const { refreshScores } = require(B + 'services/leadScoreService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const setSetting = (k, v) => pool.query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [k, String(v)]);

const run = Date.now() % 100000; // unique names/numbers per run — the test DB keeps earlier runs' leads
const mob = (n) => `98${String(run).padStart(5, '0')}${String(n).padStart(3, '0')}`;
let sitePort;
let siteCDown = true;

const biz = [
  // full: mobile + website (site has email + owner) + address + category → should end up hot
  { id: 101, name: `Full Data Clinic ${run}`, tel: mob(1), site: 'a', cat: 'Doctors - Skin', addr: '12 CG Road' },
  // mobile only, no website
  { id: 102, name: `Mobile Only Kirana ${run}`, tel: mob(2), site: null, cat: 'Kirana Stores', addr: '4 Mahavir Nagar' },
  // landline + website that is down at promotion time → backfill finds the email later
  { id: 103, name: `Flaky Site Printers ${run}`, tel: '022 2647 0000', site: 'c', cat: 'Printing Presses', addr: 'Relief Road' },
];

function startDirectory() {
  const app = express();
  // JS cookie stub on every path until the cookie is sent — same as *.idbf.in
  app.use((req, res, next) => {
    if ((req.headers.cookie || '').includes('null=null')) return next();
    res.send('<!doctype html><html><head><meta charset="utf-8"></head><body><script>if (!sessionStorage.getItem("js_cookie_set")) {  document.cookie="null=null; path=/; domain=.idbf.in;";  sessionStorage.setItem("js_cookie_set", "1");  location.reload();}</script></body></html>');
  });
  app.get('/robots.txt', (req, res) => res.type('text').send('Sitemap: /city-sitemap.xml\nUser-agent: *\nAllow: /\n'));
  const base = () => `http://127.0.0.1:${app.port}`;
  app.get('/city-sitemap.xml', (req, res) => res.type('xml').send(
    `<?xml version='1.0' encoding='UTF-8'?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    [`${base()}/`, `${base()}/doctors-skin`, ...biz.map((b) => `${base()}/${b.id}/x`)].map((u) => `<url><loc>${u}</loc></url>`).join('') +
    '</urlset>'));
  app.get('/sitemap.xml', (req, res) => res.status(404).send('none'));
  app.get('/', (req, res) => res.send('<html><body><h1>City Directory</h1></body></html>'));
  app.get('/doctors-skin', (req, res) => res.send(`<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"CollectionPage","name":"Best Skin Doctors","numberOfItems":1}</script></head>
    <body><h1>Skin Doctors</h1><a href="${base()}/101/x">Full Data Clinic</a></body></html>`));
  app.get('/:id/x', (req, res) => {
    const b = biz.find((x) => String(x.id) === req.params.id);
    if (!b) return res.status(404).send('no');
    const ld = {
      '@context': 'https://schema.org', '@type': 'LocalBusiness', name: b.name,
      address: { '@type': 'PostalAddress', streetAddress: b.addr, addressLocality: 'Ahmedabad', postalCode: '380001' },
      sameAs: `${base()}/${b.id}/x`, telephone: b.tel,
      ...(b.site ? { url: `http://${b.site}.localtest.me:${sitePort}/${b.site}` } : {}),
    };
    const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Ahmedabad', item: `${base()}/` },
      { '@type': 'ListItem', position: 2, name: b.cat, item: `${base()}/cat` },
      { '@type': 'ListItem', position: 3, name: b.name },
    ] };
    res.send(`<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script>
      <script type="application/ld+json">${JSON.stringify(crumbs)}</script></head><body><h1>${b.name}</h1></body></html>`);
  });
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => { app.port = s.address().port; resolve(s); }); });
}

function startBusinessSites() {
  const app = express();
  app.get('/a', (req, res) => res.send(`<html><body><h1>Full Data Clinic</h1><p>Dr. Meera Shah</p>
    <a href="mailto:contact${run}@fulldataclinic.in">Email us</a></body></html>`));
  app.get('/c', (req, res) => (siteCDown ? res.status(503).send('down')
    : res.send(`<html><body><h1>Flaky Site Printers</h1><a href="mailto:hello${run}@flakyprinters.in">Mail</a></body></html>`)));
  app.get(/.*/, (req, res) => res.status(404).send('no'));
  return new Promise((resolve) => { const s = app.listen(0, () => { sitePort = s.address().port; resolve(s); }); });
}

const lead = async (name) => (await pool.query('SELECT * FROM hotel_leads WHERE hotel_name = $1', [name])).rows[0];

(async () => {
  await pool.query(fs.readFileSync(B + 'database/migrate_lead_scoring.sql', 'utf8'));
  await setSetting('DIRECTORY_CRAWL_DELAY_MS', 1);
  const sitesServer = await startBusinessSites();
  const dirServer = await startDirectory();
  const dirUrl = `http://127.0.0.1:${dirServer.address().port}/`;

  const src = (await pool.query(
    `INSERT INTO directory_sources (url, name, city, status) VALUES ($1, 'Fake idbf-style directory', 'Ahmedabad', 'approved') RETURNING id`,
    [dirUrl]
  )).rows[0];

  // --- crawl --------------------------------------------------------------------------------
  const stats = await Crawler.crawlSource(src.id, { maxPages: 50 });
  check(stats.queued >= 5, 'cookie stub passed: sitemap read', `queued=${stats.queued}`);
  check((stats.gpt || 0) + (stats.needsAi || 0) <= 1, "no GPT for business/listing pages (only the plain homepage)", JSON.stringify({ jsonld: stats.jsonld, gpt: stats.gpt, needsAi: stats.needsAi }));
  const entries = (await pool.query('SELECT * FROM directory_entries WHERE source_id = $1 ORDER BY id', [src.id])).rows;
  check(entries.length === 3, '3 businesses extracted (listing + home pages give none)', `got ${entries.length}`);
  const eA = entries.find((e) => e.company.startsWith('Full Data'));
  check(eA?.website === `http://a.localtest.me:${sitePort}/a`, 'website saved from JSON-LD url', eA?.website);
  check(eA?.category === 'Doctors - Skin', 'category from breadcrumb', eA?.category);
  check(/12 CG Road/.test(eA?.address || ''), 'address saved', eA?.address);
  check(eA?.phone_e164 === `91${mob(1)}`, 'mobile normalised', eA?.phone_e164);

  // --- promote ------------------------------------------------------------------------------
  const p = await Promotion.promoteEntries({ sourceId: src.id, limit: 10 });
  console.log('      promotion:', JSON.stringify(p));
  const A = await lead(biz[0].name);
  const Bl = await lead(biz[1].name);
  const C = await lead(biz[2].name);
  check(A && A.email === `contact${run}@fulldataclinic.in` && A.email_source === 'website', 'email found on the business website at promotion', A?.email);
  check(A?.address && A.business_category === 'Doctors - Skin' && A.website, 'lead keeps address, category, website');
  check(Bl && !Bl.email && Bl.whatsapp_number === `91${mob(2)}`, 'mobile-only lead promoted for WhatsApp');
  check(C && !C.email && C.email_lookup_attempts === 1 && C.phone === '022 2647 0000', 'site down → still promoted (landline kept), 1 lookup attempt recorded', `attempts=${C?.email_lookup_attempts}`);
  check(Bl?.email_lookup_attempts === 0, 'no website → no lookup attempt');

  // --- scores -------------------------------------------------------------------------------
  // A: name10 + mobile25 + email20 + website15 + category10 + address5 (+ owner10 if GPT found one; stubbed → 0) = 85
  check(A.lead_score === 85 && A.lead_tier === 'hot', 'A scored hot', `${A.lead_score}/${A.lead_tier}`);
  check(Bl.lead_score === 50 && Bl.lead_tier === 'warm', 'mobile-only scored warm (10+25+10+5)', `${Bl.lead_score}/${Bl.lead_tier}`);
  check(C.lead_score === 40 && C.lead_tier === 'cold', 'landline + website, no email scored cold (10+15+10+5)', `${C.lead_score}/${C.lead_tier}`);
  await pool.query(`UPDATE hotel_leads SET email_status = 'verified', owner_name = 'Meera Shah' WHERE id = $1`, [A.id]);
  await refreshScores();
  const A2 = await lead(biz[0].name);
  check(A2.lead_score === 100 && A2.lead_tier === 'hot', 'every field + verified email = 100 hot (sweep picks up outside changes)', String(A2.lead_score));

  // --- backfill -----------------------------------------------------------------------------
  let bf = await Promotion.backfillWebsiteEmails({ limit: 50 });
  check(!(await lead(biz[2].name)).email, 'backfill waits 24h between attempts', JSON.stringify(bf));
  siteCDown = false;
  await pool.query(`UPDATE hotel_leads SET last_email_lookup_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [C.id]);
  bf = await Promotion.backfillWebsiteEmails({ limit: 50 });
  const C2 = await lead(biz[2].name);
  check(C2.email === `hello${run}@flakyprinters.in` && C2.email_status === 'found' && C2.channel === 'email' && C2.email_source === 'website',
    'backfill found the email once the site was back up', `${C2.email} ${C2.email_status}`);
  check(C2.email_lookup_attempts === 2 && C2.lead_score === 60 && C2.lead_tier === 'warm', 'backfilled lead re-scored (now warm)', `attempts=${C2.email_lookup_attempts} score=${C2.lead_score}`);
  await pool.query(`UPDATE hotel_leads SET last_email_lookup_at = NOW() - INTERVAL '25 hours', email = '' WHERE id = $1`, [C.id]);
  await pool.query(`UPDATE hotel_leads SET email_lookup_attempts = 3 WHERE id = $1`, [C.id]);
  bf = await Promotion.backfillWebsiteEmails({ limit: 50 });
  check(!(await lead(biz[2].name)).email, 'backfill stops after 3 attempts');

  // --- leads list route ---------------------------------------------------------------------
  const app = express();
  app.use('/api/leads', require(B + 'routes/leads'));
  const api = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${api.address().port}/api/leads`;
  const all = await axios.get(url, { params: { q: String(run), pageSize: 50 } });
  check(all.status === 200 && all.data.leads.length === 3, 'GET /api/leads works (no lead_score ambiguity)', `n=${all.data.leads?.length}`);
  check(all.data.leads[0].hotel_name === biz[0].name && all.data.leads[0].lead_tier === 'hot', 'list sorted by score, tier returned');
  const hot = await axios.get(url, { params: { q: String(run), tier: 'hot' } });
  check(hot.data.leads.length === 1 && hot.data.total === 1, 'tier=hot filter', `n=${hot.data.leads.length}`);
  api.close();

  // --- cadence intake order -----------------------------------------------------------------
  const order = await pool.query(
    `SELECT hl.hotel_name FROM hotel_leads hl LEFT JOIN lead_cadence lc ON lc.lead_id = hl.id
     WHERE hl.cadence_managed AND lc.lead_id IS NULL AND hl.status = 'new' AND hl.id = ANY($1)
     ORDER BY hl.lead_score DESC, hl.id`, [[A.id, Bl.id, C.id]]
  );
  check(order.rows[0]?.hotel_name === biz[0].name, 'cadence intake starts the hot lead first');

  // --- contact rule: a business needs a phone, an email or a website to be saved ------------
  const srcObj = { url: dirUrl, city: 'Ahmedabad' };
  check(Crawler.toEntry({ company: 'Name Only Traders', phones: [], emails: [], website: null }, srcObj) === null, 'name-only business is not saved');
  check(Crawler.toEntry({ company: 'Site Only Traders', website: 'https://siteonly.example.in' }, srcObj)?.website === 'https://siteonly.example.in', 'website-only business is saved');
  check(Crawler.toEntry({ company: 'Landline Traders', phones: ['022 2647 0000'] }, srcObj)?.phone_raw === '022 2647 0000', 'phone-only business is saved');

  // --- re-crawl: a finished source starts over, already-found businesses are kept -----------
  const before = (await pool.query('SELECT status FROM directory_sources WHERE id = $1', [src.id])).rows[0].status;
  const rc = await Crawler.recrawlSource(src.id);
  check(before === 'done' && rc.status === 'approved' && rc.pages_total === 0, 're-crawl resets a finished source', `${before} → ${rc.status}`);
  const again = await Crawler.crawlSource(src.id, { maxPages: 50 });
  const entriesAfter = (await pool.query('SELECT COUNT(*)::int AS n FROM directory_entries WHERE source_id = $1', [src.id])).rows[0].n;
  check(again.queued >= 5 && again.newEntries === 0 && entriesAfter === 3, 're-crawl rediscovers pages, no duplicate businesses', `queued=${again.queued} new=${again.newEntries} total=${entriesAfter}`);

  // cleanup: pause the source so the worker never touches it
  await pool.query(`UPDATE directory_sources SET status = 'paused' WHERE id = $1`, [src.id]);
  await pool.query(`DELETE FROM settings WHERE key = 'DIRECTORY_CRAWL_DELAY_MS'`);
  dirServer.close(); sitesServer.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
