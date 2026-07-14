const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PATHS_TO_TRY = ['/', '/contact', '/contact-us', '/about', '/about-us'];
const REQUEST_TIMEOUT_MS = 8000;
const MAX_PAGE_TEXT = 3000;

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

  const footerText = $('footer').text().replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_TEXT);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_TEXT);

  return { mailtoEmails, footerText, bodyText };
}

async function scrapeSite(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const pages = [];
  for (const path of PATHS_TO_TRY) {
    const html = await fetchPage(path === '/' ? base : `${base}${path}`);
    if (html) pages.push({ path, ...extractFromHtml(html) });
  }
  return pages;
}

async function pickContactWithGpt(lead, pages, mailtoEmails) {
  const scrapedText = pages
    .map((p) => `--- ${p.path} ---\nFooter: ${p.footerText}\nBody: ${p.bodyText}`)
    .join('\n\n');

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You extract the best contact email and owner/decision-maker name for a business from scraped website text. ' +
          'Reply with a JSON object: {"email": string|null, "ownerName": string|null}. ' +
          'Prefer a named person (owner/founder/director) over a generic info@/support@/sales@ address when both are present. ' +
          'Only return an email that actually appears in the provided text or mailto links. If nothing usable is found, return nulls.',
      },
      {
        role: 'user',
        content: `Business: ${lead.hotel_name || 'unknown'}\nMailto links found: ${mailtoEmails.join(', ') || 'none'}\n\nScraped site text:\n${scrapedText}`,
      },
    ],
  });

  return JSON.parse(response.choices[0].message.content);
}

async function findEmail(lead) {
  if (!lead?.website) {
    return { email: null, ownerName: null, source: 'scraped' };
  }

  const pages = await scrapeSite(normalizeUrl(lead.website));
  if (pages.length === 0) {
    return { email: null, ownerName: null, source: 'scraped' };
  }

  const mailtoEmails = [...new Set(pages.flatMap((p) => p.mailtoEmails))];

  try {
    const picked = await pickContactWithGpt(lead, pages, mailtoEmails);
    return {
      email: picked.email || mailtoEmails[0] || null,
      ownerName: picked.ownerName || null,
      source: 'scraped',
    };
  } catch (error) {
    console.error('[Enrichment] findEmail GPT error:', error.message);
    return { email: mailtoEmails[0] || null, ownerName: null, source: 'scraped' };
  }
}

module.exports = { findEmail };
