const express = require('express');
const pool = require('../config/db');
const WABAService = require('../services/wabaService');
const router = express.Router();

// Overview stats + per-campaign breakdown
router.get('/', async (req, res) => {
  try {
    const [overviewRes, campaignsRes, agentRes, trendsRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(DISTINCT campaign_id)::int                                           AS total_campaigns,
          COUNT(*)::int                                                              AS total_sent,
          SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END)::int            AS total_delivered,
          SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END)::int                 AS total_read,
          SUM(CASE WHEN response_received = TRUE THEN 1 ELSE 0 END)::int            AS total_replied,
          SUM(CASE WHEN qualified_for_demo = TRUE THEN 1 ELSE 0 END)::int           AS total_demo
        FROM outreach_logs
      `),
      pool.query(`
        SELECT
          c.id, c.campaign_name, c.status, c.created_at, c.target_city,
          t.template_name,
          COUNT(ol.id)::int                                                          AS sent,
          SUM(CASE WHEN ol.delivered_at IS NOT NULL THEN 1 ELSE 0 END)::int        AS delivered,
          SUM(CASE WHEN ol.read_at IS NOT NULL THEN 1 ELSE 0 END)::int             AS read_count,
          SUM(CASE WHEN ol.response_received = TRUE THEN 1 ELSE 0 END)::int        AS replied,
          SUM(CASE WHEN ol.qualified_for_demo = TRUE THEN 1 ELSE 0 END)::int       AS demo_qualified
        FROM campaigns c
        LEFT JOIN outreach_logs ol ON ol.campaign_id = c.id
        LEFT JOIN waba_templates t ON c.template_id = t.id
        GROUP BY c.id, c.campaign_name, c.status, c.created_at, c.target_city, t.template_name
        ORDER BY c.created_at DESC
      `),
      pool.query(`
        SELECT
          COUNT(*)::int                                                 AS total_tasks,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)::int       AS done,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)::int      AS errors,
          COALESCE(SUM(leads_saved), 0)::int                           AS total_leads_scraped,
          COALESCE(SUM(messages_sent), 0)::int                         AS total_messages_sent
        FROM agent_tasks
      `),
      pool.query(`
        SELECT
          DATE(sent_at) AS day,
          COUNT(*)::int AS sent,
          SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END)::int AS delivered,
          SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END)::int      AS read_count,
          SUM(CASE WHEN response_received = TRUE THEN 1 ELSE 0 END)::int AS replied
        FROM outreach_logs
        WHERE sent_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(sent_at)
        ORDER BY day ASC
      `),
    ]);

    res.json({
      overview: overviewRes.rows[0],
      agent: agentRes.rows[0],
      campaigns: campaignsRes.rows,
      trends: trendsRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WABA account health from Meta
router.get('/health', async (req, res) => {
  try {
    const health = await WABAService.getAccountHealth();
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
