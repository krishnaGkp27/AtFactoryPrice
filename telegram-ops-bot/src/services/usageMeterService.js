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
const { todayInLagos: _todayIso } = require('../utils/dates');

// Fallback store: 'day|channel|kind' → count. Also used as a same-process
// cache for cap checks so a PG blip can never disable the cost caps.
const _mem = new Map();

/**
 * EXT-1 — ATOMIC daily-cap reservation (fixes the read-then-send TOCTOU
 * that let concurrent requests overshoot EXT_OTP_DAILY_CAP). Increments a
 * single global counter and returns false if that pushes it past `cap`,
 * so exactly `cap` slots are ever handed out no matter the concurrency.
 * @returns {Promise<boolean>} true = a slot is yours; send. false = cap hit.
 */
async function reserve(kind, cap) {
  // Defensive: a non-finite cap must fail CLOSED (never authorise a send),
  // so a bad Settings value can't silently disable the money ceiling.
  if (!Number.isFinite(cap) || cap < 0) return false;
  const day = _todayIso();
  const key = `${day}|_all|${kind}`;
  // Memory path is atomic: single-threaded, no await between read & write.
  if (!pool.isEnabled()) {
    const cur = _mem.get(key) || 0;
    if (cur >= cap) return false;
    _mem.set(key, cur + 1);
    return true;
  }
  try {
    const r = await pool.query(
      `INSERT INTO channel_usage (day, channel, kind, count) VALUES ($1, '_all', $2, 1)
       ON CONFLICT (day, channel, kind) DO UPDATE SET count = channel_usage.count + 1
       RETURNING count`, [day, kind]);
    const c = Number(r.rows[0].count);
    if (c > cap) {
      // Lost the race at the boundary — hand the slot back.
      await pool.query("UPDATE channel_usage SET count = count - 1 WHERE day = $1 AND channel = '_all' AND kind = $2", [day, kind]);
      return false;
    }
    return true;
  } catch (e) {
    // FAIL CLOSED on a Postgres error: the memory counter is NOT a mirror
    // of the PG count, so falling back to it would start a fresh cap and
    // authorize up to `cap` extra PAID sends beyond the ceiling. Refusing
    // the send is the money-safe choice (the customer simply retries).
    logger.warn(`usageMeter reserve ${kind} (fail-closed): ${e.message}`);
    return false;
  }
}

/** Today's reserved-slot count for a global kind (uniform pre-check). */
async function slotsUsed(kind) {
  const day = _todayIso();
  const key = `${day}|_all|${kind}`;
  if (!pool.isEnabled()) return _mem.get(key) || 0;
  try {
    const r = await pool.query(
      "SELECT COALESCE(count,0) AS c FROM channel_usage WHERE day = $1 AND channel = '_all' AND kind = $2", [day, kind]);
    return r.rows.length ? Number(r.rows[0].c) : 0;
  } catch { return _mem.get(key) || 0; }
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

module.exports = { record, reserve, slotsUsed, todayCount, totals, _resetForTests };
