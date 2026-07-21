const { getSetting } = require('../services/settingsService');

// Cold/follow-up send window — every hotel_leads row is an India-based business (Google
// Places search is hard-locked to region:'in' in schedulerService.js, and both agent-task
// refine prompts explicitly refuse non-Indian cities), so there is exactly one recipient
// timezone in this whole system: IST. "Send windows" and "recipient timezone" are therefore
// the same check, not two features — no per-lead timezone lookup or library is needed.
// India has no DST, so a fixed +5:30 offset is exact, not an approximation.

const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 18;
const DEFAULT_DAYS = [1, 2, 3, 4, 5]; // JS Date#getDay(): 0=Sun..6=Sat — Mon-Fri by default
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function nowInIst() {
  // Deliberately built from getUTC* on a shifted timestamp rather than a locale/timezone
  // API — correct no matter what timezone the host server itself runs in (Render's is UTC
  // today, but this must not silently break if that ever changes).
  const shifted = new Date(Date.now() + IST_OFFSET_MS);
  return { hour: shifted.getUTCHours(), day: shifted.getUTCDay() };
}

function parseHour(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

function parseDays(raw) {
  if (!raw) return DEFAULT_DAYS;
  const days = raw.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return days.length ? days : DEFAULT_DAYS;
}

// Reads SEND_WINDOW_START_HOUR / SEND_WINDOW_END_HOUR / SEND_WINDOW_DAYS (settingsService,
// same DB-or-env pattern as every other setting; defaults to 9am-6pm IST, Mon-Fri when unset).
async function isWithinSendWindow() {
  const [startRaw, endRaw, daysRaw] = await Promise.all([
    getSetting('SEND_WINDOW_START_HOUR'),
    getSetting('SEND_WINDOW_END_HOUR'),
    getSetting('SEND_WINDOW_DAYS'),
  ]);
  const startHour = parseHour(startRaw, DEFAULT_START_HOUR);
  const endHour = parseHour(endRaw, DEFAULT_END_HOUR);
  const days = parseDays(daysRaw);
  const { hour, day } = nowInIst();

  // A misconfigured start >= end would otherwise block every send forever — treat it as
  // "hours unrestricted" rather than silently killing the whole channel.
  const withinHours = startHour < endHour ? hour >= startHour && hour < endHour : true;
  const withinDay = days.includes(day);

  return { allowed: withinHours && withinDay, hourIst: hour, dayIst: day, startHour, endHour, days };
}

module.exports = { isWithinSendWindow };
