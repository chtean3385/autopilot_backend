const express = require('express');
const pool = require('../config/db');
const { runCadence, loadConfig } = require('../services/cadenceService');
const { stopCadence } = require('../services/cadenceReplyService');
const TemplatePool = require('../services/templatePoolService');
const { getHealth } = require('../services/cadenceHealthService');
const router = express.Router();

// Directory outreach cadence (_docs/directory-outreach-plan.md) — status + manual controls.

router.get('/summary', async (req, res) => {
  try {
    const [cfg, byStatus, today, waiting] = await Promise.all([
      loadConfig(),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM lead_cadence GROUP BY status`),
      pool.query(
        `WITH d AS (SELECT (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::timestamp AS t)
         SELECT
           (SELECT COUNT(*)::int FROM email_logs el JOIN hotel_leads hl ON hl.id = el.lead_id, d
              WHERE hl.cadence_managed AND el.direction = 'out' AND el.error IS NULL AND el.sent_at >= d.t) AS emails_today,
           (SELECT COUNT(*)::int FROM outreach_logs ol JOIN hotel_leads hl ON hl.id = ol.lead_id, d
              WHERE hl.cadence_managed AND ol.message_type = 'template' AND ol.sent_at >= d.t) AS whatsapp_today,
           (SELECT COUNT(*)::int FROM lead_cadence lc, d WHERE lc.started_at >= d.t AND lc.first_channel = 'email') AS new_email_today,
           (SELECT COUNT(*)::int FROM lead_cadence lc, d WHERE lc.started_at >= d.t AND lc.first_channel = 'whatsapp') AS new_whatsapp_today`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM hotel_leads hl LEFT JOIN lead_cadence lc ON lc.lead_id = hl.id
         WHERE hl.cadence_managed AND lc.lead_id IS NULL AND hl.status = 'new'`
      ),
    ]);
    res.json({
      config: cfg,
      byStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])),
      today: today.rows[0],
      notStarted: waiting.rows[0].n,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health', async (req, res) => {
  try {
    res.json(await getHealth());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual run: bypasses the send window (not CADENCE_ENABLED — off means off).
router.post('/run', async (req, res) => {
  try {
    res.json({ success: true, stats: await runCadence('manual') });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/leads/:leadId/stop', async (req, res) => {
  try {
    await stopCadence(parseInt(req.params.leadId, 10), 'stopped', 'owner_stopped');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Directory WhatsApp template pool (industry = 'directory').
router.get('/templates', async (req, res) => {
  try {
    res.json({ ...(await TemplatePool.poolStatus()), lastRun: await TemplatePool.lastRun(), running: TemplatePool.isRunning() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top up now (seeds first, then GPT drafts). Submits to Meta only if WA_TEMPLATE_AUTO_SUBMIT=true.
router.post('/templates/ensure', async (req, res) => {
  try {
    res.json({ success: true, ...(await TemplatePool.ensurePool()) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Owner-triggered: submit every directory draft to Meta for approval.
router.post('/templates/submit', async (req, res) => {
  try {
    res.json({ success: true, results: await TemplatePool.submitDrafts() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
