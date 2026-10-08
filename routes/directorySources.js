const express = require('express');
const pool = require('../config/db');
const Directory = require('../services/directoryCrawlerService');
const Promotion = require('../services/directoryPromotionService');
const router = express.Router();

// Directory outreach (_docs/directory-outreach-plan.md) — owner-approved public directories and
// the businesses crawled from them. Nothing here contacts anyone.

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*,
         (SELECT COUNT(*)::int FROM directory_crawl_pages p WHERE p.source_id = s.id AND p.status = 'pending') AS pages_pending,
         (SELECT COUNT(*)::int FROM directory_crawl_pages p WHERE p.source_id = s.id AND p.status = 'failed')  AS pages_failed,
         (SELECT COUNT(*)::int FROM directory_entries e WHERE e.source_id = s.id AND e.phone_e164 IS NOT NULL) AS entries_with_mobile,
         (SELECT COUNT(*)::int FROM directory_entries e WHERE e.source_id = s.id AND e.email IS NOT NULL)      AS entries_with_email,
         (SELECT COUNT(*)::int FROM directory_entries e WHERE e.source_id = s.id AND e.website IS NOT NULL)    AS entries_with_website,
         (SELECT COUNT(*)::int FROM directory_entries e WHERE e.source_id = s.id AND e.lead_id IS NOT NULL)    AS entries_promoted
       FROM directory_sources s
       ORDER BY s.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const source = await Directory.addSource(req.body || {});
    res.json({ success: true, source });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GPT-suggested candidates for a niche + city, reachability/robots checked, stored as 'suggested'.
router.post('/suggest', async (req, res) => {
  try {
    const { niche, city } = req.body || {};
    const result = await Directory.suggestSources(niche, city);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.post('/:id/approve', async (req, res) => statusRoute(req, res, 'approved'));
router.post('/:id/reject', async (req, res) => statusRoute(req, res, 'rejected'));
router.post('/:id/pause', async (req, res) => statusRoute(req, res, 'paused'));

async function statusRoute(req, res, status) {
  try {
    const source = await Directory.setStatus(req.params.id, status);
    if (!source) return res.status(404).json({ success: false, error: 'Source not found' });
    res.json({ success: true, source });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

// Manual "Crawl now" — runs one batch synchronously (max_pages, default the per-tick setting).
router.post('/:id/crawl', async (req, res) => {
  try {
    const maxPages = parseInt(req.body?.max_pages, 10) || undefined;
    const stats = await Directory.crawlSource(req.params.id, { maxPages });
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Promote crawled entries to leads now (they're also promoted by the 10-min worker). Contacts nobody.
router.post('/:id/promote', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.body?.limit, 10) || 25, 200);
    const stats = await Promotion.promoteEntries({ sourceId: parseInt(req.params.id, 10), limit });
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Comma-separated keywords matched against category/products/company; empty = promote everything.
router.put('/:id/filter', async (req, res) => {
  try {
    const source = await Promotion.setCategoryFilter(req.params.id, req.body?.category_filter);
    if (!source) return res.status(404).json({ success: false, error: 'Source not found' });
    res.json({ success: true, source });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id/entries', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { rows } = await pool.query(
      `SELECT * FROM directory_entries WHERE source_id = $1 ORDER BY id LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    // Promoted leads stay (directory_entries.lead_id is the only link and it cascades away with the source).
    await pool.query('DELETE FROM directory_sources WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
