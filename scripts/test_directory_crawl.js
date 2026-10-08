// Test for no-sitemap link following in services/directoryCrawlerService.js. Spins up a fake
// directory site on localhost (no sitemap, 3 paginated listing pages, 15 member pages, nav links that
// must be skipped, a robots.txt-blocked path) and crawls it into the throwaway test DB.
// Run: node scripts/test_directory_crawl.js (needs scripts/setup_overnight_db.js's autoagent_overnight DB).
const path = require('path');
const B = path.join(__dirname, '..') + '/';
require(B + 'node_modules/dotenv').config({ path: B + '.env' });
process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/[^/]+$/, '/autoagent_overnight');
process.env.OUTBOUND_DRY_RUN = 'true';

// No AI in this test: GPT extraction "fails" like a missing key, so listing pages park as needs_ai.
const aiUsage = require(B + 'utils/aiUsage');
aiUsage.trackedCompletion = async () => { const e = new Error('Incorrect API key provided (test stub)'); e.status = 401; throw e; };

const express = require(B + 'node_modules/express');
const pool = require(B + 'config/db');
const Crawler = require(B + 'services/directoryCrawlerService');

let failures = 0;
const check = (ok, label, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const setSetting = (k, v) => pool.query(`INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [k, String(v)]);

const members = Array.from({ length: 15 }, (_, i) => ({
  id: i + 1, name: `Test Engineering Works ${i + 1}`, person: `Ramesh Shah${i + 1}`, phone: `98250${String(10000 + i)}`,
}));
const nav = `<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/contact-us">Contact</a> <a href="/private/secret">Members area</a>
  <a href="https://facebook.com/x">FB</a> <a href="/wp-login.php">Login</a> <a href="/brochure.pdf">PDF</a></nav>`;

function startSite() {
  const app = express();
  app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /private/\n'));
  app.get('/members', (req, res) => {
    const page = Number(req.query.page || 1);
    const list = members.slice((page - 1) * 5, page * 5).map((m) => `
      <div class="member"><h3>${m.name}</h3><p>Address : Plot ${m.id}, GIDC Gandhinagar</p>
      <p>Contact Person : ${m.person} – ${m.phone}</p><a href="/member/${m.id}#top?utm_source=x">View profile</a></div>`).join('');
    const pager = [1, 2, 3].map((p) => `<a href="/members?page=${p}">${p}</a>`).join(' ') + (page < 3 ? ` <a rel="next" href="/members?page=${page + 1}">Next</a>` : '');
    res.send(`<html><body>${nav}<main><h1>Members</h1>${list}<div class="pager">${pager}</div></main></body></html>`);
  });
  app.get('/member/:id', (req, res) => {
    const m = members[Number(req.params.id) - 1];
    if (!m) return res.status(404).send('no');
    res.send(`<html><body>${nav}<h1>${m.name}</h1><article>
      <p>Address : Plot ${m.id}, GIDC Engineering Estate, Gandhinagar</p>
      <p>Contact Person : ${m.person} – ${m.phone}</p><p>Products : Fabrication jobwork</p>
      <a href="/member/${m.id}/reviews">Reviews</a> <a href="/members">Back to list</a></article></body></html>`);
  });
  app.get('/member/:id/reviews', (req, res) => res.send('<html><body><h1>Reviews</h1></body></html>'));
  app.get('/sitemap.xml', (req, res) => res.status(404).send('none'));
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

async function crawlAll(sourceId) {
  for (let i = 0; i < 20; i++) {
    const s = await Crawler.crawlSource(sourceId, { maxPages: 50 });
    if (s.pendingLeft === 0 || s.skipped || s.blocked) return s;
  }
  return null;
}

(async () => {
  const server = await startSite();
  const base = `http://127.0.0.1:${server.address().port}`;
  await setSetting('DIRECTORY_CRAWL_DELAY_MS', 10);
  await setSetting('DIRECTORY_MAX_DEPTH', 1);
  await setSetting('DIRECTORY_MAX_PAGES', 500);

  const src = (await pool.query(
    `INSERT INTO directory_sources (url, name, city, status) VALUES ($1, 'Fake paginated directory', 'Gandhinagar', 'approved') RETURNING id`,
    [`${base}/members`])).rows[0];
  await crawlAll(src.id);

  const pages = (await pool.query(`SELECT url, status, depth FROM directory_crawl_pages WHERE source_id = $1 ORDER BY id`, [src.id])).rows;
  const paths = pages.map((p) => p.url.replace(base, ''));
  const entries = (await pool.query(`SELECT company, contact_person, phone_e164 FROM directory_entries WHERE source_id = $1`, [src.id])).rows;

  console.log(`      crawled ${pages.length} pages: ${paths.slice(0, 6).join(', ')} …`);
  check(['/members', '/members?page=2', '/members?page=3'].every((p) => paths.includes(p)), 'followed pagination to page 3 (no sitemap)');
  check(members.every((m) => paths.includes(`/member/${m.id}`)), 'reached all 15 member pages from the listings');
  check(entries.length === 15, '15 businesses extracted', String(entries.length));
  check(!entries.some((e) => /^members$/i.test(e.company)), 'listing page did not become a bogus "Members" business');
  check(entries.every((e) => e.phone_e164 && /^Ramesh/.test(e.contact_person || '')), 'every business has its contact person and mobile');
  check(!paths.some((p) => /reviews/.test(p)), 'did not go deeper than DIRECTORY_MAX_DEPTH (no /reviews pages)');
  check(!paths.some((p) => /about|contact|wp-login|\.pdf/.test(p)), 'skipped about/contact/login/PDF links');
  check(!paths.some((p) => p.startsWith('/private')), 'respected robots.txt Disallow: /private/');
  check(!pages.some((p) => /facebook/.test(p.url)) && !paths.includes('/') && !paths.some((p) => /#|utm_/.test(p)), 'no off-site, homepage, #fragment or utm duplicates');
  check(pages.filter((p) => p.status === 'needs_ai').length === 3, 'the 3 listing pages are parked for AI (multi-member pages)', String(pages.filter((p) => p.status === 'needs_ai').length));

  // Page cap
  await setSetting('DIRECTORY_MAX_PAGES', 8);
  const src2 = (await pool.query(
    `INSERT INTO directory_sources (url, name, city, status) VALUES ($1, 'Fake directory capped', 'Gandhinagar', 'approved') RETURNING id`,
    [`${base}/members?cap=1`])).rows[0];
  await crawlAll(src2.id);
  const n2 = (await pool.query(`SELECT COUNT(*)::int n FROM directory_crawl_pages WHERE source_id = $1`, [src2.id])).rows[0].n;
  check(n2 <= 8, 'DIRECTORY_MAX_PAGES caps the whole crawl', `${n2} pages`);

  await pool.query(`DELETE FROM settings WHERE key IN ('DIRECTORY_CRAWL_DELAY_MS','DIRECTORY_MAX_DEPTH','DIRECTORY_MAX_PAGES')`);
  await pool.query(`UPDATE directory_sources SET status = 'paused' WHERE id = ANY($1)`, [[src.id, src2.id]]);
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
