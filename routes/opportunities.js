// Opportunity Hunter API (_docs/opportunity-hunter.md) — the Opportunities page.
const express = require('express');
const pool = require('../config/db');
const { getSetting, setSetting } = require('../services/settingsService');
const hunter = require('../services/opportunityHunterService');
const reader = require('../services/waGroupReaderService');

const router = express.Router();
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { res.status(500).json({ error: err.message }); }
};

// Tabs: drafts (email to review) · manual (phone only — copy & send yourself) · sent (incl. replied) · skipped
const TAB_WHERE = {
  drafts: `status IN ('draft', 'sending', 'failed')`,
  manual: `status IN ('manual', 'manual_sent')`,
  sent: `status IN ('sent', 'replied')`,
  skipped: `status IN ('skipped', 'rejected')`,
};

router.get('/', wrap(async (req, res) => {
  const where = (TAB_WHERE[req.query.tab] || TAB_WHERE.drafts).replace(/\bstatus\b/g, 'o.status');
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 200, 500);
  const { rows } = await pool.query(
    `SELECT o.*, es.label AS sender_label, es.from_email AS sender_email
     FROM opportunities o LEFT JOIN email_senders es ON es.id = o.sender_id
     WHERE ${where} ORDER BY (o.status = 'replied') DESC, COALESCE(o.sent_at, o.created_at) DESC LIMIT $1`, [limit]);
  res.json(rows);
}));

router.get('/summary', wrap(async (req, res) => {
  const today = `(date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AT TIME ZONE 'UTC')`;
  const counts = (await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE ${TAB_WHERE.drafts})::int AS drafts,
       COUNT(*) FILTER (WHERE status = 'manual')::int AS manual,
       COUNT(*) FILTER (WHERE ${TAB_WHERE.sent})::int AS sent,
       COUNT(*) FILTER (WHERE status = 'replied')::int AS replied,
       COUNT(*) FILTER (WHERE ${TAB_WHERE.skipped})::int AS skipped,
       COUNT(*) FILTER (WHERE sent_at >= ${today})::int AS sent_today
     FROM opportunities`)).rows[0];
  const posts = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE created_at >= ${today})::int AS today,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS waiting
     FROM opportunity_messages`)).rows[0];
  res.json({ ...counts, posts_today: posts.today, posts_waiting: posts.waiting });
}));

// Mailbox (picked once), mode, caps.
router.get('/config', wrap(async (req, res) => {
  const senders = (await pool.query(
    `SELECT id, label, from_email, status, daily_cap, sent_today,
            (imap_config IS NOT NULL AND COALESCE(imap_config::jsonb->>'host', '') <> '') AS has_imap
     FROM email_senders ORDER BY id`)).rows;
  res.json({
    sender_id: Number(await getSetting('OPP_HUNTER_SENDER_ID')) || null,
    mode: String((await getSetting('OPP_HUNTER_MODE')) || 'draft').toLowerCase() === 'auto' ? 'auto' : 'draft',
    daily_cap: Number(await getSetting('OPP_HUNTER_DAILY_CAP')) || 20,
    min_score: Number.parseInt(await getSetting('OPP_HUNTER_MIN_SCORE'), 10) || 55,
    senders,
  });
}));

router.put('/config', wrap(async (req, res) => {
  const { sender_id, mode, daily_cap, min_score } = req.body || {};
  if (sender_id !== undefined) {
    const s = (await pool.query(`SELECT id FROM email_senders WHERE id = $1`, [sender_id])).rows[0];
    if (!s) return res.status(400).json({ error: 'Unknown mailbox' });
    await setSetting('OPP_HUNTER_SENDER_ID', String(s.id));
  }
  if (mode !== undefined) {
    if (!['draft', 'auto'].includes(mode)) return res.status(400).json({ error: 'mode must be draft or auto' });
    if (mode === 'auto' && !(await getSetting('OPP_HUNTER_SENDER_ID'))) return res.status(400).json({ error: 'Pick the mailbox first' });
    await setSetting('OPP_HUNTER_MODE', mode);
  }
  if (daily_cap !== undefined) await setSetting('OPP_HUNTER_DAILY_CAP', String(Math.max(1, Math.min(200, Number(daily_cap) || 20))));
  if (min_score !== undefined) await setSetting('OPP_HUNTER_MIN_SCORE', String(Math.max(0, Math.min(100, Number(min_score) || 55))));
  res.json({ ok: true });
}));

// Paste a post (also how forwarded posts / testing work) → analysed now.
router.post('/analyze', wrap(async (req, res) => {
  try {
    res.json(await hunter.analyzeText(req.body?.text));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

router.put('/:id', wrap(async (req, res) => {
  const { draft_subject, draft_body, wa_draft } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE opportunities SET
       draft_subject = COALESCE($2, draft_subject), draft_body = COALESCE($3, draft_body), wa_draft = COALESCE($4, wa_draft),
       draft_warning = CASE WHEN $2::text IS NOT NULL OR $3::text IS NOT NULL THEN NULL ELSE draft_warning END, -- owner edited = owner approved
       updated_at = NOW()
     WHERE id = $1 AND status IN ('draft', 'failed', 'manual') RETURNING *`,
    [req.params.id, draft_subject ?? null, draft_body ?? null, wa_draft ?? null]);
  if (!rows[0]) return res.status(409).json({ error: 'Already sent — can no longer be edited' });
  res.json(rows[0]);
}));

router.post('/:id/send', wrap(async (req, res) => {
  const r = await hunter.sendOpportunity(Number(req.params.id), { trigger: 'manual' });
  res.status(r.ok ? 200 : 400).json(r);
}));

router.post('/:id/reject', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE opportunities SET status = 'rejected', skip_reason = COALESCE(skip_reason, 'Rejected by you'), updated_at = NOW()
     WHERE id = $1 AND status IN ('draft', 'failed', 'manual') RETURNING id`, [req.params.id]);
  res.status(rows[0] ? 200 : 409).json(rows[0] ? { ok: true } : { error: 'Cannot reject — already sent' });
}));

// Skipped post the owner wants anyway → back to a draft (email) or manual message (phone).
router.post('/:id/restore', wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM opportunities WHERE id = $1 AND status IN ('skipped', 'rejected')`, [req.params.id]);
  const o = rows[0];
  if (!o) return res.status(409).json({ error: 'Only skipped posts can be restored' });
  if (!o.email && !o.phone) return res.status(400).json({ error: 'This post has no email or phone number' });
  await pool.query(`DELETE FROM opportunities WHERE id = $1`, [o.id]);
  // Re-run as if the AI had said "apply": force through the pipeline without the skip rules.
  const msg = (await pool.query(`SELECT * FROM opportunity_messages WHERE id = $1`, [o.message_id])).rows[0];
  if (!msg) return res.status(400).json({ error: 'Original post is gone' });
  const r = await hunter.analyzeMessage({ ...msg, forceApply: true });
  res.json({ ok: true, opportunity: r.opportunityId ? await hunter.getById(r.opportunityId) : null });
}));

router.post('/:id/manual-sent', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE opportunities SET status = 'manual_sent', wa_sent_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'manual' RETURNING id`, [req.params.id]);
  res.status(rows[0] ? 200 : 409).json(rows[0] ? { ok: true } : { error: 'Not a pending WhatsApp message' });
}));

router.post('/:id/manual-undo', wrap(async (req, res) => {
  await pool.query(`UPDATE opportunities SET status = 'manual', wa_sent_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'manual_sent'`, [req.params.id]);
  res.json({ ok: true });
}));

// ── Sources + reader ────────────────────────────────────────────────────────────────────────────

router.get('/sources', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*,
       (SELECT COUNT(*)::int FROM opportunity_messages m WHERE m.source_id = s.id) AS posts,
       (SELECT COUNT(*)::int FROM opportunity_messages m JOIN opportunities o ON o.message_id = m.id
         WHERE m.source_id = s.id AND o.status NOT IN ('skipped', 'rejected')) AS opportunities
     FROM opportunity_sources s ORDER BY s.created_at DESC`);
  res.json(rows);
}));

router.post('/sources', wrap(async (req, res) => {
  const links = String(req.body?.links || req.body?.link || '').split(/[\s,]+/).filter(Boolean);
  if (!links.length) return res.status(400).json({ error: 'Paste at least one link' });
  const added = [];
  const errors = [];
  for (const l of links) {
    try { added.push(await reader.addSource(l)); } catch (err) { errors.push(`${l}: ${err.message}`); }
  }
  res.status(added.length ? 200 : 400).json({ added: added.length, errors, ...(added.length ? {} : { error: errors.join('; ') }) });
}));

router.patch('/sources/:id', wrap(async (req, res) => {
  const { active } = req.body || {};
  await pool.query(`UPDATE opportunity_sources SET active = $2 WHERE id = $1`, [req.params.id, !!active]);
  res.json({ ok: true });
}));

router.post('/sources/:id/retry', wrap(async (req, res) => {
  await pool.query(`UPDATE opportunity_sources SET status = 'pending', error = NULL WHERE id = $1`, [req.params.id]);
  reader.joinPending().catch(() => {});
  res.json({ ok: true });
}));

// Stops watching (stays a member on the phone — leave the group there if you want).
router.delete('/sources/:id', wrap(async (req, res) => {
  await pool.query(`DELETE FROM opportunity_sources WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

router.get('/reader', wrap(async (req, res) => res.json(reader.getStatus())));
router.post('/reader/connect', wrap(async (req, res) => res.json(await reader.start())));
router.post('/reader/disconnect', wrap(async (req, res) => res.json(await reader.stop({ logOut: !!req.body?.logout }))));
router.post('/reader/import-groups', wrap(async (req, res) => {
  try { res.json(await reader.importJoinedGroups()); } catch (err) { res.status(400).json({ error: err.message }); }
}));

module.exports = router;
