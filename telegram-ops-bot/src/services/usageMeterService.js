'use strict';

/**
 * EXT-1 — channel usage metering (owner 22-Jul: "there should be a metric
 * which will show me the cumulative usage… on the website").
 *
 * Every metered event (OTP sent, message sent, ledger viewed, delivery
 * failure) increments a per-day per-channel counter. Postgres when
 * available (survives restarts — the counters ARE the cost ledger),
 * in-memory otherwise. Read side feeds GET /api/ops/usage.
 */

const pool = require('../db/postgresPool');
const logger = require('../utils/logger');

// Fallback store: 'day|channel|kind' → count. Also used as a same-process
// cache for cap checks so a PG blip can never disable the cost caps.
const _mem = new Map();

function _todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
}

/** Count one (or n) events for a channel. Never throws. */
async function record(channel, kind, n = 1) {
  const day = _todayIso();
  const key = `${day}|${channel}|${kind}`;
  _mem.set(key, (_mem.get(key) || 0) + n);
  if (!pool.isEnabled()) return;
  try {
    await pool.query(
      `INSERT INTO channel_usage (day, channel, kind, count) VALUES ($1, $2, $3, $4)
       ON CONFLICT (day, channel, kind) DO UPDATE SET count = channel_usage.count + $4`,
      [day, channel, kind, n]);
  } catch (e) { logger.warn(`usageMeter record ${channel}/${kind}: ${e.message}`); }
}

/** Today's total for a kind across channels (cost-cap checks). */
async function todayCount(kind) {
  const day = _todayIso();
  let mem = 0;
  for (const [k, v] of _mem) if (k.startsWith(`${day}|`) && k.endsWith(`|${kind}`)) mem += v;
  if (!pool.isEnabled()) return mem;
  try {
    const r = await pool.query(
      'SELECT COALESCE(SUM(count),0) AS c FROM channel_usage WHERE day = $1 AND kind = $2', [day, kind]);
    const dbCount = Number(r.rows[0].c) || 0;
    // The DB is authoritative across restarts; the memory cache guards a
    // PG outage. Take the max so neither path under-counts the cap.
    return Math.max(dbCount, mem);
  } catch { return mem; }
}

/**
 * Cumulative + recent usage for the website metric.
 * @returns {{cumulative: Array<{channel,kind,count}>, last30: Array<{day,channel,kind,count}>}}
 */
async function totals() {
  if (pool.isEnabled()) {
    try {
      const cum = await pool.query(
        'SELECT channel, kind, SUM(count)::bigint AS count FROM channel_usage GROUP BY channel, kind ORDER BY channel, kind');
      const recent = await pool.query(
        `SELECT day::text, channel, kind, count FROM channel_usage
         WHERE day >= (CURRENT_DATE - INTERVAL '30 days') ORDER BY day DESC, channel`);
      return {
        cumulative: cum.rows.map((r) => ({ channel: r.channel, kind: r.kind, count: Number(r.count) })),
        last30: recent.rows.map((r) => ({ day: r.day, channel: r.channel, kind: r.kind, count: Number(r.count) })),
      };
    } catch (e) { logger.warn(`usageMeter totals: ${e.message}`); }
  }
  const agg = new Map();
  const daily = [];
  for (const [k, count] of _mem) {
    const [day, channel, kind] = k.split('|');
    const ck = `${channel}|${kind}`;
    agg.set(ck, (agg.get(ck) || 0) + count);
    daily.push({ day, channel, kind, count });
  }
  return {
    cumulative: [...agg.entries()].map(([ck, count]) => {
      const [channel, kind] = ck.split('|');
      return { channel, kind, count };
    }),
    last30: daily,
  };
}

function _resetForTests() { _mem.clear(); }

module.exports = { record, todayCount, totals, _resetForTests };
