const SchedulerStatusService = require('../services/schedulerStatusService');

// Which background job is running right now (in-memory — the workers and the API share one
// process) + its last result (scheduler_status, survives restarts). Read by
// services/pipelineService.js for the Live Pipeline view.
//
// track() never changes what the job does or throws: it awaits it, records the outcome, and
// passes the result/error straight through. record:false is for jobs that already call
// SchedulerStatusService.recordRun themselves with richer stats (email_sequences, whatsapp_followups).

const running = new Map(); // key → { since: ISO string }

async function track(key, fn, { record = true, trigger = 'cron' } = {}) {
  if (running.has(key)) return fn(); // overlapping tick — the job's own guard decides what to do
  running.set(key, { since: new Date().toISOString() });
  const started = Date.now();
  try {
    const result = await fn();
    if (record) {
      const summary = result && typeof result === 'object' ? result : {};
      await safeRecord(key, trigger, { ...summary, durationMs: Date.now() - started });
    }
    return result;
  } catch (err) {
    if (record) await safeRecord(key, trigger, { error: err.message, durationMs: Date.now() - started });
    throw err;
  } finally {
    running.delete(key);
  }
}

async function safeRecord(key, trigger, summary) {
  try {
    await SchedulerStatusService.recordRun(key, trigger, summary);
  } catch (err) {
    console.error(`[JobTracker] recordRun(${key}) failed:`, err.message);
  }
}

function getRunning() {
  return Object.fromEntries(running);
}

module.exports = { track, getRunning };
