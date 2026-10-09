const cronParser = require('cron-parser');
const pool = require('../config/db');
const settingsService = require('./settingsService');
const { getCurrentCrawl } = require('./directoryCrawlerService');
const { getRunning } = require('../utils/jobTracker');

// Live directory-crawl queue for Lead Sources: what is being crawled this second, which directory
// goes next and roughly when, pages left, and the latest pages read. The ETAs come from replaying
// workers/directoryCrawlWorker.js's rules: one site per 10-minute tick, least recently crawled first,
// a site is skipped while cooldown_until is in the future (rest between turns / block cool-down).
// Keep TICK_CRON in sync with that worker.
const TICK_CRON = '*/10 * * * *';
const TICK_MS = 10 * 60 * 1000;
const MAX_SIM_TICKS = 6 * 24 * 30; // a month of ticks is plenty for an estimate

async function intSetting(key, fallback) {
  const n = parseInt(await settingsService.getSetting(key), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function getQueue() {
  const [perTick, delayMs, restMin, blockFails, coolHours, sourcesRes, recentRes] = await Promise.all([
    intSetting('DIRECTORY_PAGES_PER_TICK', 30),
    intSetting('DIRECTORY_CRAWL_DELAY_MS', 3000),
    intSetting('DIRECTORY_SOURCE_REST_MIN', 20),
    intSetting('DIRECTORY_BLOCK_FAILS', 5),
    intSetting('DIRECTORY_BLOCK_COOLDOWN_HOURS', 6),
    pool.query(`
      SELECT s.id, s.name, s.url, s.status, s.cooldown_until, s.block_count, s.last_crawled_at, s.created_at,
             s.last_error, s.entries_found,
             COUNT(p.id) FILTER (WHERE p.status = 'pending')::int  AS pages_left,
             COUNT(p.id) FILTER (WHERE p.status = 'done')::int     AS pages_done,
             COUNT(p.id) FILTER (WHERE p.status = 'failed')::int   AS pages_failed,
             COUNT(p.id) FILTER (WHERE p.status = 'needs_ai')::int AS pages_need_ai
      FROM directory_sources s
      LEFT JOIN directory_crawl_pages p ON p.source_id = s.id
      WHERE s.status IN ('approved', 'crawling')
      GROUP BY s.id`),
    pool.query(`
      SELECT p.id, p.url, p.status, p.members_found, p.error, p.fetched_at, s.id AS source_id,
             COALESCE(s.name, s.url) AS source_name
      FROM directory_crawl_pages p JOIN directory_sources s ON s.id = p.source_id
      WHERE p.fetched_at IS NOT NULL
      ORDER BY p.fetched_at DESC LIMIT 40`),
  ]);

  const now = Date.now();
  const current = getCurrentCrawl();
  const tickRunning = !!getRunning().directory_crawl;
  const nextTickAt = cronParser.parseExpression(TICK_CRON).next().toDate().getTime();
  const turnMs = perTick * delayMs; // one turn ≈ pages × delay
  const restMs = restMin * 60000;

  // ── replay the worker ──
  const sim = sourcesRes.rows.map((s) => ({
    id: s.id,
    readyAt: Math.max(now, s.cooldown_until ? new Date(s.cooldown_until).getTime() : 0),
    last: s.last_crawled_at ? new Date(s.last_crawled_at).getTime() : -Infinity,
    left: s.status === 'approved' ? null : s.pages_left, // null = pages not discovered yet
    eta: null,
    doneAt: null,
  }));
  // The site being crawled right now finishes its turn first.
  if (current) {
    const c = sim.find((x) => x.id === current.sourceId);
    if (c) {
      c.eta = now;
      c.last = now;
      c.readyAt = now + Math.max(0, (current.planned - current.done) * delayMs) + restMs;
      if (c.left != null) c.left -= Math.max(0, current.planned - current.done);
      if (c.left != null && c.left <= 0) c.doneAt = now + (current.planned - current.done) * delayMs;
    }
  }
  let active = sim.filter((x) => x.doneAt == null);
  for (let i = 0, t = nextTickAt; i < MAX_SIM_TICKS && active.length; i++, t += TICK_MS) {
    const ready = active.filter((x) => x.readyAt <= t)
      .sort((a, b) => (a.last - b.last) || (a.id - b.id));
    if (!ready.length) continue;
    const pick = ready[0];
    if (pick.eta == null) pick.eta = t;
    pick.last = t;
    pick.readyAt = t + turnMs + restMs;
    if (pick.left == null) {
      // First visit discovers the pages; we can't know how many until then.
      active = active.filter((x) => x !== pick);
      continue;
    }
    pick.left -= perTick;
    if (pick.left <= 0) {
      pick.doneAt = t + turnMs;
      active = active.filter((x) => x !== pick);
    }
  }
  const simById = Object.fromEntries(sim.map((x) => [x.id, x]));

  const queue = sourcesRes.rows.map((s) => {
    const x = simById[s.id];
    const cooling = s.block_count > 0 && s.cooldown_until && new Date(s.cooldown_until).getTime() > now;
    const resting = !cooling && s.cooldown_until && new Date(s.cooldown_until).getTime() > now;
    let state = 'waiting';
    if (current?.sourceId === s.id) state = 'crawling';
    else if (cooling) state = 'cooling';
    else if (s.status === 'approved') state = 'new';
    else if (resting) state = 'resting';
    return {
      id: s.id, name: s.name || s.url, url: s.url, status: s.status, state,
      pagesLeft: s.status === 'approved' ? null : s.pages_left,
      pagesDone: s.pages_done, pagesFailed: s.pages_failed, pagesNeedAi: s.pages_need_ai,
      businesses: s.entries_found,
      createdAt: s.created_at, lastCrawledAt: s.last_crawled_at, cooldownUntil: s.cooldown_until,
      blockCount: s.block_count, lastError: s.last_error,
      nextCrawlAt: x?.eta ? new Date(x.eta).toISOString() : null,
      estDoneAt: x?.doneAt ? new Date(x.doneAt).toISOString() : null,
    };
  }).sort((a, b) => (a.state === 'crawling' ? -1 : b.state === 'crawling' ? 1 : 0)
    || ((a.nextCrawlAt ? Date.parse(a.nextCrawlAt) : Infinity) - (b.nextCrawlAt ? Date.parse(b.nextCrawlAt) : Infinity)));

  const pagesLeft = queue.reduce((n, q) => n + (q.pagesLeft || 0), 0);
  const doneTimes = queue.map((q) => q.estDoneAt).filter(Boolean).map(Date.parse);
  const unknown = queue.some((q) => q.pagesLeft == null || (q.pagesLeft > 0 && !q.estDoneAt));

  return {
    now: new Date(now).toISOString(),
    nextTickAt: new Date(nextTickAt).toISOString(),
    tickRunning,
    current: current && { ...current, pageDelayMs: delayMs },
    settings: { perTick, delayMs, restMin, blockFails, coolHours },
    totals: {
      directories: queue.length,
      crawlingNow: current ? 1 : 0,
      cooling: queue.filter((q) => q.state === 'cooling').length,
      pagesLeft,
      // Max throughput: one turn per tick across all sites (a lone site is limited by its rest).
      maxPagesPerHour: Math.round(perTick * (60 / 10)),
      allDoneAt: !unknown && doneTimes.length ? new Date(Math.max(...doneTimes)).toISOString() : null,
    },
    queue,
    recent: recentRes.rows,
  };
}

module.exports = { getQueue };
