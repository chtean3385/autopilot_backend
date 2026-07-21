const express = require('express');
const pool = require('../config/db');
const EmailSenderService = require('../services/emailSenderService');
const SuppressionService = require('../services/suppressionService');
const { logAgentAction } = require('../services/replyDeliveryService');
const PlaybookService = require('../services/playbookService');
const { escapeHtml, unsubscribeFooterHtml, renderEmailBody } = require('../utils/emailRender');
const { getBackendUrl } = require('../utils/backendUrlConfig');
const { generateTrackingToken, buildPixelUrl, buildClickUrl } = require('../utils/emailTracking');
const { getThreadHeaders } = require('../utils/emailThreading');

const router = express.Router();

async function getApproval(approvalId) {
  const result = await pool.query(
    `SELECT pa.*, hl.hotel_name, hl.email AS lead_email, hl.city
     FROM pending_approvals pa
     JOIN hotel_leads hl ON hl.id = pa.lead_id
     WHERE pa.id = $1`,
    [approvalId]
  );
  return result.rows[0] || null;
}

async function getLeadSequence(leadId) {
  const result = await pool.query(
    `SELECT ls.*, s.initial_gaps, s.recurring_interval_days
     FROM lead_sequences ls
     JOIN sequences s ON s.id = ls.sequence_id
     WHERE ls.lead_id = $1
     ORDER BY ls.updated_at DESC
     LIMIT 1`,
    [leadId]
  );
  return result.rows[0] || null;
}

function computeNextRunAt(currentStep, leadSeq) {
  const gaps = typeof leadSeq.initial_gaps === 'string'
    ? JSON.parse(leadSeq.initial_gaps || '[]')
    : (leadSeq.initial_gaps || []);
  const gapDays = currentStep < gaps.length
    ? Number(gaps[currentStep])
    : Number(leadSeq.recurring_interval_days || 7);
  return { nextRunAt: new Date(Date.now() + gapDays * 86400000), gapsLength: gaps.length };
}

// Resumes a lead_sequence: 'estimate' approvals/rejections force the recurring cadence
// (the plan's step is done, so initial gaps no longer apply); replies just reschedule normally.
async function resumeLeadSequence(leadSeq, { forceRecurring } = {}) {
  if (!leadSeq) return;
  const step = forceRecurring ? Math.max(leadSeq.current_step, computeNextRunAt(0, leadSeq).gapsLength) : leadSeq.current_step;
  const { nextRunAt } = computeNextRunAt(step, leadSeq);
  await pool.query(
    `UPDATE lead_sequences
     SET status = 'active', current_step = $1, next_run_at = $2, paused_reason = NULL, updated_at = NOW()
     WHERE id = $3`,
    [step, nextRunAt, leadSeq.id]
  );
}

function buildEstimateHtml(lead, lineItems, total, notes) {
  const rows = lineItems.map(li => `<tr>
    <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(li.description)}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${Number(li.quantity)}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">₹${Number(li.unit_price).toFixed(2)}</td>
    <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">₹${(Number(li.quantity) * Number(li.unit_price)).toFixed(2)}</td>
  </tr>`).join('\n');

  return `<p>Hi ${escapeHtml(lead.hotel_name || '')},</p>
<p>Thanks for your interest — here's the estimate you asked for:</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
  <thead><tr style="background:#f5f5f5">
    <th style="padding:8px;text-align:left">Description</th>
    <th style="padding:8px;text-align:center">Qty</th>
    <th style="padding:8px;text-align:right">Unit Price</th>
    <th style="padding:8px;text-align:right">Line Total</th>
  </tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr>
    <td colspan="3" style="padding:8px;text-align:right;font-weight:600">Total</td>
    <td style="padding:8px;text-align:right;font-weight:600">₹${total.toFixed(2)}</td>
  </tr></tfoot>
</table>
${notes ? `<p>${escapeHtml(notes).replace(/\n/g, '<br>')}</p>` : ''}
<p>Let us know if you'd like any changes, and we'll get started right away.</p>`;
}

function buildEstimateText(lead, lineItems, total, notes) {
  const rows = lineItems
    .map(li => `- ${li.description} x${li.quantity} @ ₹${Number(li.unit_price).toFixed(2)} = ₹${(Number(li.quantity) * Number(li.unit_price)).toFixed(2)}`)
    .join('\n');
  return `Hi ${lead.hotel_name || ''},\n\nThanks for your interest — here's the estimate you asked for:\n\n${rows}\n\nTotal: ₹${total.toFixed(2)}\n${notes ? `\n${notes}\n` : ''}\nLet us know if you'd like any changes, and we'll get started right away.`;
}

// List every pending_approvals row (estimate + low_score_reply) with lead info and any saved estimate draft
router.get('/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pa.*, hl.hotel_name, hl.email AS lead_email, hl.city,
              e.id AS estimate_id, e.line_items, e.total, e.status AS estimate_status
       FROM pending_approvals pa
       JOIN hotel_leads hl ON hl.id = pa.lead_id
       LEFT JOIN estimates e ON e.approval_id = pa.id
       WHERE pa.status = 'pending'
       ORDER BY pa.created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save/update the line-item draft for an estimate approval (owner edits before sending)
router.put('/:approvalId/draft', async (req, res) => {
  try {
    const approval = await getApproval(req.params.approvalId);
    if (!approval) return res.status(404).json({ success: false, error: 'Approval not found' });
    if (approval.type !== 'estimate') return res.status(400).json({ success: false, error: 'Not an estimate approval' });

    const lineItems = Array.isArray(req.body.line_items) ? req.body.line_items : [];
    if (lineItems.some(li => !li.description || Number(li.unit_price) < 0 || Number(li.quantity) <= 0)) {
      return res.status(400).json({ success: false, error: 'Each line item needs a description, quantity > 0, and a non-negative unit price' });
    }

    const total = lineItems.reduce((sum, li) => sum + Number(li.quantity) * Number(li.unit_price), 0);
    const notes = req.body.notes || '';
    const html = buildEstimateHtml(approval, lineItems, total, notes);

    const existing = await pool.query('SELECT id FROM estimates WHERE approval_id = $1', [approval.id]);
    let estimate;
    if (existing.rows[0]) {
      const result = await pool.query(
        `UPDATE estimates SET line_items = $1, total = $2, html = $3 WHERE approval_id = $4 RETURNING *`,
        [JSON.stringify(lineItems), total, html, approval.id]
      );
      estimate = result.rows[0];
    } else {
      const result = await pool.query(
        `INSERT INTO estimates (lead_id, approval_id, line_items, total, html, status)
         VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING *`,
        [approval.lead_id, approval.id, JSON.stringify(lineItems), total, html]
      );
      estimate = result.rows[0];
    }

    res.json({ success: true, estimate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Approve a pending approval: sends the estimate (or the queued draft reply) and resumes the sequence
router.post('/:approvalId/approve', async (req, res) => {
  try {
    const approval = await getApproval(req.params.approvalId);
    if (!approval) return res.status(404).json({ success: false, error: 'Approval not found' });
    if (approval.status !== 'pending') return res.status(400).json({ success: false, error: `Already ${approval.status}` });

    const sender = await EmailSenderService.getSenderForLead(approval.lead_id);
    if (!sender) return res.status(400).json({ success: false, error: 'No active email sender available to send from' });

    const unsubscribeUrl = `${getBackendUrl()}/unsubscribe?token=${SuppressionService.generateToken(approval.lead_email)}`;
    const leadSeq = await getLeadSequence(approval.lead_id);
    const trackingToken = generateTrackingToken();
    const tracking = { pixelUrl: buildPixelUrl(trackingToken), trackUrl: (url) => buildClickUrl(trackingToken, url) };

    let subject, html, text, actionLabel, threadInReplyTo;

    if (approval.type === 'estimate') {
      const estimateResult = await pool.query('SELECT * FROM estimates WHERE approval_id = $1', [approval.id]);
      const estimate = estimateResult.rows[0];
      const lineItems = estimate ? (typeof estimate.line_items === 'string' ? JSON.parse(estimate.line_items) : estimate.line_items) : [];
      if (!estimate || lineItems.length === 0) {
        return res.status(400).json({ success: false, error: 'Add at least one line item before approving' });
      }
      const payload = typeof approval.payload === 'string' ? JSON.parse(approval.payload || '{}') : (approval.payload || {});
      subject = payload.subject ? `Re: ${payload.subject.replace(/^re:\s*/i, '')}` : 'Your estimate from Dreams Technology';
      html = `${buildEstimateHtml(approval, lineItems, Number(estimate.total), req.body.notes)}\n${unsubscribeFooterHtml(unsubscribeUrl, tracking.pixelUrl)}`;
      text = `${buildEstimateText(approval, lineItems, Number(estimate.total), req.body.notes)}\n\n—\nDreams Technology\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`;
      actionLabel = 'estimate_sent';
      threadInReplyTo = payload.inReplyTo || null;
    } else if (approval.type === 'low_score_reply') {
      const payload = typeof approval.payload === 'string' ? JSON.parse(approval.payload || '{}') : (approval.payload || {});
      const draftText = req.body.draft_text || payload.draftText;
      if (!draftText) return res.status(400).json({ success: false, error: 'No draft text to send' });
      // Owner edited the queued draft before sending — a real before/after correction signal
      if (req.body.draft_text && req.body.draft_text !== payload.draftText) {
        await PlaybookService.captureCorrection({ leadId: approval.lead_id, before: payload.draftText, after: draftText });
      }
      const rendered = renderEmailBody(draftText, unsubscribeUrl, tracking);
      subject = payload.subject ? (/^re:/i.test(payload.subject) ? payload.subject : `Re: ${payload.subject}`) : 'Re: your message';
      html = rendered.html;
      text = rendered.text;
      actionLabel = 'draft_sent';
      threadInReplyTo = payload.inReplyTo || null;
    } else {
      return res.status(400).json({ success: false, error: `Unsupported approval type: ${approval.type}` });
    }

    // Older pending rows predate the inReplyTo payload field — getThreadHeaders then falls
    // back to the lead's latest logged message, which still threads the conversation sanely.
    const thread = await getThreadHeaders(approval.lead_id, threadInReplyTo);

    const sendResult = await EmailSenderService.send(sender, {
      to: approval.lead_email, subject, html, text,
      unsubscribeUrl, inReplyTo: thread.inReplyTo, references: thread.references,
    });
    if (!sendResult.success) {
      return res.status(502).json({ success: false, error: sendResult.error });
    }

    await pool.query(
      `INSERT INTO email_logs (lead_id, sender_id, sequence_id, direction, subject, body, provider_message_id, tracking_token, sent_at)
       VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, NOW())`,
      [approval.lead_id, sender.id, leadSeq?.sequence_id || null, subject, html, sendResult.messageId, trackingToken]
    );

    if (approval.type === 'estimate') {
      await pool.query(`UPDATE estimates SET status = 'sent' WHERE approval_id = $1`, [approval.id]);
    }
    await pool.query(
      `UPDATE pending_approvals SET status = 'approved', decided_at = NOW() WHERE id = $1`,
      [approval.id]
    );
    await resumeLeadSequence(leadSeq, { forceRecurring: approval.type === 'estimate' });
    await logAgentAction(approval.lead_id, actionLabel, { detail: { subject }, draftText: text, decision: 'send' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reject a pending approval without sending anything; estimate rejections still resume the sequence
router.post('/:approvalId/reject', async (req, res) => {
  try {
    const approval = await getApproval(req.params.approvalId);
    if (!approval) return res.status(404).json({ success: false, error: 'Approval not found' });
    if (approval.status !== 'pending') return res.status(400).json({ success: false, error: `Already ${approval.status}` });

    await pool.query(
      `UPDATE pending_approvals SET status = 'rejected', note = $1, decided_at = NOW() WHERE id = $2`,
      [req.body.note || null, approval.id]
    );

    if (approval.type === 'estimate') {
      const leadSeq = await getLeadSequence(approval.lead_id);
      await resumeLeadSequence(leadSeq, { forceRecurring: true });
    } else if (approval.type === 'low_score_reply') {
      const payload = typeof approval.payload === 'string' ? JSON.parse(approval.payload || '{}') : (approval.payload || {});
      await PlaybookService.captureCorrection({ leadId: approval.lead_id, before: payload.draftText, after: null });
    }

    await logAgentAction(approval.lead_id, `${approval.type}_rejected`, { detail: { note: req.body.note || null }, decision: 'reject' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
