'use strict';

/**
 * stockEventsRepository — STK-PG Phase 1: the SHADOW stock-event ledger.
 *
 * One append-only Postgres row per BALE per engine event — the same grain
 * as the BaleMovements sheet, so Phase 2's parity check is a straight
 * day-by-day comparison.
 *
 * SHADOW posture (specs/STK-PG_PHASE1.md): the Sheets writes remain the
 * source of truth; this write is best-effort and FAILS OPEN — a Postgres
 * hiccup may never block a sale. The fail-closed posture arrives with the
 * truth-flip decision, not before. Rows are grouped per physical bale via
 * baleIdentity (STK-E1), so this ledger can never disagree with the rest
 * of the bot about what a bale is.
 */

const pool = require('../db/postgresPool');
const { baleKey } = require('../services/baleIdentity');
const logger = require('../utils/logger');

/**
 * Record one engine event for a set of affected Inventory rows (one row =
 * one than), grouped per physical bale. Never throws.
 *
 * @param {Array<object>} rows the Inventory rows the mutation touched
 * @param {{event:string, businessDay?:string, warehouseFrom?:string,
 *          warehouseTo?:string, customer?:string, authority:string,
 *          approvalId?:string, actor?:string}} meta
 * @returns {Promise<number>} events inserted (0 when PG is off or errored)
 */
async function record(rows, meta) {
  if (!pool.isEnabled()) return 0;
  const list = (rows || []).filter(Boolean);
  if (!list.length || !meta || !meta.event) return 0;
  try {
    const byBale = new Map();
    for (const r of list) {
      const k = baleKey(r);
      if (!byBale.has(k)) {
        byBale.set(k, {
          design: String(r.design || ''), baleNo: String(r.packageNo || ''),
          container: String(r.arrivalBatch || ''), shade: String(r.shade || ''),
          thans: 0,
          warehouseFrom: meta.warehouseFrom !== undefined ? String(meta.warehouseFrom || '') : String(r.warehouse || ''),
          warehouseTo: meta.warehouseTo !== undefined ? String(meta.warehouseTo || '') : String(r.warehouse || ''),
        });
      }
      byBale.get(k).thans += 1;
    }
    const day = /^\d{4}-\d{2}-\d{2}/.test(String(meta.businessDay || ''))
      ? String(meta.businessDay).slice(0, 10) : null;
    let inserted = 0;
    // One transaction per event batch: either the whole engine event lands
    // in the ledger or none of it does — a half-recorded dispatch would
    // poison the Phase-2 parity numbers.
    await pool.withTransaction(async (client) => {
      for (const b of byBale.values()) {
        await client.query(
          `INSERT INTO stock_events
             (business_day, event, design, bale_no, container, shade,
              warehouse_from, warehouse_to, thans, customer, authority,
              approval_id, actor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [day, meta.event, b.design, b.baleNo, b.container, b.shade,
            b.warehouseFrom, b.warehouseTo, b.thans,
            String(meta.customer || ''), String(meta.authority || ''),
            String(meta.approvalId || ''), String(meta.actor || '')],
        );
        inserted += 1;
      }
    });
    return inserted;
  } catch (e) {
    // SHADOW: the sheet write already succeeded — never let the mirror
    // undo or block it. Phase 2's parity check is what notices the gap.
    logger.warn(`stockEvents: shadow write failed (${meta.event}): ${e.message}`);
    return 0;
  }
}

/** Per-day event counts — Phase 2 parity fodder. */
async function countsByDay(sinceDay) {
  if (!pool.isEnabled()) return [];
  try {
    const res = await pool.query(
      `SELECT business_day AS day, event, COUNT(*)::int AS n
         FROM stock_events
        WHERE business_day >= $1
        GROUP BY business_day, event
        ORDER BY business_day, event`,
      [sinceDay],
    );
    return res ? res.rows : [];
  } catch (e) {
    logger.warn(`stockEvents: countsByDay failed: ${e.message}`);
    return [];
  }
}

module.exports = { record, countsByDay };
