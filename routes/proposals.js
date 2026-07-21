const express = require('express');
const pool = require('../config/db');
const { getOrCreateResearch } = require('../services/leadResearchService');
const { generateProposal } = require('../services/proposalService');
const EmailSenderService = require('../services/emailSenderService');
const SuppressionService = require('../services/suppressionService');
const { logAgentAction } = require('../services/replyDeliveryService');
const { escapeHtml, unsubscribeFooterHtml } = require('../utils/emailRender');
const { getBackendUrl } = require('../utils/backendUrlConfig');

const router = express.Router();

function parseJsonColumn(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function parseProposalRow(row) {
  return {
    ...row,
    proposal: parseJsonColumn(row.proposal, {}),
    timeline: parseJsonColumn(row.timeline, []),
    quotation: parseJsonColumn(row.quotation, {}),
    architecture: parseJsonColumn(row.architecture, {}),
    current_vs_future: parseJsonColumn(row.current_vs_future, []),
    roi: parseJsonColumn(row.roi, {}),
  };
}

function buildProposalHtml(hotelName, p) {
  const timelineRows = p.timeline
    .map((t) => `<li><strong>${escapeHtml(t.phase)}</strong> (${escapeHtml(t.duration)}) — ${escapeHtml(t.description)}</li>`)
    .join('\n');
  const quotationRows = p.quotation.items
    .map((i) => `<tr><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(i.service)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${escapeHtml(i.price_range)}</td></tr>`)
    .join('\n');
  const architectureRows = p.architecture.components
    .map((c) => `<li><strong>${escapeHtml(c.name)}</strong> — ${escapeHtml(c.description)}</li>`)
    .join('\n');
  const comparisonRows = p.current_vs_future
    .map((r) => `<tr><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(r.area)}</td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(r.current)}</td><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(r.future)}</td></tr>`)
    .join('\n');
  const roiHighlights = p.roi.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('\n');

  return `<p>Hi ${escapeHtml(hotelName || '')},</p>
<h2>${escapeHtml(p.proposal.title)}</h2>
<p>${escapeHtml(p.proposal.summary)}</p>

<h3>Implementation Timeline</h3>
<ul>${timelineRows}</ul>

<h3>Quotation</h3>
<table style="width:100%;border-collapse:collapse;margin:12px 0">
  <thead><tr style="background:#f5f5f5"><th style="padding:8px;text-align:left">Service</th><th style="padding:8px;text-align:right">Estimate</th></tr></thead>
  <tbody>${quotationRows}</tbody>
  <tfoot><tr><td style="padding:8px;text-align:right;font-weight:600">Total</td><td style="padding:8px;text-align:right;font-weight:600">${escapeHtml(p.quotation.total_range)}</td></tr></tfoot>
</table>
<p style="font-size:12px;color:#888">${escapeHtml(p.quotation.note)}</p>

<h3>Proposed Architecture</h3>
<p>${escapeHtml(p.architecture.summary)}</p>
<ul>${architectureRows}</ul>

<h3>Current vs. Future</h3>
<table style="width:100%;border-collapse:collapse;margin:12px 0">
  <thead><tr style="background:#f5f5f5"><th style="padding:8px;text-align:left">Area</th><th style="padding:8px;text-align:left">Today</th><th style="padding:8px;text-align:left">With Dreams Technology</th></tr></thead>
  <tbody>${comparisonRows}</tbody>
</table>

<h3>Expected ROI</h3>
<p>${escapeHtml(p.roi.summary)}</p>
<ul>${roiHighlights}</ul>

<p>Let us know if you'd like to walk through any of this on a call.</p>`;
}

function buildProposalText(hotelName, p) {
  const timeline = p.timeline.map((t) => `- ${t.phase} (${t.duration}): ${t.description}`).join('\n');
  const quotation = p.quotation.items.map((i) => `- ${i.service}: ${i.price_range}`).join('\n');
  const architecture = p.architecture.components.map((c) => `- ${c.name}: ${c.description}`).join('\n');
  const comparison = p.current_vs_future.map((r) => `- ${r.area} — Today: ${r.current} | Future: ${r.future}`).join('\n');
  const roi = p.roi.highlights.map((h) => `- ${h}`).join('\n');

  return `Hi ${hotelName || ''},

${p.proposal.title}
${p.proposal.summary}

IMPLEMENTATION TIMELINE
${timeline}

QUOTATION
${quotation}
Total: ${p.quotation.total_range}
${p.quotation.note}

PROPOSED ARCHITECTURE
${p.architecture.summary}
${architecture}

CURRENT VS FUTURE
${comparison}

EXPECTED ROI
${p.roi.summary}
${roi}

Let us know if you'd like to walk through any of this on a call.`;
}

// Fetch the cached proposal for a lead, if one has been generated
router.get('/lead/:leadId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM proposals WHERE lead_id=$1', [req.params.leadId]);
    res.json({ proposal: result.rows[0] ? parseProposalRow(result.rows[0]) : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate (or regenerate) a proposal for a lead — get-or-creates lead_research as its grounding
router.post('/lead/:leadId/generate', async (req, res) => {
  try {
    const leadResult = await pool.query('SELECT * FROM hotel_leads WHERE id=$1', [req.params.leadId]);
    const lead = leadResult.rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Proposals are grounded in lead_research, so generating one for a lead that hasn't been
    // researched yet just researches it first (shared flow in leadResearchService.js).
    const { research } = await getOrCreateResearch(lead);
    if (!research) return res.status(400).json({ error: 'No website research available for this lead — it needs a website to research before a proposal can be generated' });

    const portfolioRes = await pool.query('SELECT title, url, description FROM portfolio_items ORDER BY created_at DESC LIMIT 5');
    const generated = await generateProposal(lead, research, portfolioRes.rows);

    const row = await pool.query(
      `INSERT INTO proposals
         (lead_id, proposal, timeline, quotation, architecture, current_vs_future, roi, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
       ON CONFLICT (lead_id) DO UPDATE SET
         proposal=$2, timeline=$3, quotation=$4, architecture=$5, current_vs_future=$6, roi=$7,
         status='draft', sent_at=NULL, created_at=NOW()
       RETURNING *`,
      [
        lead.id,
        JSON.stringify(generated.proposal),
        JSON.stringify(generated.timeline),
        JSON.stringify(generated.quotation),
        JSON.stringify(generated.architecture),
        JSON.stringify(generated.current_vs_future),
        JSON.stringify(generated.roi),
      ]
    );
    res.json({ proposal: parseProposalRow(row.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Email the generated proposal straight to the lead, same delivery path as estimates.js
router.post('/:id/send', async (req, res) => {
  try {
    const propResult = await pool.query(
      `SELECT p.*, hl.hotel_name, hl.email AS lead_email
       FROM proposals p JOIN hotel_leads hl ON hl.id = p.lead_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!propResult.rows[0]) return res.status(404).json({ error: 'Proposal not found' });
    const row = parseProposalRow(propResult.rows[0]);
    if (!row.lead_email) return res.status(400).json({ error: 'Lead has no email address on file' });

    const sender = await EmailSenderService.getSenderForLead(row.lead_id);
    if (!sender) return res.status(400).json({ error: 'No active email sender available to send from' });

    const unsubscribeUrl = `${getBackendUrl()}/unsubscribe?token=${SuppressionService.generateToken(row.lead_email)}`;
    const subject = `Proposal for ${row.hotel_name} — Dreams Technology`;
    const html = `${buildProposalHtml(row.hotel_name, row)}\n${unsubscribeFooterHtml(unsubscribeUrl)}`;
    const text = `${buildProposalText(row.hotel_name, row)}\n\n—\nDreams Technology\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`;

    const sendResult = await EmailSenderService.send(sender, { to: row.lead_email, subject, html, text });
    if (!sendResult.success) return res.status(502).json({ error: sendResult.error });

    await pool.query(
      `INSERT INTO email_logs (lead_id, sender_id, direction, subject, body, provider_message_id, sent_at)
       VALUES ($1, $2, 'out', $3, $4, $5, NOW())`,
      [row.lead_id, sender.id, subject, html, sendResult.messageId]
    );
    await pool.query(`UPDATE proposals SET status='sent', sent_at=NOW() WHERE id=$1`, [row.id]);
    await logAgentAction(row.lead_id, 'proposal_sent', { detail: { subject }, decision: 'send' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
