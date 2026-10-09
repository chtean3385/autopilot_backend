#!/usr/bin/env node
// Crawl a whole *.idbf.in city directory FROM THIS MACHINE and write a CSV ready for
// Leads → Import. Exists because idbf answers the production VPS IP with HTTP 500 (datacenter
// block) while residential IPs are served normally — see memory note "idbf blocks VPS".
//
// Touches no database and sends nothing: it only reads public pages and writes files.
//
//   node scripts/crawl_idbf_to_csv.js [https://gandhinagar.idbf.in] [--delay 8000] [--workers 1] [--categories]
//
// idbf blocks ANY IP that fetches too fast (HTTP 500 on every page once the cookie is sent) —
// it blocked this laptop after ~330 pages at 2/sec on 2026-10-09, same as the VPS. Hence the slow
// default (1 page / 8s ≈ 6 h for Gandhinagar's 2,559 businesses) and the auto-stop below. Do not
// work around a block (proxies, other IPs); wait it out and rerun — progress is kept.
//
// Resumable: every fetched business page is appended to <out>/<host>.progress.jsonl; rerunning
// skips pages already done and retries the ones that failed. The CSV is rebuilt from that file
// at the end of each run.
//
// Pages found via: robots.txt sitemap (business pages + category pages) + every category page's
// links to businesses on the same city host. Contact data comes from the schema.org LocalBusiness
// JSON-LD each business page carries (same extractor the in-app crawler uses), falling back to the
// "Label : value" rules. No GPT calls.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { fetchRobotsTxt, discoverSitemapUrls } = require('../utils/siteCrawler');
const { extractMembersByJsonLd, extractMembersByRules, toEntry, isDisallowed } = require('../services/directoryCrawlerService');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const BASE = (args.find((a) => /^https?:\/\//.test(a)) || 'https://gandhinagar.idbf.in').replace(/\/+$/, '');
const HOST = new URL(BASE).hostname;
const CITY = HOST.split('.')[0].replace(/^\w/, (c) => c.toUpperCase());
const DELAY_MS = Number(flag('delay', 8000));
const WORKERS = Number(flag('workers', 1));
const WITH_CATEGORIES = args.includes('--categories'); // category pages added 0 businesses for Gandhinagar
const STOP_AFTER_FAILS = 8; // this many failures in a row = we are blocked; stop instead of hammering
const OUT_DIR = path.resolve(flag('out', path.join(__dirname, '..', '..', 'exports', 'idbf')));
const PROGRESS = path.join(OUT_DIR, `${HOST}.progress.jsonl`);
const CSV_OUT = path.join(OUT_DIR, `${HOST}.csv`);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: 'null=null', // the cookie idbf's JS stub sets before reloading
};
const BUSINESS_PATH = /^\/\d+\/[^/]+\/?$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 404 = gone, don't retry. 5xx/network = retry with backoff (3 tries).
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await axios.get(url, { headers: HEADERS, timeout: 30000 });
      return typeof r.data === 'string' ? r.data : null;
    } catch (e) {
      const status = e.response?.status;
      if (status && status < 500) return null;
      if (attempt >= 3) throw new Error(status ? `HTTP ${status}` : e.code || e.message);
      await sleep(2000 * attempt);
    }
  }
}

let blocked = false;
async function runPool(items, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < items.length && !blocked) {
      const item = items[next++];
      await fn(item);
      await sleep(DELAY_MS);
    }
  }));
}

function businessLinks(html) {
  const $ = cheerio.load(html);
  const out = new Set();
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href'), BASE);
      if (u.hostname === HOST && BUSINESS_PATH.test(u.pathname)) out.add(`${u.origin}${u.pathname.replace(/\/$/, '')}`);
    } catch { /* bad href */ }
  });
  return out;
}

function loadProgress() {
  const done = new Map();
  if (!fs.existsSync(PROGRESS)) return done;
  for (const line of fs.readFileSync(PROGRESS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); done.set(r.url, r); } catch { /* partial last line */ }
  }
  return done;
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function writeCsv(records) {
  const cols = ['Business Name', 'Contact Person', 'WhatsApp Number', 'Email', 'Website', 'City', 'Category', 'Address', 'All Phones', 'Profile URL'];
  const seen = new Set();
  const rows = [];
  for (const r of records) {
    if (r.status !== 'ok') continue;
    for (const e of r.entries) {
      const key = `${e.company.toLowerCase()}|${e.phone_e164 || e.phone_raw || e.email || e.website || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push([
        e.company, e.contact_person, e.phone_e164 ? e.phone_e164.replace(/^\+/, '') : '', e.email, e.website,
        e.city || CITY, e.category, e.address, (e.all_phones || []).join(' / '), r.url,
      ]);
    }
  }
  // BOM so Excel opens Gujarati/₹ characters correctly; the importer ignores it.
  fs.writeFileSync(CSV_OUT, '﻿' + [cols, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n'), 'utf8');
  return rows;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Crawling ${BASE} → ${CSV_OUT}  (workers=${WORKERS}, delay=${DELAY_MS}ms)`);

  const robots = await fetchRobotsTxt(BASE);
  const sitemap = (await discoverSitemapUrls(BASE, robots.sitemaps, { maxUrls: 500000 })) || [];
  const allowed = sitemap.filter((u) => !isDisallowed(u, robots.disallow));
  const business = new Set();
  const categories = [];
  for (const u of allowed) {
    const p = new URL(u);
    if (p.hostname !== HOST) continue;
    if (BUSINESS_PATH.test(p.pathname)) business.add(`${p.origin}${p.pathname.replace(/\/$/, '')}`);
    else if (p.pathname.split('/').filter(Boolean).length === 1 && p.pathname.length > 2) categories.push(u); // skip /a../z (broken on the site)
  }
  console.log(`Sitemap: ${business.size} business pages, ${categories.length} category pages`);

  // Category pages list businesses the sitemap may miss (opt-in: --categories).
  let catDone = 0;
  const before = business.size;
  await runPool(WITH_CATEGORIES ? categories : [], async (u) => {
    try {
      const html = await get(u);
      if (html) for (const b of businessLinks(html)) business.add(b);
    } catch { /* a category page failing just means fewer extra links */ }
    if (++catDone % 25 === 0) console.log(`  categories ${catDone}/${categories.length} — ${business.size - before} extra businesses found`);
  });
  console.log(`Total business pages: ${business.size} (${business.size - before} found only via category pages)`);

  const progress = loadProgress();
  const todo = [...business].filter((u) => progress.get(u)?.status !== 'ok');
  console.log(`Already done: ${business.size - todo.length}. To fetch now: ${todo.length}`);

  const log = fs.createWriteStream(PROGRESS, { flags: 'a' });
  const source = { url: BASE, city: CITY };
  let n = 0, ok = 0, failed = 0, failStreak = 0;
  const started = Date.now();
  await runPool(todo, async (url) => {
    let rec;
    try {
      const html = await get(url);
      if (!html) {
        rec = { url, status: 'gone', entries: [] };
      } else {
        const members = extractMembersByJsonLd(html, url) || extractMembersByRules(html, url) || [];
        const entries = members.map((m) => {
          const e = toEntry(m, source);
          return e && { ...e, all_phones: [...new Set((m.phones || []).concat((m.contacts || []).map((c) => c.phone)).filter(Boolean))] };
        }).filter(Boolean);
        rec = { url, status: 'ok', entries };
        ok++;
        failStreak = 0;
      }
    } catch (err) {
      rec = { url, status: 'failed', error: err.message, entries: [] };
      failed++;
      if (++failStreak >= STOP_AFTER_FAILS && !blocked) {
        blocked = true;
        console.log(`
${STOP_AFTER_FAILS} pages failed in a row (${err.message}) — the site is blocking this IP. Stopping.`);
        console.log('Wait a few hours, then rerun the same command; finished pages are kept.');
      }
    }
    log.write(JSON.stringify(rec) + '\n');
    progress.set(url, rec);
    if (++n % 50 === 0 || n === todo.length) {
      const rate = n / ((Date.now() - started) / 1000);
      const eta = Math.round((todo.length - n) / rate / 60);
      console.log(`  ${n}/${todo.length} pages  ok=${ok} failed=${failed}  ~${eta} min left`);
    }
  });
  await new Promise((r) => log.end(r));

  const rows = writeCsv([...progress.values()]);
  const withMobile = rows.filter((r) => r[2]).length;
  const withEmail = rows.filter((r) => r[3]).length;
  const withSite = rows.filter((r) => r[4]).length;
  const stillFailed = [...progress.values()].filter((r) => r.status === 'failed').length;
  console.log(`\nDone. ${rows.length} businesses → ${CSV_OUT}`);
  console.log(`  with mobile (WhatsApp-able): ${withMobile}   with email: ${withEmail}   with website: ${withSite}`);
  if (stillFailed) console.log(`  ${stillFailed} pages failed — rerun the same command to retry just those.`);
})().catch((e) => { console.error('Crawl aborted:', e); process.exit(1); });
