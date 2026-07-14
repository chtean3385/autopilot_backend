const pool = require('../config/db');
const settingsService = require('./settingsService');
const ReplyQualityService = require('./replyQualityService');
const PlaybookService = require('./playbookService');
const { sendOrQueueReply } = require('./replyDeliveryService');
const { normalizeUrl, fetchPage, extractPlainText } = require('../utils/siteCrawler');

const SITE_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — the owner's site copy rarely changes
const MAX_SITE_CHARS = 1200;

let siteCache = { url: null, text: null, fetchedAt: 0 };

async function fetchPortfolioItems() {
  const result = await pool.query(
    'SELECT title, url, description FROM portfolio_items ORDER BY created_at DESC LIMIT 5'
  );
  return result.rows;
}

// Cached plain-text summary of the owner's own website, used to ground portfolio replies in
// what Dreams Technology actually offers. Best-effort: a fetch failure just means less context,
// never blocks the reply. Shares the fetch/extract primitives used by enrichmentService.js and
// leadResearchService.js (backend/utils/siteCrawler.js) instead of its own bespoke scraper.
async function getServiceContext() {
  const rawUrl = await settingsService.getSetting('OWNER_WEBSITE_URL');
  if (!rawUrl) return '';
  const url = normalizeUrl(rawUrl);

  const isFresh = siteCache.url === url && (Date.now() - siteCache.fetchedAt) < SITE_CACHE_TTL_MS;
  if (isFresh) return siteCache.text;

  const html = await fetchPage(url);
  if (!html) {
    console.error('[PortfolioReply] Failed to fetch owner website for context');
    return siteCache.url === url ? siteCache.text : '';
  }

  const text = extractPlainText(html, MAX_SITE_CHARS);
  siteCache = { url, text, fetchedAt: Date.now() };
  return text;
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
