const schedule = require('node-schedule');
const { runCadence, loadConfig } = require('../services/cadenceService');
const pool = require('../config/db');
const { ensurePool, syncPending } = require('../services/templatePoolService');
const { sendUrgentAlert, sendDailyHealthAlert, sendWeeklySummary } = require('../services/cadenceHealthService');

// Directory outreach step 3 — every 15 min: start today's quota of new directory leads, then send
// whatever cadence touches are due (one channel per lead, never both). Does nothing unless
// CADENCE_ENABLED=true, and only inside the IST send window (utils/sendWindow.js). Catch-up safe:
// it queries "next_touch_at <= NOW()", so missed ticks just send on the next one.
schedule.scheduleJob('*/15 * * * *', () => {
  runCadence('cron').catch((err) => console.error('[Cadence] tick failed:', err.message));
});
// Daily 10:05 IST: write, score and submit WhatsApp templates for every directory niche. Runs as soon
// as any directory exists (not only once the cadence is on) so approved templates are ready by the
// time outreach starts. Hourly: ask Meta about templates still pending (webhook safety net).
// Explicit tz — the VPS runs on UTC (see CLAUDE.md).
async function hasDirectories() {
  const r = await pool.query(`SELECT 1 FROM directory_sources WHERE status <> 'rejected' LIMIT 1`);
  return r.rows.length > 0 || (await loadConfig()).enabled;
}
schedule.scheduleJob({ hour: 10, minute: 5, tz: 'Asia/Kolkata' }, async () => {
  try {
    if (await hasDirectories()) await ensurePool();
  } catch (err) {
    console.error('[TemplatePool] daily run failed:', err.message);
  }
});
schedule.scheduleJob('17 * * * *', () => {
  syncPending().catch((err) => console.error('[TemplatePool] hourly sync failed:', err.message));
});
// Daily 18:30 IST: WhatsApp the owner if anything in the directory pipeline looks broken (silent
// failures are what hid the 2026-09 email outage for 6 weeks). Weekly Monday 09:30 IST: summary.
schedule.scheduleJob({ hour: 18, minute: 30, tz: 'Asia/Kolkata' }, () => {
  sendDailyHealthAlert().catch((err) => console.error('[CadenceHealth] daily alert failed:', err.message));
});
// Hourly 08:40-22:40 IST: anything actually broken (email/WhatsApp sending, reply checking, mails.so)
// is WhatsApped right away, not at 18:30 — the same problem at most every 6 hours, never at night.
schedule.scheduleJob({ hour: new schedule.Range(8, 22), minute: 40, tz: 'Asia/Kolkata' }, () => {
  sendUrgentAlert().catch((err) => console.error('[Health] urgent alert failed:', err.message));
});
schedule.scheduleJob({ dayOfWeek: 1, hour: 9, minute: 30, tz: 'Asia/Kolkata' }, () => {
  sendWeeklySummary().catch((err) => console.error('[CadenceHealth] weekly summary failed:', err.message));
});
console.log('🔁 Cadence worker started - directory leads, email ⇄ WhatsApp, every 15 minutes (needs CADENCE_ENABLED=true)');
