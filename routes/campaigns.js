const express = require('express');
const LeadService = require('../services/leadService');
const WABAService = require('../services/wabaService');
const TemplateService = require('../services/templateService');
const pool = require('../config/db');
const router = express.Router();

// In-process guard against launching the same campaign twice concurrently — a double-click,
// a slow-network retry, or two admins clicking at once would otherwise both pass the checks
// below and both send, since the "not yet contacted" lead query has no DB-level lock between
// read and send. This is what produced the same template hitting one number 3-4x in a minute.
const launchingCampaigns = new Set();

// Create campaign (supports target_city or group_id)
router.post('/', async (req, res) => {
  const { campaign_name, template_id, target_city, group_id, target_type, target_lead_status, agent_id } = req.body;
  const query = `
    INSERT INTO campaigns
    (campaign_name, template_id, target_city, group_id, target_type, target_lead_status, agent_id, status, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', 'admin')
    RETURNING *;
  `;
  try {
    const result = await pool.query(query, [
      campaign_name,
      template_id,
      target_city || null,
      group_id || null,
      target_type || (group_id ? 'group' : 'city'),
      target_lead_status || 'new', agent_id || null
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
      sa.name AS agent_name,
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
    LEFT JOIN sales_agents sa ON c.agent_id = sa.id
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

  if (launchingCampaigns.has(campaignId)) {
    return res.status(409).json({ error: 'This campaign is already sending — please wait for it to finish before launching again.' });
  }
  launchingCampaigns.add(campaignId);

  try {
    const campaignResult = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
    const campaign = campaignResult.rows[0];
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!campaign.agent_id && !campaign.system_prompt) {
      return res.status(400).json({
        error: 'Campaign needs a Sales Agent before launch. Create a configured agent, then assign it to this campaign.',
      });
    }

    // Block launch if WABA quality is RED
    const health = await WABAService.getAccountHealth();
    if (health.success && health.quality_rating === 'RED') {
      return res.status(403).json({
        error: 'Campaign blocked: your WhatsApp number quality rating is RED. Fix quality issues in Meta Business Manager before sending.',
        quality_rating: 'RED',
        blocked: true,
      });
    }

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

    // Send messages — skip leads with no usable WhatsApp number instead of letting Meta reject them
    const results = [];
    for (const lead of leads) {
      if (!lead.whatsapp_number || !lead.whatsapp_number.trim()) {
        results.push({ lead_id: lead.id, hotel: lead.hotel_name, status: 'skipped', error: 'No WhatsApp number on file' });
        continue;
      }
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
    const skipped = results.filter(r => r.status === 'skipped');
    res.json({ success: true, campaign_id: campaignId, sent, failed_count: failed.length, skipped_count: skipped.length, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    launchingCampaigns.delete(campaignId);
  }
});

// Edit campaign — allowed at any status. Editable fields (name, template, target, agent) only
// affect future behavior (which agent replies going forward, what "Send remaining" uses next),
// never anything already sent, so there's no reason to lock this down once a campaign launches —
// re-pointing agent_id here is in fact the main way to fix a campaign that never got a real
// Sales Agent assigned (see resolveAgent's throwaway-agent fallback in salesAgentService.js).
router.put('/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Campaign not found' });
    const { campaign_name, template_id, target_city, group_id, target_type, target_lead_status, agent_id } = req.body;
    const result = await pool.query(
      `UPDATE campaigns
       SET campaign_name=$1, template_id=$2, target_city=$3, group_id=$4, target_type=$5, target_lead_status=$6, agent_id=$7
       WHERE id=$8 RETURNING *`,
      [campaign_name, template_id || null, target_city || null, group_id || null, target_type, target_lead_status || 'new', agent_id || null, req.params.id]
    );
    res.json({ success: true, campaign: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pause an active campaign — stops it from being offered for further manual "Send remaining"
// batches. Does not touch leads already sent to or the agent's ability to reply to them;
// it only gates new outbound sends under this campaign.
router.post('/:id/pause', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE campaigns SET status='paused' WHERE id=$1 AND status='active' RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'Only active campaigns can be paused' });
    res.json({ success: true, campaign: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/reactivate', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE campaigns SET status='active' WHERE id=$1 AND status='paused' RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'Only paused campaigns can be reactivated' });
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
    // Remove/unlink dependent rows first to satisfy FK constraints
    await pool.query('DELETE FROM outreach_logs WHERE campaign_id = $1', [req.params.id]);
    await pool.query('DELETE FROM daily_analytics WHERE campaign_id = $1', [req.params.id]);
    await pool.query('UPDATE demo_bookings SET campaign_id = NULL WHERE campaign_id = $1', [req.params.id]);
    await pool.query('UPDATE agent_tasks SET campaign_id = NULL WHERE campaign_id = $1', [req.params.id]);
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
