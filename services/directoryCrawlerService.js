const OpenAI = require('openai');
const pool = require('../config/db');
const {
  normalizeUrl, fetchPage, fetchRobotsTxt, loadClean, cleanText, extractMailtoTel, discoverSitemapUrls,
} = require('../utils/siteCrawler');
const { trackedCompletion, isAiAvailable } = require('../utils/aiUsage');
const { normalizeMobileNumber } = require('../utils/phone');
const settingsService = require('./settingsService');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Directory outreach step 1 (_docs/directory-outreach-plan.md). Crawls an owner-approved public
// business directory (e.g. an industrial association's member list) into directory_entries — a
// holding area, not leads. Only status='approved'/'crawling' sources are ever fetched, and the
// owner approves each source by hand: every directory has its own terms, and that one click per
// site is the legal/quality check.
//
// Deliberately NOT done: logins, CAPTCHAs, robots.txt-disallowed paths, and decoding obfuscated
// emails (e.g. Cloudflare "[email protected]" — gecaassociation.org uses it). An obfuscated email
// is the site saying "don't harvest this"; those entries get their email from the business's own
// website later via enrichmentService instead.

// Big aggregators whose terms forbid scraping — refused even if someone approves them.
const BLOCKED_DOMAINS = [
  'justdial.com', 'indiamart.com', 'tradeindia.com', 'zaubacorp.com', 'tofler.in', 'sulekha.com',
  'exportersindia.com', 'linkedin.com', 'facebook.com', 'instagram.com', 'google.com', 'thecompanycheck.com',
];

// Paths never worth fetching when following links (no-sitemap mode): accounts, assets, and the
// site's own info pages. Unlike NON_MEMBER_PATH, category/tag/page-N listings ARE followed there —
// without a sitemap they're the only way to reach every member.
const SKIP_PATH = /\/(author|feed|wp-content|wp-admin|wp-json|wp-login\.php|cart|checkout|my-account|login|logout|signin|signup|register|contact(-us)?|about(-us)?|privacy(-policy)?|terms|disclaimer|gallery|events?|news|blog|careers?|donate)(\/|$)|\.(xml|jpe?g|png|gif|webp|svg|pdf|zip|docx?|xlsx?|pptx?|mp4|mp3|css|js)$/i;
// "Next page" links: followed without using up depth, so a 50-page member list is read to the end.
const PAGINATION_HREF = /[?&](page|paged|pg|p|start|offset|pageno|page_no)=\d+|\/page\/\d+\/?$/i;
const PAGINATION_TEXT = /^(next|next page|more|older|›|»|>|→|\d{1,3})$/i;
const MAX_LINKS_PER_PAGE = 300;

// With a sitemap, URL paths that are never a member listing on a typical CMS-built directory site.
const NON_MEMBER_PATH =/\/(category|tag|author|page\/\d+|feed|wp-content|wp-admin|wp-json|cart|checkout|my-account|login|register|contact(-us)?|about(-us)?|privacy|terms|gallery|events?|news|blog)(\/|$)|\.(xml|jpg|jpeg|png|gif|pdf|zip)$/i;

const MAX_PAGE_TEXT = 6000;
const DEFAULT_DELAY_MS = 3000;
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_PAGES_PER_TICK = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function intSetting(key, fallback, { allowZero = false } = {}) {
  const n = parseInt(await settingsService.getSetting(key), 10);
  return Number.isFinite(n) && (n > 0 || (allowZero && n === 0)) ? n : fallback;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function isBlockedDomain(url) {
  const host = hostOf(url);
  return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

// robots.txt Disallow match for the User-agent: * block (fetchRobotsTxt already scoped it).
// Supports the two wildcards robots.txt actually uses: '*' (any run) and a trailing '$'.
function isDisallowed(url, disallow) {
  let path;
  try { const u = new URL(url); path = u.pathname + u.search; } catch { return true; }
  return disallow.some((rule) => {
    const anchored = rule.endsWith('$');
    const pattern = rule.replace(/\$$/, '').split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path);
  });
}

function sameSite(url, base) {
  return hostOf(url) && hostOf(url) === hostOf(base);
}

function cleanEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email)) return null;
  if (/protected|noreply|no-reply|donotreply|example\.com/.test(email)) return null;
  return email;
}

function cleanWebsite(raw, directoryUrl) {
  const site = String(raw || '').trim();
  if (!site || !/\.[a-z]{2,}/i.test(site)) return null;
  const url = normalizeUrl(site.replace(/\/$/, ''));
  // A link back to the directory itself (or a blocked aggregator) is not the business's own site.
  if (sameSite(url, directoryUrl) || isBlockedDomain(url)) return null;
  return url;
}

// ---------------------------------------------------------------------------------------------
// Discovery: fill directory_crawl_pages for a source. Sitemap first (cheap, complete on most CMS
// sites): every member URL is queued up front and nothing is expanded (depth NULL). No sitemap: only
// the source URL is queued (depth 0) and links are followed as pages are crawled — see expandLinks.
// ---------------------------------------------------------------------------------------------
function normalizePageUrl(href, baseUrl) {
  const u = new URL(href, baseUrl);
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|replytocom|share)/i.test(k)) u.searchParams.delete(k);
    // "?page=1" is the same page as the listing without it — don't crawl it twice.
    else if (/^(page|paged|pg|p|pageno|page_no)$/i.test(k) && u.searchParams.get(k) === '1') u.searchParams.delete(k);
  }
  u.pathname = u.pathname.replace(/\/page\/1\/?$/, '/');
  return u.toString().replace(/\/$/, '');
}

async function queuedCount(sourceId) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM directory_crawl_pages WHERE source_id=$1', [sourceId]);
  return r.rows[0].n;
}

// Queue the same-site links on a crawled page (no-sitemap mode only). Pagination keeps the parent's
// depth; any other link costs one level, up to DIRECTORY_MAX_DEPTH (default 1: listing → detail
// pages). Respects robots.txt, SKIP_PATH, and the DIRECTORY_MAX_PAGES cap on the whole queue.
async function expandLinks(html, page, source, robots, { maxDepth, maxPages }) {
  if (page.depth === null || page.depth === undefined) return 0;
  const room = maxPages - (await queuedCount(source.id));
  if (room <= 0) return 0;

  const $ = loadClean(html);
  const sourceRoot = normalizePageUrl(normalizeUrl(source.url), normalizeUrl(source.url));
  const found = new Map(); // url → depth
  $('a[href]').slice(0, MAX_LINKS_PER_PAGE * 3).each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || /^(mailto|tel|javascript|whatsapp):/i.test(href) || href.startsWith('#')) return;
    let url;
    try { url = normalizePageUrl(href, page.url); } catch { return; }
    if (!sameSite(url, page.url) || !/^https?:/i.test(url)) return;
    const path = new URL(url).pathname;
    if (SKIP_PATH.test(path) || (path === '/' && url !== sourceRoot) || isDisallowed(url, robots.disallow)) return;
    const isPagination = $(el).attr('rel') === 'next' || PAGINATION_HREF.test(url) || PAGINATION_TEXT.test(cleanText($(el).text()));
    const depth = isPagination ? page.depth : page.depth + 1;
    if (depth > maxDepth) return;
    if (!found.has(url) || found.get(url) > depth) found.set(url, depth);
  });

  let added = 0;
  for (const [url, depth] of [...found.entries()].slice(0, Math.min(room, MAX_LINKS_PER_PAGE))) {
    const r = await pool.query(
      `INSERT INTO directory_crawl_pages (source_id, url, depth) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
      [source.id, url, depth]
    );
    if (r.rows[0]) added++;
  }
  if (added) {
    await pool.query(`UPDATE directory_sources SET pages_total = $2, updated_at = NOW() WHERE id = $1`, [source.id, await queuedCount(source.id)]);
  }
  return added;
}

async function discoverPages(source) {
  const base = new URL(normalizeUrl(source.url)).origin;
  const robots = await fetchRobotsTxt(base);

  if (isDisallowed(source.url, robots.disallow)) {
    await pool.query(
      `UPDATE directory_sources SET status='failed', robots_ok=FALSE, last_error=$2, updated_at=NOW() WHERE id=$1`,
      [source.id, 'robots.txt disallows this URL']
    );
    return { queued: 0, blocked: 'robots' };
  }

  const maxPages = await intSetting('DIRECTORY_MAX_PAGES', DEFAULT_MAX_PAGES);
  const sitemapUrls = await discoverSitemapUrls(base, robots.sitemaps);

  if (sitemapUrls) {
    const urls = [normalizeUrl(source.url), ...sitemapUrls]
      .filter((u) => u === normalizeUrl(source.url) || !NON_MEMBER_PATH.test(new URL(u).pathname))
      .filter((u) => new URL(u).pathname !== '/' || u === normalizeUrl(source.url))
      .filter((u) => !isDisallowed(u, robots.disallow))
      .slice(0, maxPages);
    for (const url of urls) {
      await pool.query(
        `INSERT INTO directory_crawl_pages (source_id, url, depth) VALUES ($1, $2, NULL) ON CONFLICT DO NOTHING`,
        [source.id, url]
      );
    }
  } else {
    // No sitemap: start from the source page; links are followed as pages are crawled.
    await pool.query(
      `INSERT INTO directory_crawl_pages (source_id, url, depth) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`,
      [source.id, normalizeUrl(source.url)]
    );
  }
  const total = await pool.query('SELECT COUNT(*)::int AS n FROM directory_crawl_pages WHERE source_id=$1', [source.id]);
  await pool.query(
    `UPDATE directory_sources SET status='crawling', robots_ok=TRUE, pages_total=$2, last_error=NULL, updated_at=NOW() WHERE id=$1`,
    [source.id, total.rows[0].n]
  );
  return { queued: total.rows[0].n, viaSitemap: Boolean(sitemapUrls), robots };
}

// ---------------------------------------------------------------------------------------------
// Rule-based extraction for the common "one member per page, Label : value" layout (WordPress
// association directories like gecaassociation.org: h1 = company, then Address / Contact Person /
// E-mail / Website / Products). Free, deterministic, and no AI needed — GPT is only the fallback
// for pages this doesn't recognise. Returns null when the page isn't in this layout.
// ---------------------------------------------------------------------------------------------
const LABELS = [
  ['address', /^(registered\s+)?(office\s+)?address$/i],
  ['contact', /^(contact(\s+person|\s+persons|\s+no\.?|\s+details)?|mobile(\s+no\.?)?|phone(\s+no\.?)?|tel(ephone)?|cell)$/i],
  ['email', /^e-?mail(\s+id)?$/i],
  ['website', /^(website|web|url|web\s*site)$/i],
  ['products', /^(products?(\s*\/\s*services?)?|services?|business|activity|mfg\.?\s+of)$/i],
  ['category', /^(category|industry|sector)$/i],
];

function htmlToLines($, el) {
  const html = ($(el).html() || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|div|li|tr|dd|dt)>/gi, '\n');
  return loadClean(`<div>${html}</div>`)('div').first().text()
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function splitContacts(value) {
  // "Maulik Patel – 9724787093 / Vinodchandra Radadia – 9825027775"
  return value.split(/\s*[/,;]\s*(?=[A-Za-z])|\s+\/\s+/).map((part) => {
    const phone = (part.match(/(\+?\d[\d\s-]{8,}\d)/) || [])[1] || null;
    const name = part.replace(phone || '', '').replace(/[–—:\-()]+/g, ' ').replace(/\s+/g, ' ').trim() || null;
    return { name: name && /[a-z]/i.test(name) ? name : null, phone: phone ? phone.trim() : null };
  }).filter((c) => c.name || c.phone);
}

function extractMembersByRules(html, pageUrl) {
  const $ = loadClean(html);
  const company = cleanText($('h1').first().text());
  const content = $('.entry-content, article, main').first();
  if (!company || !content.length) return null;
  // "Category: Fastener", "Archives", "Members", "Search results" → a listing page, not one business.
  if (/:/.test(company) || /^(category|tag|archives?|members?|member directory|directory|search|results|page \d+)\b/i.test(company)) return null;

  const fields = {};
  const seen = {};
  let pendingLabel = null;
  for (const line of htmlToLines($, content)) {
    const m = line.match(/^([A-Za-z][A-Za-z .\/-]{1,30}?)\s*[:：]\s*(.*)$/);
    const key = m && LABELS.find(([, rx]) => rx.test(m[1].trim()))?.[0];
    if (key) {
      // The same label twice ("Address :" … "Address :") means several businesses on one page —
      // a listing, not a member page. Merging them would invent one bogus business; GPT handles it.
      seen[key] = (seen[key] || 0) + 1;
      if (seen[key] > 1 && key !== 'contact' && key !== 'email') return null;
      if (m[2]) { fields[key] = fields[key] ? `${fields[key]} / ${m[2]}` : m[2]; pendingLabel = null; }
      else pendingLabel = key; // value is on the next line
    } else if (pendingLabel) {
      fields[pendingLabel] = line;
      pendingLabel = null;
    }
  }
  // Recognised only if at least two labelled fields were found — otherwise let GPT decide.
  if (Object.keys(fields).length < 2) return null;

  const website = $('a[href^="http"]', content).map((_, a) => $(a).attr('href')).get()
    .find((h) => !/\/cdn-cgi\//.test(h) && !sameSite(h, pageUrl)) || fields.website || null;
  const plainEmails = String(fields.email || '').match(/[^\s@/]+@[^\s@/]+\.[a-z]{2,}/gi) || [];
  const contacts = fields.contact ? splitContacts(fields.contact) : [];

  return [{
    company,
    contacts,
    phones: [],
    emails: plainEmails, // obfuscated "[email protected]" text never matches this — deliberately
    website,
    address: fields.address || null,
    category: fields.category || cleanText($('a[rel~="category"]').first().text()) || null,
    products: fields.products || null,
  }];
}

// ---------------------------------------------------------------------------------------------
// GPT extraction (fallback): one call per page → zero or more member businesses. Non-member pages
// simply return []. Values must appear verbatim on the page (same rule as enrichmentService).
// ---------------------------------------------------------------------------------------------
async function extractMembersWithGpt(html, pageUrl, source) {
  const $ = loadClean(html);
  $('nav, header, footer, aside, form, .sidebar, .widget, .menu').remove();
  const text = cleanText($('main').text() || $('article').text() || $('body').text()).slice(0, MAX_PAGE_TEXT);
  if (text.length < 40) return [];
  const { mailtoEmails, telNumbers } = extractMailtoTel(html);

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 1800,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You extract member businesses from one page of a business directory / association member list.\n' +
          'A page may list zero, one, or many member businesses. Navigation, about pages, news, ads, and the ' +
          'association\'s own office details are NOT members — return none for those.\n\n' +
          'For each member business return:\n' +
          '- company: business name exactly as written\n' +
          '- contacts: every named person with their phone, e.g. [{"name":"Maulik Patel","phone":"9724787093"}] (name or phone may be null)\n' +
          '- phones: any other phone numbers listed for the business\n' +
          '- emails: email addresses written in plain text only. If an email is hidden/obfuscated ' +
          '(e.g. "[email protected]", "email protected", "(at)" puzzles, images) return nothing for it — never guess or reconstruct.\n' +
          '- website, address, category (the directory\'s category/section for it), products (short)\n\n' +
          'Only use values that explicitly appear on the page. Never invent. Missing → null.\n' +
          'Reply with JSON only: {"members":[{"company":"","contacts":[],"phones":[],"emails":[],"website":null,"address":null,"category":null,"products":null}]}',
      },
      {
        role: 'user',
        content: `Directory: ${source.name || source.url}\nPage URL: ${pageUrl}\nmailto links: ${mailtoEmails.join(', ') || 'none'}\ntel links: ${telNumbers.join(', ') || 'none'}\n\nPage text:\n${text}`,
      },
    ],
  }, { purpose: 'directory_extract' });

  const parsed = JSON.parse(response.choices[0].message.content || '{}');
  return Array.isArray(parsed.members) ? parsed.members : [];
}

// Rules first (free); GPT only for pages the rules don't recognise. Returns { members, via }.
async function extractMembers(html, pageUrl, source) {
  const byRules = extractMembersByRules(html, pageUrl);
  if (byRules) return { members: byRules, via: 'rules' };
  return { members: await extractMembersWithGpt(html, pageUrl, source), via: 'gpt' };
}

function toEntry(member, source) {
  const company = String(member.company || '').trim().slice(0, 255);
  if (company.length < 2) return null;

  const contacts = (Array.isArray(member.contacts) ? member.contacts : [])
    .map((c) => ({ name: c?.name ? String(c.name).trim() : null, phone: c?.phone ? String(c.phone).trim() : null }))
    .filter((c) => c.name || c.phone);
  const allPhones = [
    ...contacts.map((c) => c.phone),
    ...(Array.isArray(member.phones) ? member.phones : []),
  ].filter(Boolean).map(String);

  // First phone that normalises to an Indian mobile wins; its contact (if any) becomes the person.
  let phoneE164 = null;
  let phoneRaw = allPhones[0] || null;
  for (const raw of allPhones) {
    const mobile = normalizeMobileNumber(raw);
    if (mobile) { phoneE164 = mobile; phoneRaw = raw; break; }
  }
  const person = contacts.find((c) => c.phone && normalizeMobileNumber(c.phone) === phoneE164 && c.name)
    || contacts.find((c) => c.name);

  const email = (Array.isArray(member.emails) ? member.emails : []).map(cleanEmail).find(Boolean) || null;

  return {
    company,
    contact_person: person?.name ? person.name.slice(0, 255) : null,
    contacts,
    phone_raw: phoneRaw ? phoneRaw.slice(0, 100) : null,
    phone_e164: phoneE164,
    email,
    website: cleanWebsite(member.website, source.url),
    address: member.address ? String(member.address).trim() : null,
    category: member.category ? String(member.category).trim().slice(0, 255) : null,
    products: member.products ? String(member.products).trim() : null,
    city: source.city || null,
  };
}

// Upsert by (source, company): the same member often appears on both a listing page and its own
// detail page — the second sighting only fills gaps, never overwrites what's already known.
async function saveEntry(sourceId, pageUrl, e) {
  const result = await pool.query(
    `INSERT INTO directory_entries
       (source_id, page_url, company, contact_person, contacts, phone_raw, phone_e164, email, website, address, category, products, city)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (source_id, (LOWER(company))) DO UPDATE SET
       contact_person = COALESCE(directory_entries.contact_person, EXCLUDED.contact_person),
       contacts       = CASE WHEN json_array_length(directory_entries.contacts) = 0 THEN EXCLUDED.contacts ELSE directory_entries.contacts END,
       phone_raw      = COALESCE(directory_entries.phone_raw, EXCLUDED.phone_raw),
       phone_e164     = COALESCE(directory_entries.phone_e164, EXCLUDED.phone_e164),
       email          = COALESCE(directory_entries.email, EXCLUDED.email),
       website        = COALESCE(directory_entries.website, EXCLUDED.website),
       address        = COALESCE(directory_entries.address, EXCLUDED.address),
       category       = COALESCE(directory_entries.category, EXCLUDED.category),
       products       = COALESCE(directory_entries.products, EXCLUDED.products)
     RETURNING (xmax = 0) AS inserted`,
    [sourceId, pageUrl, e.company, e.contact_person, JSON.stringify(e.contacts), e.phone_raw, e.phone_e164,
     e.email, e.website, e.address, e.category, e.products, e.city]
  );
  return result.rows[0]?.inserted;
}

async function refreshSourceCounts(sourceId) {
  await pool.query(
    `UPDATE directory_sources SET
       pages_done    = (SELECT COUNT(*) FROM directory_crawl_pages WHERE source_id=$1 AND status IN ('done','failed')),
       entries_found = (SELECT COUNT(*) FROM directory_entries WHERE source_id=$1),
       last_crawled_at = NOW(), updated_at = NOW()
     WHERE id=$1`,
    [sourceId]
  );
}

// Crawl up to `maxPages` pending pages of one source. Resumable: the queue lives in the DB, so a
// restart (or a page budget running out) just continues on the next call.
async function crawlSource(sourceId, { maxPages } = {}) {
  const { rows } = await pool.query('SELECT * FROM directory_sources WHERE id=$1', [sourceId]);
  const source = rows[0];
  if (!source) throw new Error(`Directory source ${sourceId} not found`);
  if (!['approved', 'crawling'].includes(source.status)) {
    return { skipped: true, reason: `status is '${source.status}' — only approved sources are crawled` };
  }
  if (isBlockedDomain(source.url)) {
    await pool.query(`UPDATE directory_sources SET status='rejected', last_error=$2, updated_at=NOW() WHERE id=$1`,
      [source.id, 'Blocked domain — its terms forbid scraping']);
    return { skipped: true, reason: 'blocked domain' };
  }

  const stats = { pages: 0, members: 0, newEntries: 0, failedPages: 0, linksQueued: 0 };
  let robots;
  if (source.status === 'approved') {
    const d = await discoverPages(source);
    if (d.blocked) return { ...stats, blocked: d.blocked };
    stats.queued = d.queued;
    robots = d.robots;
  } else {
    robots = await fetchRobotsTxt(new URL(normalizeUrl(source.url)).origin);
  }
  const expandOpts = {
    maxDepth: Math.min(await intSetting('DIRECTORY_MAX_DEPTH', 1, { allowZero: true }), 3),
    maxPages: await intSetting('DIRECTORY_MAX_PAGES', DEFAULT_MAX_PAGES),
  };

  const delay = await intSetting('DIRECTORY_CRAWL_DELAY_MS', DEFAULT_DELAY_MS);
  const limit = maxPages || await intSetting('DIRECTORY_PAGES_PER_TICK', DEFAULT_PAGES_PER_TICK);
  // 'needs_ai' = the rules didn't recognise the page and GPT was unavailable last time; retried
  // only while AI is available, so a missing/out-of-credit key never blocks rule-parsable pages.
  const pending = await pool.query(
    `SELECT id, url, depth FROM directory_crawl_pages
     WHERE source_id=$1 AND (status='pending' OR (status='needs_ai' AND $3))
     ORDER BY (status='pending') DESC, id LIMIT $2`,
    [source.id, limit, isAiAvailable()]
  );

  for (const page of pending.rows) {
    if (stats.pages > 0) await sleep(delay);
    // Pause/reject takes effect mid-batch, not only on the next tick.
    const current = await pool.query('SELECT status FROM directory_sources WHERE id=$1', [source.id]);
    if (!['approved', 'crawling'].includes(current.rows[0]?.status)) { stats.stoppedByStatus = current.rows[0]?.status; break; }
    stats.pages++;
    try {
      const html = await fetchPage(page.url);
      if (!html) throw new Error('fetch failed or non-HTML');
      // Follow links before extracting, so a page parked as needs_ai still leads to its members.
      stats.linksQueued += await expandLinks(html, page, source, robots, expandOpts);
      const { members, via } = await extractMembers(html, page.url, source);
      stats[via] = (stats[via] || 0) + 1;
      let saved = 0;
      for (const m of members) {
        const entry = toEntry(m, source);
        if (!entry) continue;
        if (await saveEntry(source.id, page.url, entry)) stats.newEntries++;
        saved++;
      }
      stats.members += saved;
      await pool.query(
        `UPDATE directory_crawl_pages SET status='done', members_found=$2, fetched_at=NOW(), error=NULL WHERE id=$1`,
        [page.id, saved]
      );
    } catch (err) {
      // GPT fallback unavailable (out of credit/budget, or no key) is an outage, not this page's
      // fault — park it as needs_ai and keep going with pages the rules can handle. ByteString =
      // a malformed key (e.g. a masked "sk-…•••" value pasted into settings).
      if (!isAiAvailable() || err.status === 401 || /api key|apikey|credential|ByteString/i.test(err.message)) {
        stats.needsAi = (stats.needsAi || 0) + 1;
        await pool.query(
          `UPDATE directory_crawl_pages SET status='needs_ai', error=$2, fetched_at=NOW() WHERE id=$1`,
          [page.id, String(err.message).slice(0, 300)]
        );
        continue;
      }
      stats.failedPages++;
      await pool.query(
        `UPDATE directory_crawl_pages SET status='failed', error=$2, fetched_at=NOW() WHERE id=$1`,
        [page.id, String(err.message).slice(0, 500)]
      );
    }
  }

  const left = await pool.query(
    `SELECT COUNT(*)::int AS n FROM directory_crawl_pages WHERE source_id=$1 AND status IN ('pending','needs_ai')`, [source.id]
  );
  if (left.rows[0].n === 0) {
    await pool.query(`UPDATE directory_sources SET status='done', updated_at=NOW() WHERE id=$1`, [source.id]);
  }
  await refreshSourceCounts(source.id);
  stats.pendingLeft = left.rows[0].n;
  console.log(`[DirectoryCrawler] Source ${source.id} (${source.url}): ${JSON.stringify(stats)}`);
  return stats;
}

// ---------------------------------------------------------------------------------------------
// Suggestions: GPT proposes candidate directories for a niche + city; each is checked to be
// reachable and robots-allowed, then stored as status='suggested'. Nothing is crawled until the
// owner approves it. GPT can invent URLs — the reachability check drops those.
// ---------------------------------------------------------------------------------------------
async function suggestSources(niche, city) {
  if (!niche || !city) throw new Error('niche and city are required');
  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 900,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Suggest free, public, no-login online member directories that list businesses with contact details for a niche in an Indian city. ' +
          'Good examples: industrial estate / GIDC associations, chambers of commerce member lists, trade associations, ' +
          'professional bodies, local business association sites. Exclude JustDial, IndiaMART, TradeIndia, Sulekha, ' +
          'Zaubacorp, Tofler, social networks, and any paid or login-only database. ' +
          'Only suggest sites you are confident exist. Reply JSON only: {"sources":[{"name":"","url":"","why":""}]} (max 8).',
      },
      { role: 'user', content: `Niche: ${niche}\nCity: ${city}, Gujarat, India` },
    ],
  }, { purpose: 'directory_suggest' });

  const parsed = JSON.parse(response.choices[0].message.content || '{}');
  const out = { added: [], dropped: [] };
  for (const s of (Array.isArray(parsed.sources) ? parsed.sources : [])) {
    const url = s?.url ? normalizeUrl(String(s.url)) : null;
    if (!url) continue;
    if (isBlockedDomain(url)) { out.dropped.push({ url, reason: 'blocked domain' }); continue; }
    const html = await fetchPage(url);
    if (!html) { out.dropped.push({ url, reason: 'unreachable (may not exist)' }); continue; }
    const robots = await fetchRobotsTxt(new URL(url).origin);
    const robotsOk = !isDisallowed(url, robots.disallow);
    const result = await pool.query(
      `INSERT INTO directory_sources (url, name, niche, city, status, suggested_by, notes, robots_ok)
       VALUES ($1,$2,$3,$4,'suggested','ai',$5,$6) ON CONFLICT (url) DO NOTHING RETURNING *`,
      [url, String(s.name || '').slice(0, 255) || null, niche, city, s.why || null, robotsOk]
    );
    if (result.rows[0]) out.added.push(result.rows[0]);
    else out.dropped.push({ url, reason: 'already in sources' });
  }
  return out;
}

async function addSource({ url, name, niche, city, notes }) {
  if (!url) throw new Error('url is required');
  const clean = normalizeUrl(String(url));
  if (isBlockedDomain(clean)) throw new Error('This site is on the blocked list — its terms forbid scraping');
  const result = await pool.query(
    `INSERT INTO directory_sources (url, name, niche, city, status, suggested_by, notes)
     VALUES ($1,$2,$3,$4,'suggested','manual',$5)
     ON CONFLICT (url) DO UPDATE SET name=COALESCE(EXCLUDED.name, directory_sources.name),
       niche=COALESCE(EXCLUDED.niche, directory_sources.niche), city=COALESCE(EXCLUDED.city, directory_sources.city), updated_at=NOW()
     RETURNING *`,
    [clean, name || null, niche || null, city || null, notes || null]
  );
  return result.rows[0];
}

async function setStatus(id, status) {
  if (!['approved', 'rejected', 'paused'].includes(status)) throw new Error(`Invalid status ${status}`);
  // Approving a finished/failed source re-crawls only pages still pending; resuming a paused
  // source with a queue goes straight back to crawling.
  const result = await pool.query(
    `UPDATE directory_sources SET
       status = CASE WHEN $2 = 'approved' AND pages_total > 0 THEN 'crawling' ELSE $2 END,
       updated_at = NOW()
     WHERE id=$1 RETURNING *`,
    [id, status]
  );
  return result.rows[0];
}

module.exports = {
  crawlSource, discoverPages, extractMembers, extractMembersByRules, toEntry, suggestSources, addSource, setStatus,
  isDisallowed, isBlockedDomain, BLOCKED_DOMAINS,
};
