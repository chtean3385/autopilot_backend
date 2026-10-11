const schedule = require('node-schedule');
const { runPipeline } = require('../services/resortPipelineService');
const { track } = require('../utils/jobTracker');

// Dream Stay ad leads (_docs/resort-crm/plan.md) — every 15 min: start today's quota of new leads and send
// due WhatsApp templates. Does nothing unless RESORT_PIPELINE_ENABLED=true, and only inside the IST send
// window. Catch-up safe (next_touch_at <= NOW()). Offset from the cadence worker's :00/:15/:30/:45.
schedule.scheduleJob('7,22,37,52 * * * *', () => {
  track('resort_pipeline', () => runPipeline('cron')).catch((err) => console.error('[ResortPipeline] tick failed:', err.message));
});
console.log('🏨 Resort CRM pipeline worker started - Dream Stay ad leads, every 15 minutes (needs RESORT_PIPELINE_ENABLED=true)');
