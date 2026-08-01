const schedule = require('node-schedule');
const PlaybookService = require('../services/playbookService');

let isRunning = false;

async function runWeeklyInsightsJob() {
  if (isRunning) {
    console.log('[PlaybookInsights] Previous run still in progress — skipping this tick');
    return;
  }
  isRunning = true;

  try {
    await PlaybookService.runWeeklyInsights();
  } catch (err) {
    console.error('[PlaybookInsights] Error generating weekly insight:', err.message);
  } finally {
    isRunning = false;
  }
}

// Every Monday at 6am IST — summarizes the past week's agent_actions + reply rate into a playbook insight
// Explicit tz (see schedulerService.js's daily-follow-up job for the same pattern): host clocks
// aren't guaranteed to run in IST, so a bare cron rule would fire at the wrong wall-clock hour.
schedule.scheduleJob({ rule: '0 6 * * 1', tz: 'Asia/Kolkata' }, runWeeklyInsightsJob);

console.log('🧠 Playbook insights worker started - runs weekly on Mondays at 6am');
