const pool = require('../config/db');

// Last success / last failure per outbound channel, so a channel that silently dies is noticed
// (CLAUDE.md 2026-09-18: Brevo IP block + IMAP never configured + mails.so out of credit went
// unseen for 6 weeks). Stored in scheduler_status as job_name 'health:<channel>' with
// last_summary = { lastOkAt, lastErrorAt, lastError }. Read by services/cadenceHealthService.js.
//
// Only channel-level failures are recorded as errors (auth, IP block, out of credit, provider down,
// network). A single bad recipient address is NOT a channel failure — callers decide that.
//
// Never throws: health bookkeeping must not break a send.

const OK_WRITE_EVERY_MS = 60 * 1000; // a busy channel needn't write "still ok" on every send
const lastOkWrite = new Map(); // channel → ms
const erroredSinceOk = new Set(); // channel had an error since its last ok write (in this process)

async function write(channel, patch) {
  const job = `health:${channel}`;
  await pool.query(
    `INSERT INTO scheduler_status (job_name, last_ran_at, last_trigger, last_summary, updated_at)
     VALUES ($1, NOW(), 'health', $2::json, NOW())
     ON CONFLICT (job_name) DO UPDATE
       SET last_ran_at = NOW(),
           last_summary = (COALESCE(scheduler_status.last_summary::jsonb, '{}'::jsonb) || $2::jsonb)::json,
           updated_at = NOW()`,
    [job, JSON.stringify(patch)]
  );
}

async function markOk(channel) {
  try {
    const now = Date.now();
    if (!erroredSinceOk.has(channel) && now - (lastOkWrite.get(channel) || 0) < OK_WRITE_EVERY_MS) return;
    lastOkWrite.set(channel, now);
    erroredSinceOk.delete(channel);
    await write(channel, { lastOkAt: new Date(now).toISOString() });
  } catch (err) {
    console.error(`[ChannelHealth] markOk(${channel}) failed:`, err.message);
  }
}

async function markError(channel, error) {
  try {
    erroredSinceOk.add(channel);
    await write(channel, { lastErrorAt: new Date().toISOString(), lastError: String(error || 'unknown error').slice(0, 300) });
  } catch (err) {
    console.error(`[ChannelHealth] markError(${channel}) failed:`, err.message);
  }
}

// → { [channel]: { lastOkAt, lastErrorAt, lastError } }
async function getAll() {
  const { rows } = await pool.query(`SELECT job_name, last_summary FROM scheduler_status WHERE job_name LIKE 'health:%'`);
  const out = {};
  for (const r of rows) {
    const s = typeof r.last_summary === 'string' ? JSON.parse(r.last_summary || '{}') : (r.last_summary || {});
    out[r.job_name.slice('health:'.length)] = s;
  }
  return out;
}

// True when the most recent event for this channel is a failure.
function isFailing(s) {
  if (!s?.lastErrorAt) return false;
  return !s.lastOkAt || new Date(s.lastErrorAt) > new Date(s.lastOkAt);
}

function _reset() { lastOkWrite.clear(); erroredSinceOk.clear(); }

module.exports = { markOk, markError, getAll, isFailing, _reset };
