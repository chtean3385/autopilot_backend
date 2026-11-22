const schedule = require('node-schedule');
const { track } = require('../utils/jobTracker');
const FreshResend = require('../services/freshResendService');

// Fresh-start re-send of original first emails (services/freshResendService.js). Every 10 min at :05,
// offset from the sequence/cadence ticks at :00. Off unless FRESH_RESEND_ENABLED=true; respects the IST
// send window, each mailbox's daily cap and EMAIL_SENDER_MIN_GAP_MINUTES.
schedule.scheduleJob('5-59/10 * * * *', () => track('fresh_resend', async () => {
  const r = await FreshResend.runTick();
  if (r && !r.skipped) console.log('[FreshResend]', JSON.stringify(r));
  return r;
}).catch((err) => console.error('[FreshResend] tick failed:', err.message)));
