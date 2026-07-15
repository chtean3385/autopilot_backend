const axios = require('axios');
const cheerio = require('cheerio');

// Shared low-level primitives for the 3 places in this codebase that fetch a lead/owner's
// static HTML (enrichmentService.js, leadResearchService.js, portfolioReplyService.js).
// Each caller keeps its own higher-level crawl strategy (budget, page selection, extraction
// targets) — only the truly identical building blocks live here.

const REQUEST_TIMEOUT_MS = 8000;

function normalizeUrl(website) {
  const trimmed = website.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// A self-identifying bot UA (e.g. "...DreamsTechnologyBot/1.0") gets a flat 403 from plenty of
// ordinary sites' basic WAF/anti-scraping rules — even ones with no real bot-detection intent,
// just a blocklist on anything that doesn't look like a browser. A real browser UA (+ the Accept
// headers a browser actually sends) gets through those the same way a human visiting would.
async function fetchPage(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return typeof data === 'string' ? data : null;
  } catch {
    return null;
  }
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
      if (sameDomainOnly && resolved.hostname !== new URL(baseUrl).hostname) return;
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

module.exports = {
  REQUEST_TIMEOUT_MS,
  normalizeUrl,
  fetchPage,
  loadClean,
  cleanText,
  extractPlainText,
  extractMailtoTel,
  discoverRankedLinks,
};
