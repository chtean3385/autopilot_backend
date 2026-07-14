const axios = require('axios');
const pool = require('../config/db');
const settingsService = require('./settingsService');
const ReplyQualityService = require('./replyQualityService');
const PlaybookService = require('./playbookService');
const { sendOrQueueReply } = require('./replyDeliveryService');

const SITE_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — the owner's site copy rarely changes
const SITE_FETCH_TIMEOUT_MS = 8000;
const MAX_SITE_CHARS = 1200;

let siteCache = { url: null, text: null, fetchedAt: 0 };

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPortfolioItems() {
  const result = await pool.query(
    'SELECT title, url, description FROM portfolio_items ORDER BY created_at DESC LIMIT 5'
  );
  return result.rows;
}

// Cached plain-text summary of the owner's own website, used to ground portfolio replies in
// what Dreams Technology actually offers. Best-effort: a fetch failure just means less context,
// never blocks the reply. Swap for enrichmentService's scraper once that lands (Task 6).
async function getServiceContext() {
  const url = await settingsService.getSetting('OWNER_WEBSITE_URL');
  if (!url) return '';

  const isFresh = siteCache.url === url && (Date.now() - siteCache.fetchedAt) < SITE_CACHE_TTL_MS;
  if (isFresh) return siteCache.text;

  try {
    const response = await axios.get(url, { timeout: SITE_FETCH_TIMEOUT_MS });
    const text = stripHtmlToText(String(response.data)).slice(0, MAX_SITE_CHARS);
    siteCache = { url, text, fetchedAt: Date.now() };
    return text;
  } catch (err) {
    console.error('[PortfolioReply] Failed to fetch owner website for context:', err.message);
    return siteCache.url === url ? siteCache.text : '';
  }
}

// Assembles a portfolio reply from portfolio_items + cached site content, scores it via the
// quality gate, and sends (or queues for human review) — leaving the sequence to continue.
async function sendPortfolioReply({ lead, leadSeq, sender, incomingMessage, subject, conversationHistory }) {
  const [portfolioItems, serviceContext, playbookContext] = await Promise.all([
    fetchPortfolioItems(),
    getServiceContext(),
    PlaybookService.getPlaybookContext(),
  ]);

  const result = await ReplyQualityService.draftAndScore({
    leadId: lead.id, lead, incomingMessage, conversationHistory, portfolioItems, serviceContext,
    playbookExamples: playbookContext.fewShotExamples, playbookNotes: playbookContext.notes,
  });

  await sendOrQueueReply({ lead, leadSeq, sender, result, subject, sentActionLabel: 'portfolio_sent' });
}

module.exports = { sendPortfolioReply, fetchPortfolioItems, getServiceContext };
