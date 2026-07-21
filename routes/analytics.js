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

// Email channel analytics: per-sender-domain health, per-sequence funnel, agent activity feed
router.get('/email', async (req, res) => {
  try {
    const [senderHealthRes, sequenceFunnelRes, activityFeedRes] = await Promise.all([
      pool.query(`
        SELECT
          es.id, es.label, es.from_email, es.sending_domain, es.provider, es.status,
          COUNT(*) FILTER (WHERE el.direction = 'out')::int                              AS sent,
          COUNT(*) FILTER (WHERE el.direction = 'out' AND el.error IS NULL)::int          AS delivered,
          COUNT(*) FILTER (WHERE el.direction = 'out' AND el.opened_at IS NOT NULL)::int  AS opened,
          COUNT(*) FILTER (WHERE el.direction = 'in')::int                                AS replied,
          COUNT(*) FILTER (WHERE el.direction = 'out' AND el.bounced_at IS NOT NULL)::int AS bounced
        FROM email_senders es
        LEFT JOIN email_logs el ON el.sender_id = es.id
        GROUP BY es.id, es.label, es.from_email, es.sending_domain, es.provider, es.status
        ORDER BY es.created_at DESC
      `),
      pool.query(`
        WITH log_stats AS (
          SELECT sequence_id,
            COUNT(*) FILTER (WHERE direction = 'out')::int                     AS sent,
            COUNT(*) FILTER (WHERE direction = 'out' AND error IS NULL)::int   AS delivered,
            COUNT(*) FILTER (WHERE direction = 'in')::int                      AS replied
          FROM email_logs
          GROUP BY sequence_id
        ),
        enrollment_stats AS (
          SELECT sequence_id,
            COUNT(DISTINCT lead_id)::int                                          AS leads_enrolled,
            COUNT(DISTINCT lead_id) FILTER (WHERE status = 'dead')::int           AS dead,
            COUNT(DISTINCT lead_id) FILTER (WHERE status = 'waiting_estimate')::int AS waiting_estimate
          FROM lead_sequences
          GROUP BY sequence_id
        )
        SELECT
          s.id, s.name, s.active, s.daily_send_limit, s.recurring_interval_days,
          COALESCE(en.leads_enrolled, 0)   AS leads_enrolled,
          COALESCE(en.dead, 0)             AS dead,
          COALESCE(en.waiting_estimate, 0) AS waiting_estimate,
          COALESCE(ls.sent, 0)             AS sent,
          COALESCE(ls.delivered, 0)        AS delivered,
          COALESCE(ls.replied, 0)          AS replied
        FROM sequences s
        LEFT JOIN log_stats ls ON ls.sequence_id = s.id
        LEFT JOIN enrollment_stats en ON en.sequence_id = s.id
        ORDER BY s.created_at DESC
      `),
      pool.query(`
        SELECT aa.id, aa.lead_id, aa.action, aa.detail, aa.score, aa.decision, aa.created_at, hl.hotel_name
        FROM agent_actions aa
        LEFT JOIN hotel_leads hl ON hl.id = aa.lead_id
        ORDER BY aa.created_at DESC
        LIMIT 50
      `),
    ]);

    res.json({
      senderHealth: senderHealthRes.rows,
      sequenceFunnel: sequenceFunnelRes.rows,
      activityFeed: activityFeedRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GPT usage/billing rollups from ai_usage_logs (written by utils/aiUsage.js trackedCompletion).
// cost_usd can be NULL for models missing from the pricing map — SUM() skips NULLs, so totals
// are "cost of priced calls"; token counts are always complete.
router.get('/ai-usage', async (req, res) => {
  try {
    const [totalsRes, byPurposeRes, byModelRes, byDayRes, recentRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int                                                        AS calls,
          COALESCE(SUM(prompt_tokens), 0)::bigint                              AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint                          AS completion_tokens,
          COALESCE(SUM(total_tokens), 0)::bigint                               AS total_tokens,
          SUM(cost_usd)                                                        AS cost_usd,
          ROUND(AVG(duration_ms))::int                                         AS avg_duration_ms,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS calls_30d,
          SUM(cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS cost_usd_30d,
          COALESCE(SUM(total_tokens) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::bigint AS total_tokens_30d
        FROM ai_usage_logs
      `),
      pool.query(`
        SELECT purpose,
          COUNT(*)::int                               AS calls,
          COALESCE(SUM(prompt_tokens), 0)::bigint     AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
          SUM(cost_usd)                               AS cost_usd,
          ROUND(AVG(duration_ms))::int                AS avg_duration_ms
        FROM ai_usage_logs
        GROUP BY purpose
        ORDER BY SUM(cost_usd) DESC NULLS LAST
      `),
      pool.query(`
        SELECT model,
          COUNT(*)::int                               AS calls,
          COALESCE(SUM(prompt_tokens), 0)::bigint     AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
          SUM(cost_usd)                               AS cost_usd,
          ROUND(AVG(duration_ms))::int                AS avg_duration_ms
        FROM ai_usage_logs
        GROUP BY model
        ORDER BY SUM(cost_usd) DESC NULLS LAST
      `),
      pool.query(`
        SELECT DATE(created_at) AS day, COUNT(*)::int AS calls, SUM(cost_usd) AS cost_usd
        FROM ai_usage_logs
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY day DESC
      `),
      pool.query(`
        SELECT u.id, u.purpose, u.model, u.prompt_tokens, u.completion_tokens, u.total_tokens,
               u.cost_usd, u.duration_ms, u.created_at, hl.hotel_name
        FROM ai_usage_logs u
        LEFT JOIN hotel_leads hl ON hl.id = u.lead_id
        ORDER BY u.created_at DESC
        LIMIT 50
      `),
    ]);

    res.json({
      totals: totalsRes.rows[0],
      byPurpose: byPurposeRes.rows,
      byModel: byModelRes.rows,
      byDay: byDayRes.rows,
      recent: recentRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
