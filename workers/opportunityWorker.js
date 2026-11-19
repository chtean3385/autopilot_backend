const schedule = require('node-schedule');
const hunter = require('../services/opportunityHunterService');
const reader = require('../services/waGroupReaderService');
const { track } = require('../utils/jobTracker');

// Opportunity Hunter (_docs/opportunity-hunter.md). Every 2 min: analyse new WhatsApp group/channel
// posts (AI qualify → email draft / manual WhatsApp message / skipped), then — only in
// OPP_HUNTER_MODE=auto — send the best fresh email drafts. Catch-up safe: it works off
// opportunity_messages.status = 'pending' and opportunities.status = 'draft', so a missed tick just
// runs on the next one. Interval-only, so no tz needed.
schedule.scheduleJob('*/2 * * * *', () => {
  track('opportunity_hunter', async () => {
    const analysed = await hunter.processPending(10);
    const sent = await hunter.autoSendTick();
    return { analysed, sent };
  }).catch((err) => console.error('[OppHunter] tick failed:', err.message));
});

// The read-only WhatsApp reader reconnects on boot only if the owner switched it on (Connect button).
// Delayed so initDB() has created the tables on a fresh database.
setTimeout(() => { reader.bootIfEnabled(); }, 15 * 1000);
