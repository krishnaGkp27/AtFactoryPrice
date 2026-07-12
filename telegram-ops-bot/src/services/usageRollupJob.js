'use strict';

/**
 * ANL-1 — nightly rollup: usage_events → usage_daily (owner decision D4:
 * the dashboard reads ONLY rollups). Runs at 02:00 server time; safe to
 * re-run for any day (upsert). Raw events are kept forever (decision D2 —
 * no purge here by design).
 */

const postgresPool = require('../db/postgresPool');
const config = require('../config');
const logger = require('../utils/logger');

// Events that count as a feature being "started" / "completed" for the
// completion-rate KPI. flow submission to the approval queue IS the user's
// completion of their part; flow_completed is reserved for future direct
// completion signals.
const START_EVENTS = ['flow_started', 'tile_tapped', 'nlp_intent'];
const COMPLETE_EVENTS = ['flow_completed', 'approval_queued'];

/** Rollup SQL for one day; $1 = day (date). Upserts per (feature, role). */
const ROLLUP_SQL = `
INSERT INTO usage_daily (day, feature, role, starts, completions, abandons, errors, unique_users, p50_duration_ms, p50_steps)
SELECT
  $1::date,
  feature,
  r.role,
  COUNT(*) FILTER (WHERE event = ANY($2)) AS starts,
  COUNT(*) FILTER (WHERE event = ANY($3)) AS completions,
  COUNT(*) FILTER (WHERE event = 'flow_abandoned') AS abandons,
  COUNT(*) FILTER (WHERE event = 'flow_error') AS errors,
  COUNT(DISTINCT user_id) AS unique_users,
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS p50_duration_ms,
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY steps) FILTER (WHERE steps IS NOT NULL))::int AS p50_steps
FROM usage_events, LATERAL (SELECT COALESCE(role, '*') AS role) r
WHERE ts >= $1::date AND ts < ($1::date + INTERVAL '1 day')
GROUP BY feature, r.role
UNION ALL
SELECT
  $1::date,
  feature,
  '*',
  COUNT(*) FILTER (WHERE event = ANY($2)),
  COUNT(*) FILTER (WHERE event = ANY($3)),
  COUNT(*) FILTER (WHERE event = 'flow_abandoned'),
  COUNT(*) FILTER (WHERE event = 'flow_error'),
  COUNT(DISTINCT user_id),
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int,
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY steps) FILTER (WHERE steps IS NOT NULL))::int
FROM usage_events
WHERE ts >= $1::date AND ts < ($1::date + INTERVAL '1 day')
GROUP BY feature
ON CONFLICT (day, feature, role) DO UPDATE SET
  starts = EXCLUDED.starts,
  completions = EXCLUDED.completions,
  abandons = EXCLUDED.abandons,
  errors = EXCLUDED.errors,
  unique_users = EXCLUDED.unique_users,
  p50_duration_ms = EXCLUDED.p50_duration_ms,
  p50_steps = EXCLUDED.p50_steps
`;

/** ISO date (YYYY-MM-DD) for "yesterday" in server-local time. */
function yesterdayISO(now = new Date()) {
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Roll up one day (default: yesterday). Idempotent — upserts.
 * @param {string} [dayISO] YYYY-MM-DD
 */
async function runOnce(dayISO = yesterdayISO()) {
  if (!postgresPool.isEnabled() || !config.analytics.enabled) {
    return { ok: false, reason: 'analytics_disabled' };
  }
  await postgresPool.query(ROLLUP_SQL, [dayISO, START_EVENTS, COMPLETE_EVENTS]);
  logger.info(`usageRollup: rolled up ${dayISO}`);
  return { ok: true, day: dayISO };
}

let _timer = null;

/** Millis until the next 02:00 local time. */
function msUntilNextRun(now = new Date()) {
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Schedule the nightly run (no-op when analytics disabled). */
function start() {
  if (!postgresPool.isEnabled() || !config.analytics.enabled) return;
  const arm = () => {
    _timer = setTimeout(() => {
      runOnce().catch((e) => logger.error(`usageRollup nightly failed: ${e.message}`));
      arm(); // schedule tomorrow's 02:00
    }, msUntilNextRun());
    _timer.unref?.();
  };
  arm();
  logger.info(`usageRollup: nightly scheduler armed (next in ${Math.round(msUntilNextRun() / 60000)} min)`);
}

function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = {
  runOnce, start, stop,
  _internals: { ROLLUP_SQL, yesterdayISO, msUntilNextRun, START_EVENTS, COMPLETE_EVENTS },
};
