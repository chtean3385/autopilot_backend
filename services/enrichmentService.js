const OpenAI = require('openai');
const { normalizeUrl, fetchPage, loadClean, cleanText, extractMailtoTel, discoverRankedLinks } = require('../utils/siteCrawler');
const { trackedCompletion } = require('../utils/aiUsage');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_PAGE_TEXT = 3000;

// 3-step crawl budget: homepage, then at most one contact/about-tier page, then at most one
// privacy/legal-tier fallback page — stopping early the moment a mailto email turns up. Ordered
// highest-priority-first; pickAndFetchBestPage below picks the single best match per step rather
// than fetching every candidate (the old approach fetched up to 5 pages per domain regardless).
const STEP2_LINK_PRIORITY = [
  /contact[-_]?us/i,
  /\bcontact\b/i,
  /get[-_]?in[-_]?touch/i,
  /reach[-_]?us/i,
  /\bconnect\b/i,
  /about[-_]?us/i,
  /\babout\b/i,
  /\bteam\b/i,
  /leadership/i,
  /\bcompany\b/i,
];
const STEP2_FALLBACK_PATHS = [
  '/contact', '/contact-us', '/contactus', '/contact-us.html', '/contact/',
  '/about', '/about-us', '/team', '/leadership', '/company', '/connect', '/reach-us',
];

// Step 3 only fires if step 2 (and the homepage) turned up no mailto email at all.
const STEP3_LINK_PRIORITY = [
  /privacy[-_]?policy/i,
  /\bprivacy\b/i,
  /\bterms\b/i,
  /\bimprint\b/i,
  /\blegal\b/i,
  /\bsupport\b/i,
];
const STEP3_FALLBACK_PATHS = ['/privacy-policy', '/privacy', '/terms', '/imprint', '/legal', '/support'];

function extractFromHtml(html) {
  const $ = loadClean(html);
  const { mailtoEmails, telNumbers } = extractMailtoTel(html);

  const footerText = cleanText($('footer').text()).slice(0, MAX_PAGE_TEXT);
  const bodyText = cleanText($('body').text()).slice(0, MAX_PAGE_TEXT);

  return { mailtoEmails, telNumbers, footerText, bodyText };
}

// Fetches exactly one page for this crawl step: the highest-priority discovered link (ranked by
// its position in priorityList via discoverRankedLinks), or — if link-discovery found nothing at
// all (e.g. JS-only nav) — the first fallbackPaths guess that actually resolves. Returns null if
// nothing worked.
async function pickAndFetchBestPage(rankedLinks, fallbackPaths, base, fetchedUrls) {
  const best = rankedLinks[0]?.url;
  if (best && !fetchedUrls.has(best)) {
    fetchedUrls.add(best);
    const html = await fetchPage(best);
    if (html) return { url: best, html };
  }
  for (const path of fallbackPaths) {
    const url = `${base}${path}`;
    if (fetchedUrls.has(url)) continue;
    fetchedUrls.add(url);
    const html = await fetchPage(url);
    if (html) return { url, html };
  }
  return null;
}

async function scrapeSite(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const pages = [];
  const fetchedUrls = new Set();

  // STEP 1 — homepage. A mailto right there is as good as it gets; stop immediately.
  const homeHtml = await fetchPage(base);
  if (!homeHtml) return pages;
  fetchedUrls.add(base);
  const homeData = extractFromHtml(homeHtml);
  pages.push({ path: '/', ...homeData });
  if (homeData.mailtoEmails.length > 0) return pages;

  // STEP 2 — single highest-priority contact/about-style page.
  const step2Links = discoverRankedLinks(homeHtml, base + '/', STEP2_LINK_PRIORITY);
  const step2 = await pickAndFetchBestPage(step2Links, STEP2_FALLBACK_PATHS, base, fetchedUrls);
  if (step2) pages.push({ path: step2.url, ...extractFromHtml(step2.html) });
  if (pages.some((p) => p.mailtoEmails.length > 0)) return pages;

  // STEP 3 — one last narrow attempt (privacy/terms/imprint often list a legal/support email).
  const step3Links = discoverRankedLinks(homeHtml, base + '/', STEP3_LINK_PRIORITY);
  const step3 = await pickAndFetchBestPage(step3Links, STEP3_FALLBACK_PATHS, base, fetchedUrls);
  if (step3) pages.push({ path: step3.url, ...extractFromHtml(step3.html) });

  return pages;
}

async function pickContactWithGpt(lead, pages, mailtoEmails, telNumbers) {
  const scrapedText = pages
    .map((p) => `--- ${p.path} ---\nFooter: ${p.footerText}\nBody: ${p.bodyText}`)
    .join('\n\n');

  const response = await trackedCompletion(client, {
    model: 'gpt-4o-mini',
    max_tokens: 250,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are an expert business contact extraction agent working from already-scraped website text ' +
          '(a homepage plus up to two secondary pages picked for likely contact info). Extract the PRIMARY business contact.\n\n' +
          'EMAIL — when multiple candidates are present, prefer in this order: ' +
          '(1) a named owner\'s personal email, (2) founder email, (3) director email, (4) CEO email, ' +
          '(5) sales email, (6) business/general email, (7) info@, (8) support@. ' +
          'Never return noreply@, no-reply@, or donotreply@ addresses.\n\n' +
          'PHONE — return ONLY a mobile/direct/WhatsApp/cell number. Reject fax, toll-free, switchboard, ' +
          'reception, and landline numbers. If only a landline exists, return null for phone.\n\n' +
          'OWNER NAME — return a real person\'s name only (e.g. "John Smith"). Never return a role or team ' +
          'label like "Admin", "Sales Team", "Support", or "Reception". If no named person appears, return null.\n\n' +
          'Only return a value that explicitly appears in the provided mailto/tel links or page text — never guess or infer. ' +
          'Reply with a JSON object only: {"email": string|null, "phone": string|null, "ownerName": string|null}.',
      },
      {
        role: 'user',
        content: `Business: ${lead.hotel_name || 'unknown'}\nMailto links found: ${mailtoEmails.join(', ') || 'none'}\nTel links found: ${telNumbers.join(', ') || 'none'}\n\nScraped site text:\n${scrapedText}`,
      },
    ],
  }, { purpose: 'email_enrichment', leadId: lead.id ?? null });

  return JSON.parse(response.choices[0].message.content);
}

async function findEmail(lead) {
  if (!lead?.website) {
    return { email: null, ownerName: null, phone: null, source: 'scraped' };
  }

  const pages = await scrapeSite(normalizeUrl(lead.website));
  if (pages.length === 0) {
    return { email: null, ownerName: null, phone: null, source: 'scraped' };
  }

  const mailtoEmails = [...new Set(pages.flatMap((p) => p.mailtoEmails))];
  const telNumbers = [...new Set(pages.flatMap((p) => p.telNumbers))];

  try {
    const picked = await pickContactWithGpt(lead, pages, mailtoEmails, telNumbers);
    return {
      email: picked.email || mailtoEmails[0] || null,
      ownerName: picked.ownerName || null,
      phone: picked.phone || telNumbers[0] || null,
      source: 'scraped',
    };
  } catch (error) {
    console.error('[Enrichment] findEmail GPT error:', error.message);
    return { email: mailtoEmails[0] || null, ownerName: null, phone: telNumbers[0] || null, source: 'scraped' };
  }
}

module.exports = { findEmail };
