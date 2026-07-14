const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Fallback guesses only kick in if link-discovery below finds nothing (e.g. JS-only nav).
const FALLBACK_PATHS = ['/contact', '/contact-us', '/contactus', '/about', '/about-us'];
const CONTACT_LINK_PATTERN = /contact|reach.?us|get.?in.?touch|enquir(y|e)|about/i;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_PAGE_TEXT = 3000;
const MAX_PAGES_TO_FETCH = 5; // homepage + up to 4 more

function normalizeUrl(website) {
  const trimmed = website.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function fetchPage(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DreamsTechnologyBot/1.0)' },
    });
    return typeof data === 'string' ? data : null;
  } catch {
    return null;
  }
}

function extractFromHtml(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const mailtoEmails = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const email = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (email) mailtoEmails.push(email);
  });

  const telNumbers = [];
  $('a[href^="tel:"]').each((_, el) => {
    const tel = ($(el).attr('href') || '').replace(/^tel:/i, '').trim();
    if (tel) telNumbers.push(tel);
  });

  const footerText = $('footer').text().replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_TEXT);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_TEXT);

  return { mailtoEmails, telNumbers, footerText, bodyText };
}

// Real sites name their contact page all sorts of things (typos included — see "conatact").
// Rather than guessing exact paths, read the homepage's own links and follow whichever ones
// look like a contact/about page by their href or visible text.
function discoverContactLinks(homepageHtml, baseUrl) {
  const $ = cheerio.load(homepageHtml);
  const found = new Set();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    const text = $(el).text().trim();
    if (!href || /^(mailto|tel):/i.test(href) || href.startsWith('#')) return;
    if (CONTACT_LINK_PATTERN.test(href) || CONTACT_LINK_PATTERN.test(text)) {
      try {
        found.add(new URL(href, baseUrl).toString());
      } catch { /* malformed href, skip */ }
    }
  });
  return [...found];
}

async function scrapeSite(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const pages = [];
  const fetchedUrls = new Set();

  const homeHtml = await fetchPage(base);
  if (homeHtml) {
    pages.push({ path: '/', ...extractFromHtml(homeHtml) });
    fetchedUrls.add(base);
  }

  const discovered = homeHtml ? discoverContactLinks(homeHtml, base + '/') : [];
  const candidateUrls = [...discovered, ...FALLBACK_PATHS.map(p => `${base}${p}`)];

  for (const url of candidateUrls) {
    if (pages.length >= MAX_PAGES_TO_FETCH) break;
    if (fetchedUrls.has(url)) continue;
    fetchedUrls.add(url);
    const html = await fetchPage(url);
    if (html) pages.push({ path: url, ...extractFromHtml(html) });
  }

  return pages;
}

async function pickContactWithGpt(lead, pages, mailtoEmails, telNumbers) {
  const scrapedText = pages
    .map((p) => `--- ${p.path} ---\nFooter: ${p.footerText}\nBody: ${p.bodyText}`)
    .join('\n\n');

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 250,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You extract the best contact email, phone number, and owner/decision-maker name for a business from scraped website text. ' +
          'Reply with a JSON object: {"email": string|null, "phone": string|null, "ownerName": string|null}. ' +
          'Prefer a named person (owner/founder/director) over a generic info@/support@ address when both are present — ' +
          'but a generic info@/support@ email on its own is a perfectly good result, do not withhold it while searching for a name. ' +
          'For phone, prefer a mobile/direct line over a generic switchboard number if multiple are present. ' +
          'Only return a value that actually appears in the provided text or mailto/tel links. If nothing usable is found for a field, return null for it.',
      },
      {
        role: 'user',
        content: `Business: ${lead.hotel_name || 'unknown'}\nMailto links found: ${mailtoEmails.join(', ') || 'none'}\nTel links found: ${telNumbers.join(', ') || 'none'}\n\nScraped site text:\n${scrapedText}`,
      },
    ],
  });

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
