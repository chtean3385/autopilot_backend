const express = require('express');
const LeadService = require('../services/leadService');
const WABAService = require('../services/wabaService');
const TemplateService = require('../services/templateService');
const pool = require('../config/db');
const router = express.Router();

// Create campaign (supports target_city or group_id)
router.post('/', async (req, res) => {
  const { campaign_name, template_id, target_city, group_id, target_type, target_lead_status } = req.body;
  const query = `
    INSERT INTO campaigns
    (campaign_name, template_id, target_city, group_id, target_type, target_lead_status, status, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, 'draft', 'admin')
    RETURNING *;
  `;
  try {
    const result = await pool.query(query, [
      campaign_name,
      template_id,
      target_city || null,
      group_id || null,
      target_type || (group_id ? 'group' : 'city'),
      target_lead_status || 'new'
    ]);
    res.json({ success: true, campaign: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all campaigns (with template name, group name, and real live lead counts)
router.get('/', async (req, res) => {
  // live_lead_count = leads in target matching status filter AND not yet sent in this campaign
  const query = `
    SELECT c.*,
      t.template_name,
      g.name AS group_name,
      CASE
        WHEN c.target_type = 'group' AND c.group_id IS NOT NULL THEN (
          SELECT COUNT(*) FROM lead_group_members lgm
          JOIN hotel_leads hl ON hl.id = lgm.lead_id
          WHERE lgm.group_id = c.group_id
            AND (c.target_lead_status = 'all' OR hl.status = COALESCE(c.target_lead_status, 'new'))
            AND hl.id NOT IN (SELECT lead_id FROM outreach_logs WHERE campaign_id = c.id)
        )
        WHEN c.target_type = 'city' AND c.target_city IS NOT NULL THEN (
          SELECT COUNT(*) FROM hotel_leads hl
          WHERE LOWER(hl.city) = LOWER(c.target_city)
            AND (c.target_lead_status = 'all' OR hl.status = COALESCE(c.target_lead_status, 'new'))
            AND hl.id NOT IN (SELECT lead_id FROM outreach_logs WHERE campaign_id = c.id)
        )
        ELSE c.total_leads
      END AS live_lead_count
    FROM campaigns c
    LEFT JOIN waba_templates t ON c.template_id = t.id
    LEFT JOIN lead_groups g ON c.group_id = g.id
    ORDER BY c.created_at DESC
  `;
  try {
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Launch campaign
router.post('/:id/launch', async (req, res) => {
  const campaignId = req.params.id;

  try {
    const campaignResult = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    const campaign = campaignResult.rows[0];
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Get the template — must be approved on Meta
    let template = null;
    if (campaign.template_id) {
      const tplResult = await pool.query('SELECT * FROM waba_templates WHERE id = $1', [campaign.template_id]);
      template = tplResult.rows[0];
    }
    if (!template) return res.status(400).json({ error: 'Template not found for this campaign' });
    if (template.status !== 'approved') {
      return res.status(400).json({
        error: `Template "${template.template_name}" is not approved yet (status: ${template.status}). Go to Templates → Refresh Status to sync approval from Meta.`
      });
    }

    // Determine which lead status to target
    const targetLeadStatus = campaign.target_lead_status || 'new';

    // Get target leads: skip any already sent to in THIS campaign (by outreach_logs)
    let leadsResult;
    if (campaign.target_type === 'group' && campaign.group_id) {
      leadsResult = await pool.query(`
        SELECT hl.* FROM hotel_leads hl
        JOIN lead_group_members m ON hl.id = m.lead_id
        WHERE m.group_id = $1
          AND ($2 = 'all' OR hl.status = $2)
          AND hl.id NOT IN (SELECT lead_id FROM outreach_logs WHERE campaign_id = $3)
      `, [campaign.group_id, targetLeadStatus, campaignId]);
    } else {
      leadsResult = await pool.query(`
        SELECT * FROM hotel_leads
        WHERE LOWER(city) = LOWER($1)
          AND ($2 = 'all' OR status = $2)
          AND id NOT IN (SELECT lead_id FROM outreach_logs WHERE campaign_id = $3)
      `, [campaign.target_city, targetLeadStatus, campaignId]);
    }
    const leads = leadsResult.rows;

    if (leads.length === 0) {
      const target = campaign.target_type === 'group'
        ? `group (id: ${campaign.group_id})`
        : `city "${campaign.target_city}"`;
      const statusNote = targetLeadStatus === 'new'
        ? 'with status "new"'
        : `with status "${targetLeadStatus}"`;
      return res.status(400).json({
        success: false,
        error: `No unsent leads ${statusNote} found for ${target}. All leads may have already been contacted in this campaign.`
      });
    }

    // Send messages
    const results = [];
    for (const lead of leads) {
      const wabaResult = await WABAService.sendPersonalizedTemplate(lead, template);
      if (wabaResult.success) {
        await LeadService.logOutreach(lead.id, campaignId, template.id, wabaResult.messageId);
        results.push({ lead_id: lead.id, hotel: lead.hotel_name, status: 'sent' });
      } else {
        results.push({ lead_id: lead.id, hotel: lead.hotel_name, status: 'failed', error: wabaResult.error });
      }
    }

    await pool.query(
      'UPDATE campaigns SET status = $1, total_leads = $2 WHERE id = $3',
      ['active', leads.length, campaignId]
    );

    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'failed');
    res.json({ success: true, campaign_id: campaignId, sent, failed_count: failed.length, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Edit draft campaign
router.put('/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Campaign not found' });
    if (existing.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Only draft campaigns can be edited' });
    }
    const { campaign_name, template_id, target_city, group_id, target_type, target_lead_status } = req.body;
    const result = await pool.query(
      `UPDATE campaigns
       SET campaign_name=$1, template_id=$2, target_city=$3, group_id=$4, target_type=$5, target_lead_status=$6
       WHERE id=$7 RETURNING *`,
      [campaign_name, template_id || null, target_city || null, group_id || null, target_type, target_lead_status || 'new', req.params.id]
    );
    res.json({ success: true, campaign: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete campaign (any status allowed)
router.delete('/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT status FROM campaigns WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Campaign not found' });
    // Remove outreach logs first to satisfy FK constraint
    await pool.query('DELETE FROM outreach_logs WHERE campaign_id = $1', [req.params.id]);
    await pool.query('DELETE FROM campaigns WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get campaign stats
router.get('/:id/stats', async (req, res) => {
  const stats = await LeadService.getOutreachStats(req.params.id);
  res.json(stats);
});

module.exports = router;
