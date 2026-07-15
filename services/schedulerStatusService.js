const pool = require('../config/db');

// Records the outcome of a scheduler/worker run so the UI can show "last ran: X" —
// the whole point is to prove a run actually happened even if nobody was watching
// the Render logs (e.g. after a free-tier sleep window).
async function recordRun(jobName, trigger, summary) {
  await pool.query(
    `INSERT INTO scheduler_status (job_name, last_ran_at, last_trigger, last_summary, updated_at)
     VALUES ($1, NOW(), $2, $3, NOW())
     ON CONFLICT (job_name) DO UPDATE
       SET last_ran_at = NOW(), last_trigger = $2, last_summary = $3, updated_at = NOW()`,
    [jobName, trigger, JSON.stringify(summary)]
  );
}

async function getAllStatus() {
  const result = await pool.query('SELECT * FROM scheduler_status ORDER BY job_name');
  return result.rows;
}

module.exports = { recordRun, getAllStatus };
