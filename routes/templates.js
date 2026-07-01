const express = require('express');
const TemplateService = require('../services/templateService');
const WABAService = require('../services/wabaService');
const pool = require('../config/db');
const router = express.Router();

// Diagnostic: show which Meta WABA account is connected
router.get('/waba-info', async (req, res) => {
  const axios = require('axios');
  const wabaId = process.env.WABA_BUSINESS_ACCOUNT_ID;
  const token = process.env.WABA_API_TOKEN;
  const version = process.env.WABA_API_VERSION || 'v18.0';
  try {
    const r = await axios.get(
      `https://graph.facebook.com/${version}/${wabaId}`,
      { params: { fields: 'name,currency,timezone_id,phone_numbers', access_token: token } }
    );
    res.json({ env_waba_id: wabaId, meta_response: r.data });
  } catch (err) {
    res.status(500).json({ env_waba_id: wabaId, error: err.response?.data || err.message });
  }
});

// Get all templates
router.get('/', async (req, res) => {
  const templates = await TemplateService.getAllTemplates();
  res.json(templates);
});

// Create template locally (status = draft)
router.post('/', async (req, res) => {
  const result = await TemplateService.createTemplate(req.body);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Submit template to Meta for approval
router.post('/:id/submit-meta', async (req, res) => {
  try {
    const tplResult = await pool.query('SELECT * FROM waba_templates WHERE id = $1', [req.params.id]);
    const template = tplResult.rows[0];
    if (!template) return res.status(404).json({ error: 'Template not found' });

    // template.examples is already parsed by pg driver — do NOT JSON.parse again
    const savedExamples = Array.isArray(template.examples) ? template.examples
      : (template.examples ? JSON.parse(template.examples) : []);
    const examples = req.body.examples || savedExamples;
    const result = await WABAService.submitTemplateToMeta({ ...template, examples });

    if (result.success) {
      const metaId = String(result.data?.id || '');
      await pool.query(
        `UPDATE waba_templates
         SET status = 'pending_approval',
             meta_template_id = COALESCE($1, meta_template_id),
             updated_at = NOW()
         WHERE id = $2`,
        [metaId || null, req.params.id]
      );
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync approval status from Meta for one template
router.post('/:id/sync-status', async (req, res) => {
  try {
    const tplResult = await pool.query('SELECT * FROM waba_templates WHERE id = $1', [req.params.id]);
    const template = tplResult.rows[0];
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const result = await WABAService.syncTemplateStatus(template.template_name);

    if (result.success) {
      await pool.query(
        `UPDATE waba_templates
         SET status = $1,
             meta_template_id = COALESCE($2, meta_template_id),
             updated_at = NOW()
         WHERE id = $3`,
        [result.status, result.meta_id || null, req.params.id]
      );
      result.updated_status = result.status;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync all non-draft templates from Meta at once
router.post('/sync-all', async (req, res) => {
  try {
    const tplResult = await pool.query(
      `SELECT * FROM waba_templates WHERE status != 'draft' ORDER BY id`
    );
    const templates = tplResult.rows;
    const results = [];

    for (const t of templates) {
      const sync = await WABAService.syncTemplateStatus(t.template_name);
      if (sync.success) {
        await pool.query(
          `UPDATE waba_templates
           SET status = $1,
               meta_template_id = COALESCE($2, meta_template_id),
               updated_at = NOW()
           WHERE id = $3`,
          [sync.status, sync.meta_id || null, t.id]
        );
        results.push({ id: t.id, name: t.template_name, status: sync.status, meta_status: sync.meta_status });
      } else {
        results.push({ id: t.id, name: t.template_name, error: sync.error });
      }
    }

    res.json({ success: true, synced: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deactivate template — marks as paused locally (safe, reversible; does NOT delete from Meta)
router.post('/:id/deactivate', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE waba_templates SET status = 'paused', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reactivate a paused template (marks back to approved locally)
router.post('/:id/reactivate', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE waba_templates SET status = 'approved', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete template — removes from DB; if it was submitted to Meta, also deletes from Meta
router.delete('/:id', async (req, res) => {
  try {
    const tplResult = await pool.query('SELECT * FROM waba_templates WHERE id = $1', [req.params.id]);
    const template = tplResult.rows[0];
    if (!template) return res.status(404).json({ error: 'Template not found' });

    let metaDeleted = false;
    // Only attempt Meta deletion if it was ever submitted (has meta_template_id or not draft)
    if (template.status !== 'draft' && template.template_name) {
      const delResult = await WABAService.deleteFromMeta(template.template_name);
      metaDeleted = delResult.success;
      if (!delResult.success) {
        console.warn(`[Templates] Meta delete failed for "${template.template_name}": ${delResult.error}`);
      }
    }

    await pool.query('DELETE FROM waba_templates WHERE id = $1', [req.params.id]);
    res.json({ success: true, metaDeleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update template status manually
router.put('/:id/status', async (req, res) => {
  const { status } = req.body;
  const result = await TemplateService.updateTemplateStatus(req.params.id, status);
  res.json(result);
});

module.exports = router;
