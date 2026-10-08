const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const TemplateService = require('../services/templateService');
const WABAService = require('../services/wabaService');
const pool = require('../config/db');
const router = express.Router();

// Template header images. Stored outside git under backend/uploads/ — the deploy does
// `git reset --hard`, which only removes *tracked* files, so this dir survives every deploy.
// Served back through this same /api/templates/image/ path so no nginx change is needed; the
// URL must be publicly reachable because Meta fetches it at template-submit and send time.
const TEMPLATE_IMG_DIR = path.join(__dirname, '..', 'uploads', 'template-images');
fs.mkdirSync(TEMPLATE_IMG_DIR, { recursive: true });

const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png' };
const TYPE_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png' };
const imgUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // Meta's cap for template header images
  fileFilter: (req, file, cb) =>
    EXT_BY_MIME[file.mimetype] ? cb(null, true) : cb(new Error('Only JPG or PNG images are allowed.')),
});

// Served at /api/templates/media/<id> — deliberately NO file extension in the URL, because
// nginx's `location ~* \.(png|jpg|...)$` regex block would otherwise intercept the request
// before it ever reaches this backend (regex locations beat the /api/ prefix). Content-Type
// is set explicitly here from the stored file's extension, which is all Meta needs.
router.get('/media/:id', (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-z0-9_]+$/i.test(id)) return res.status(400).end();
  for (const ext of ['.png', '.jpg']) {
    const p = path.join(TEMPLATE_IMG_DIR, id + ext);
    if (fs.existsSync(p)) {
      res.type(TYPE_BY_EXT[ext]);
      res.set('Cache-Control', 'public, max-age=2592000, immutable');
      return res.sendFile(p);
    }
  }
  res.status(404).end();
});

// POST /api/templates/upload-image  (multipart, field "image")
// → { url } — a permanent public link to drop into a template's Header Image.
router.post('/upload-image', (req, res) => {
  imgUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
    try {
      const id = `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      fs.writeFileSync(path.join(TEMPLATE_IMG_DIR, id + EXT_BY_MIME[req.file.mimetype]), req.file.buffer);
      const base = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
      const url = base ? `${base}/api/templates/media/${id}` : `/api/templates/media/${id}`;
      res.json({ url });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

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

// Sync every template with Meta in one pass (Meta's full list, exact name match). A template we submitted
// that Meta no longer has (deleted in WhatsApp Manager) is removed here too (owner, 2026-10-08); its old
// campaign/outreach/task rows keep their history with template_id cleared. Drafts were never on Meta and
// are left alone. If Meta's list can't be fetched, nothing is changed or removed.
router.post('/sync-all', async (req, res) => {
  try {
    const onMeta = await WABAService.listAllMetaTemplates();
    const { rows: templates } = await pool.query(`SELECT * FROM waba_templates ORDER BY id`);
    const results = [];
    const gone = [];

    for (const t of templates) {
      const m = onMeta.get(t.template_name);
      if (m && !['DELETED', 'PENDING_DELETION'].includes(m.status)) {
        const status = WABAService.localStatus(m.status);
        await pool.query(
          `UPDATE waba_templates
           SET status = $1::varchar, meta_template_id = COALESCE($2, meta_template_id),
               rejection_reason = CASE WHEN $1::varchar = 'rejected' THEN COALESCE($3, rejection_reason) ELSE rejection_reason END,
               updated_at = NOW()
           WHERE id = $4`,
          [status, String(m.id || '') || null, m.rejected_reason && m.rejected_reason !== 'NONE' ? m.rejected_reason : null, t.id]
        );
        results.push({ id: t.id, name: t.template_name, status, meta_status: m.status });
      } else if (t.status !== 'draft') {
        gone.push(t);
      }
    }

    // Guard: an empty or unrelated list (wrong WABA id/token) would look like "everything was deleted".
    const submitted = templates.filter((t) => t.status !== 'draft').length;
    if (gone.length && onMeta.size === 0) {
      return res.json({ success: true, synced: results.length, results, removed: [],
        warning: `Meta returned no templates at all, so ${gone.length} local template(s) were NOT removed. Check the WABA account settings.` });
    }

    const removed = [];
    for (const t of gone) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const table of ['campaigns', 'outreach_logs', 'agent_tasks']) {
          await client.query(`UPDATE ${table} SET template_id = NULL WHERE template_id = $1`, [t.id]);
        }
        await client.query('DELETE FROM waba_templates WHERE id = $1', [t.id]);
        await client.query('COMMIT');
        removed.push(t.template_name);
      } catch (err) {
        await client.query('ROLLBACK');
        results.push({ id: t.id, name: t.template_name, error: `not on Meta, but could not remove: ${err.message}` });
      } finally {
        client.release();
      }
    }
    if (removed.length) console.log(`[Templates] sync-all removed ${removed.length} template(s) no longer on Meta: ${removed.join(', ')}`);

    res.json({ success: true, synced: results.length, results, removed, submitted });
  } catch (err) {
    res.status(500).json({ error: `Could not read templates from Meta, nothing changed: ${err.response?.data?.error?.message || err.message}` });
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

// Update local fields only (header_image_url, parameter_mapping) — does NOT re-submit to Meta
router.put('/:id/local', async (req, res) => {
  try {
    const { header_image_url, parameter_mapping } = req.body;
    const result = await pool.query(
      `UPDATE waba_templates
       SET header_image_url = $1,
           parameter_mapping = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [header_image_url || null, JSON.stringify(parameter_mapping || {}), req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Template not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
