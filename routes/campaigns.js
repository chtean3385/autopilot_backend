const express = require('express');
const LeadService = require('../services/leadService');
const WABAService = require('../services/wabaService');
const TemplateService = require('../services/templateService');
const pool = require('../config/db');
const router = express.Router();

// Create campaign (supports target_city or group_id)
router.post('/', async (req, res) => {
  const { campaign_name, template_id, target_city, group_id, target_type } = req.body;
  const query = `
    INSERT INTO campaigns
    (campaign_name, template_id, target_city, group_id, target_type, status, created_by)
    VALUES ($1, $2, $3, $4, $5, 'draft', 'admin')
    RETURNING *;
  `;
  try {
    const result = await pool.query(query, [
      campaign_name,
      template_id,
      target_city || null,
      group_id || null,
      target_type || (group_id ? 'group' : 'city')
    ]);
    res.json({ success: true, campaign: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all campaigns (with template name, group name, and real live lead counts)
router.get('/', async (req, res) => {
  const query = `
    SELECT c.*,
      t.template_name,
      g.name AS group_name,
      CASE
        WHEN c.target_type = 'group' AND c.group_id IS NOT NULL THEN
          (SELECT COUNT(*) FROM lead_group_members WHERE group_id = c.group_id)
        WHEN c.target_type = 'city' AND c.target_city IS NOT NULL THEN
          (SELECT COUNT(*) FROM hotel_leads WHERE LOWER(city) = LOWER(c.target_city) AND status = 'new')
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

    // Get the template
    let template = null;
    if (campaign.template_id) {
      const tplResult = await pool.query('SELECT * FROM waba_templates WHERE id = $1', [campaign.template_id]);
      template = tplResult.rows[0];
    }
    if (!template) {
      template = await TemplateService.getTemplateByName('welcome_hotel_owner');
    }
    if (!template) return res.status(400).json({ error: 'No approved template found for this campaign' });

    // Get target leads: by group or by city
    let leadsResult;
    if (campaign.target_type === 'group' && campaign.group_id) {
      leadsResult = await pool.query(`
        SELECT hl.* FROM hotel_leads hl
        JOIN lead_group_members m ON hl.id = m.lead_id
        WHERE m.group_id = $1 AND hl.status = 'new'
      `, [campaign.group_id]);
    } else {
      leadsResult = await pool.query(
        "SELECT * FROM hotel_leads WHERE city = $1 AND status = 'new'",
        [campaign.target_city]
      );
    }
    const leads = leadsResult.rows;

    if (leads.length === 0) {
      const target = campaign.target_type === 'group'
        ? `group (id: ${campaign.group_id})`
        : `city "${campaign.target_city}"`;
      return res.status(400).json({
        success: false,
        error: `No leads with status "new" found for ${target}. Add leads to this target first, or check that existing leads haven't already been contacted.`
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

    res.json({ success: true, campaign_id: campaignId, results });
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
    const { campaign_name, template_id, target_city, group_id, target_type } = req.body;
    const result = await pool.query(
      `UPDATE campaigns
       SET campaign_name=$1, template_id=$2, target_city=$3, group_id=$4, target_type=$5
       WHERE id=$6 RETURNING *`,
      [campaign_name, template_id || null, target_city || null, group_id || null, target_type, req.params.id]
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
