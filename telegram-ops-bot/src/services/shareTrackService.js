'use strict';

/**
 * SHR-1 — share-event recording + admin summaries.
 *
 * Gated on DATABASE_URL ONLY (postgresPool.isEnabled) — share tracking is
 * product data, not telemetry, so ANALYTICS_ENABLED does not apply. Without
 * Postgres every write is a silent no-op: links keep working, numbers start
 * the day the owner sets DATABASE_URL.
 *
 * record() is fire-and-forget by contract: never throws, never awaited by
 * callers on a hot path (page loads log via .catch(()=>{})).
 */

const postgresPool = require('../db/postgresPool');
const { DDL_STATEMENTS } = require('../db/shareSchema');
const logger = require('../utils/logger');

function isEnabled() { return postgresPool.isEnabled(); }

/** Idempotent bootstrap; no-op without DATABASE_URL (extSchema pattern). */
async function ensureSchema() {
  if (!isEnabled()) return false;
  try {
    for (const ddl of DDL_STATEMENTS) await postgresPool.query(ddl);
    logger.info('shareSchema: share_events ready');
    return true;
  } catch (e) {
    logger.error(`shareSchema ensure failed: ${e.message}`);
    return false;
  }
}

/**
 * Insert one event. Resolves false when disabled or on failure — never throws.
 * @param {{event:string, token:string, design:string, customerId?:string,
 *          mintedBy?:string, gen?:number, ua?:string, meta?:object}} e
 */
async function record(e) {
  if (!isEnabled() || !e || !e.event || !e.token) return false;
  try {
    await postgresPool.query(
      `INSERT INTO share_events (event, token, design, customer_id, minted_by, gen, ua, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [String(e.event), String(e.token), String(e.design || '').toUpperCase(),
        e.customerId || null, e.mintedBy || null, Number(e.gen) || 0,
        e.ua ? String(e.ua).slice(0, 160) : null,
        JSON.stringify(e.meta && typeof e.meta === 'object' ? e.meta : {})],
    );
    return true;
  } catch (err) {
    logger.warn(`shareTrack.record failed (ignored): ${err.message}`);
    return false;
  }
}

/**
 * Per-design totals + per-customer first-hop rows for the admin page.
 * @param {number} days lookback window (1–365)
 * @returns {Promise<null | {days:number, designs:Array, customers:Array}>}
 *          null when Postgres is disabled.
 */
async function summary(days) {
  if (!isEnabled()) return null;
  const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  const since = `now() - interval '1 day' * $1`;
  const byDesign = await postgresPool.query(
    `SELECT design,
            count(*) FILTER (WHERE event = 'created')  AS created,
            count(*) FILTER (WHERE event = 'open')     AS opens,
            count(*) FILTER (WHERE event = 'share')    AS shares,
            count(*) FILTER (WHERE event = 'download') AS downloads,
            count(DISTINCT customer_id) FILTER (WHERE event = 'created' AND customer_id IS NOT NULL AND customer_id <> '') AS customers
     FROM share_events WHERE ts >= ${since}
     GROUP BY design ORDER BY opens DESC, created DESC LIMIT 100`, [d]);
  const byCustomer = await postgresPool.query(
    `SELECT customer_id, design,
            count(*) FILTER (WHERE event = 'created')  AS created,
            count(*) FILTER (WHERE event = 'open')     AS opens,
            count(*) FILTER (WHERE event = 'download') AS downloads
     FROM share_events
     WHERE ts >= ${since} AND customer_id IS NOT NULL AND customer_id <> ''
     GROUP BY customer_id, design ORDER BY opens DESC, created DESC LIMIT 200`, [d]);
  return {
    days: d,
    designs: (byDesign && byDesign.rows) || [],
    customers: (byCustomer && byCustomer.rows) || [],
  };
}

module.exports = { isEnabled, ensureSchema, record, summary };
