const axios = require('axios');
const cheerio = require('cheerio');
const { XMLParser } = require('fast-xml-parser');

// Shared low-level primitives for the 3 places in this codebase that fetch a lead/owner's
// static HTML (enrichmentService.js, leadResearchService.js, portfolioReplyService.js).
// Each caller keeps its own higher-level crawl strategy (budget, page selection, extraction
// targets) — only the truly identical building blocks live here.

const REQUEST_TIMEOUT_MS = 8000;
const MAX_FETCH_RETRIES = 1;
const RETRY_DELAY_MS = 500;

const BROWSER_HEADERS = {
  // A self-identifying bot UA (e.g. "...DreamsTechnologyBot/1.0") gets a flat 403 from plenty of
  // ordinary sites' basic WAF/anti-scraping rules — even ones with no real bot-detection intent,
  // just a blocklist on anything that doesn't look like a browser. A real browser UA (+ the Accept
  // headers a browser actually sends) gets through those the same way a human visiting would.
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retryable = timeout/network blip/5xx. NOT 4xx — a real client error (403/404) won't fix itself.
function isRetryableError(error) {
  return !error.response || error.response.status >= 500;
}

// One retry on a transient failure so a single dropped connection doesn't kill a page for the
// whole crawl. Shared by fetchPage/fetchPageWithMeta below.
async function getWithRetry(url) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await axios.get(url, { timeout: REQUEST_TIMEOUT_MS, headers: BROWSER_HEADERS });
    } catch (error) {
      if (attempt >= MAX_FETCH_RETRIES || !isRetryableError(error)) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function normalizeUrl(website) {
  const trimmed = website.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Host comparison that treats www.example.com and example.com as the same site — sites routinely
// serve on one and canonicalize sitemap/internal URLs on the other (found live on
// dreams-technology.com: crawl entered via www., sitemap lists 62 non-www URLs).
function sameSiteHost(hostA, hostB) {
  const strip = (h) => (h || '').toLowerCase().replace(/^www\./, '');
  return strip(hostA) === strip(hostB);
}

async function fetchPage(url) {
  try {
    const { data } = await getWithRetry(url);
    return typeof data === 'string' ? data : null;
  } catch {
    return null;
  }
}

// Same fetch as fetchPage, but also returns response headers/status — for callers that need
// header-based signals (e.g. hosting/CDN fingerprinting) beyond just the HTML body. A separate
// function rather than changing fetchPage's return shape, since fetchPage's `string | null`
// contract is relied on by enrichmentService.js and portfolioReplyService.js too.
async function fetchPageWithMeta(url) {
  try {
    const response = await getWithRetry(url);
    if (typeof response.data !== 'string') return null;
    return { html: response.data, headers: response.headers || {}, status: response.status };
  } catch {
    return null;
  }
}

// Fetches {baseUrl}/robots.txt and extracts Sitemap: directives (extra sitemap locations to try
// beyond the default /sitemap.xml) and Disallow: paths from the User-agent: * block only (rules
// scoped to a specific named bot are not this crawler's to obey). Never null — an absent or
// unparseable robots.txt just means "nothing extra to respect," so callers can merge unconditionally.
async function fetchRobotsTxt(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const text = await fetchPage(`${base}/robots.txt`);
  if (!text) return { sitemaps: [], disallow: [] };

  const sitemaps = [];
  const disallow = [];
  let inWildcardBlock = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const sitemapMatch = line.match(/^sitemap:\s*(\S+)/i);
    if (sitemapMatch) {
      sitemaps.push(sitemapMatch[1]);
      continue;
    }

    const uaMatch = line.match(/^user-agent:\s*(\S+)/i);
    if (uaMatch) {
      inWildcardBlock = uaMatch[1] === '*';
      continue;
    }

    const disallowMatch = line.match(/^disallow:\s*(\S*)/i);
    if (disallowMatch && inWildcardBlock && disallowMatch[1]) disallow.push(disallowMatch[1]);
  }

  return { sitemaps, disallow };
}

// Loads HTML into cheerio with script/style/noscript stripped — the common prep step
// before any text or link extraction.
function loadClean(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  return $;
}

function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// Plain-text extraction for callers that just want "the page as text" (e.g. grounding a
// GPT prompt in the owner's own site), independent of any specific section targeting.
function extractPlainText(html, maxChars = 3000) {
  const $ = loadClean(html);
  return cleanText($('body').text()).slice(0, maxChars);
}

// Deduped mailto:/tel: links found anywhere on the page — identical extraction used by
// every crawler in this codebase.
function extractMailtoTel(html) {
  const $ = loadClean(html);

  const mailtoEmails = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const email = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (email && !mailtoEmails.includes(email)) mailtoEmails.push(email);
  });

  const telNumbers = [];
  $('a[href^="tel:"]').each((_, el) => {
    const tel = ($(el).attr('href') || '').replace(/^tel:/i, '').trim();
    if (tel && !telNumbers.includes(tel)) telNumbers.push(tel);
  });

  return { mailtoEmails, telNumbers };
}

// Ranks a homepage's <a href> links against a priority list of regexes (tested against
// "href text" lowercased), returning {url, rank} pairs sorted best-first (rank = index of
// the first/highest-priority pattern matched). Options:
//   - excludePatterns: links matching any of these are dropped even if they also match priorityList
//   - sameDomainOnly: drop any link that resolves off the homepage's hostname
function discoverRankedLinks(homepageHtml, baseUrl, priorityList, options = {}) {
  const { excludePatterns = [], sameDomainOnly = false } = options;
  const $ = loadClean(homepageHtml);
  const found = new Map(); // normalized url -> best (lowest) rank seen

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    const text = $(el).text().trim();
    if (!href || /^(mailto|tel):/i.test(href) || href.startsWith('#') || /^javascript:/i.test(href)) return;

    const rankText = `${href} ${text}`.toLowerCase();
    if (excludePatterns.some((rx) => rx.test(rankText))) return;

    const rank = priorityList.findIndex((rx) => rx.test(rankText));
    if (rank === -1) return;

    try {
      const resolved = new URL(href, baseUrl);
      if (sameDomainOnly && !sameSiteHost(resolved.hostname, new URL(baseUrl).hostname)) return;
      const url = resolved.toString().split('#')[0].replace(/\/$/, '');
      if (!found.has(url) || found.get(url) > rank) found.set(url, rank);
    } catch {
      /* malformed href, skip */
    }
  });

  return [...found.entries()]
    .map(([url, rank]) => ({ url, rank }))
    .sort((a, b) => a.rank - b.rank);
}

const MAX_NESTED_SITEMAPS = 5;
const MAX_SITEMAP_URLS = 500;
const xmlParser = new XMLParser({ ignoreAttributes: true });

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// Parses one sitemap XML payload: adds its <urlset> locs to `urls`, or (one level deep only,
// capped at MAX_NESTED_SITEMAPS) recurses into a <sitemapindex>'s nested sitemap files.
async function collectFromSitemapUrl(sitemapUrl, urls, depth = 0) {
  if (urls.size >= MAX_SITEMAP_URLS) return;
  const xml = await fetchPage(sitemapUrl);
  if (!xml) return;

  let parsed;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    return;
  }

  if (parsed?.urlset) {
    for (const urlEntry of toArray(parsed.urlset.url)) {
      if (urlEntry?.loc) urls.add(urlEntry.loc);
      if (urls.size >= MAX_SITEMAP_URLS) break;
    }
    return;
  }

  if (parsed?.sitemapindex && depth < 1) {
    const nested = toArray(parsed.sitemapindex.sitemap).slice(0, MAX_NESTED_SITEMAPS);
    for (const entry of nested) {
      if (urls.size >= MAX_SITEMAP_URLS) break;
      if (entry?.loc) await collectFromSitemapUrl(entry.loc, urls, depth + 1);
    }
  }
}

// Discovers URLs via {baseUrl}/sitemap.xml plus any extra sitemap URLs (e.g. from robots.txt's
// Sitemap: directives, see fetchRobotsTxt) — each handled as a plain <urlset> or a <sitemapindex>
// pointing at further sitemaps (followed one level deep only, capped at MAX_NESTED_SITEMAPS files).
// Returns null (not []) when no sitemap was found/parseable at all, so callers can distinguish
// "this site has no sitemap, fall back to nav-link discovery" from "sitemap exists but is empty."
// Out of scope for this pass: .xml.gz sitemaps.
async function discoverSitemapUrls(baseUrl, extraSitemapUrls = []) {
  const base = baseUrl.replace(/\/$/, '');

  let rootHost;
  try {
    rootHost = new URL(base).hostname;
  } catch {
    return null;
  }

  const urls = new Set();
  const candidateSitemaps = [`${base}/sitemap.xml`, ...extraSitemapUrls];
  for (const sitemapUrl of candidateSitemaps) {
    if (urls.size >= MAX_SITEMAP_URLS) break;
    await collectFromSitemapUrl(sitemapUrl, urls);
  }
  if (urls.size === 0) return null;

  const sameHost = [...urls].filter((u) => {
    try {
      return sameSiteHost(new URL(u).hostname, rootHost);
    } catch {
      return false;
    }
  });

  return sameHost.length > 0 ? sameHost : null;
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  normalizeUrl,
  fetchPage,
  fetchPageWithMeta,
  fetchRobotsTxt,
  loadClean,
  cleanText,
  extractPlainText,
  extractMailtoTel,
  discoverRankedLinks,
  discoverSitemapUrls,
};
