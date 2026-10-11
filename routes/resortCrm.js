// Resort CRM (Dream Stay) pipeline — /api/resort-crm. See _docs/resort-crm/plan.md.
const express = require('express');
const multer = require('multer');
const { importAdLeads } = require('../services/resortLeadImportService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Upload a Meta lead-ad export. ?dry_run=1 previews (parse + duplicate check) without saving.
// Importing contacts nobody — only the resort pipeline worker messages these leads.
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const dryRun = ['1', 'true'].includes(String(req.query.dry_run || req.body.dry_run || ''));
    res.json({ dry_run: dryRun, ...(await importAdLeads(req.file.buffer, req.file.originalname, { dryRun })) });
  } catch (err) {
    console.error('[ResortCRM Import]', err.message);
    res.status(400).json({ error: err.message || 'Failed to read file.' });
  }
});

const pipeline = require('../services/resortPipelineService');
const pool = require('../config/db');
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (err) { console.error('[ResortCRM]', err.message); res.status(500).json({ error: err.message }); }
};

router.get('/summary', wrap(() => pipeline.summary()));
router.get('/templates', wrap(() => pipeline.templateStatus()));
// Sends the Dream Stay templates to Meta for approval (owner-triggered; Meta answers via the webhook).
router.post('/templates/submit', wrap(() => pipeline.submitTemplates()));
// Pull real status + category from Meta (templates the owner created/edited in Business Manager).
router.post('/templates/sync', wrap(() => pipeline.syncFromMeta()));
// One click: queue the utility enquiry follow-up to every lead not reached yet, gap_minutes apart (default 2).
router.post('/queue', wrap((req) => pipeline.queueAll({ gapMinutes: req.body?.gap_minutes })));
router.post('/queue/cancel', wrap(() => pipeline.cancelQueue()));
// Run one pipeline tick now (skips the send window, still needs RESORT_PIPELINE_ENABLED=true).
router.post('/run', wrap(() => pipeline.runPipeline('manual')));
// Test one lead: send its next WhatsApp now, even with the pipeline switched off.
router.post('/leads/:id/send-now', wrap(async (req) => ({ result: await pipeline.sendNowForLead(Number(req.params.id)) })));

// Leads with their form answers and pipeline state, best first.
router.get('/leads', wrap(async () => (await pool.query(`
  SELECT hl.id, hl.hotel_name, hl.owner_name, hl.city, hl.whatsapp_number, hl.email, hl.status, hl.needs_attention,
         hl.needs_attention_reason, hl.ai_paused, hl.ad_form, hl.created_at,
         rp.status AS pipeline_status, rp.touches, rp.next_touch_at, rp.last_touch_at, rp.last_template,
         rp.demo_slot, rp.demo_at, rp.stop_reason,
         (SELECT MAX(response_received_at) FROM outreach_logs ol WHERE ol.lead_id = hl.id) AS last_reply_at
  FROM hotel_leads hl LEFT JOIN resort_pipeline rp ON rp.lead_id = hl.id
  WHERE hl.pipeline = 'resort_crm'
  ORDER BY (rp.status = 'demo_booked') DESC NULLS LAST, hl.needs_attention DESC,
           (hl.ad_form->>'wants_demo' = 'yes') DESC NULLS LAST, hl.created_at DESC`)).rows));

// Replace the Dream Stay agent's knowledge with data/resort-crm-knowledge.md (after editing that file).
router.post('/agent/sync', async (req, res) => {
  try {
    const { ensureAgent, syncKnowledge } = require('../services/resortCrmAgentService');
    const { agent } = await ensureAgent();
    res.json({ agent_id: agent.id, sections: await syncKnowledge(agent.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
