const schedule = require('node-schedule');
const pool = require('../config/db');
const WABAService = require('../services/wabaService');
const LeadService = require('../services/leadService');

// Run campaign sends every 5 minutes
schedule.scheduleJob('*/5 * * * *', async () => {
  console.log('[WORKER] Checking for scheduled campaigns...');

  const query = `
    SELECT c.* FROM campaigns c
    WHERE c.status = 'scheduled'
    AND c.scheduled_start <= NOW()
    AND c.scheduled_end > NOW()
    LIMIT 1
  `;

  try {
    const result = await pool.query(query);
    if (result.rows.length > 0) {
      const campaign = result.rows[0];
      console.log(`[WORKER] Processing campaign: ${campaign.campaign_name}`);

      // Get pending leads for this campaign (not yet contacted)
      const leadsQuery = `
        SELECT hl.* FROM hotel_leads hl
        LEFT JOIN outreach_logs ol ON hl.id = ol.lead_id
        WHERE hl.city = $1
        AND ol.id IS NULL
        LIMIT 10  -- Process 10 at a time
      `;

      const leadsResult = await pool.query(leadsQuery, [campaign.target_city]);
      const leads = leadsResult.rows;

      for (const lead of leads) {
        const sendResult = await WABAService.sendPersonalizedTemplate(
          lead,
          'welcome_hotel_owner'
        );

        if (sendResult.success) {
          await LeadService.logOutreach(lead.id, campaign.id, campaign.template_id, sendResult.messageId);
          console.log(`[WORKER] ✅ Message sent to ${lead.whatsapp_number}`);
        } else {
          console.log(`[WORKER] ❌ Failed to send to ${lead.whatsapp_number}`);
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  } catch (error) {
    console.error('[WORKER] Error in campaign worker:', error);
  }
});

console.log('🚀 Campaign worker started - checks every 5 minutes');
