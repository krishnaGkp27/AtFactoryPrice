'use strict';

/**
 * baleMovementLog — BMV-1 (owner, 03-Aug-2026).
 *
 * The owner capped the Inventory sheet at TWO movement attributes:
 *
 *   X prev_state    "<status> @ <warehouse it was in / came from>"
 *   Y state_since   the BUSINESS date the current state began
 *
 * so the ROW carries one hop and the HISTORY carries the whole chain.
 * The history lives in the existing **AuditLog sheet** (owner's ruling —
 * no new log sheet), one row per BALE per transition:
 *
 *   Timestamp | bale.moved | {bale, from, to, on, ref, …} | user
 *
 * Bales move whole, so a 43-bale dispatch appends 43 rows in ONE call.
 * Than-level events (a partial sale, a single-than return) carry `thans`
 * so the row still reads truthfully without exploding into one row per
 * than.
 *
 * The date recorded is always the PHYSICAL/business date — the day Abdul
 * says the goods left, the sale date, the intake date — never the machine
 * write time, which stays in Inventory column P (UpdatedAt) and in this
 * log's own Timestamp column.
 */

const auditLogRepository = require('../repositories/auditLogRepository');
const logger = require('../utils/logger');

/** Canonical "state @ warehouse" label used in prev_state and the log. */
function stateLabel(status, warehouse) {
  const st = String(status || '').trim() || 'unknown';
  const wh = String(warehouse || '').trim();
  return wh ? `${st} @ ${wh}` : st;
}

/** ISO business day; falls back to today when a caller has no date. */
function businessDay(on) {
  const raw = String(on || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/**
 * The pair written to Inventory X/Y for a row entering a new state.
 * @param {object} row the row BEFORE the change (its status/warehouse are
 *        the state being left; `fromWarehouse` overrides when the row's own
 *        warehouse column has already been rewritten — an in-transit row
 *        carries the DESTINATION, so the origin must be passed in).
 * @param {{on?:string, fromWarehouse?:string}} [opts]
 * @returns {{prevState:string, stateSince:string}}
 */
function pairFor(row, opts = {}) {
  const wh = opts.fromWarehouse !== undefined && opts.fromWarehouse !== null
    ? opts.fromWarehouse : (row && row.warehouse);
  return {
    prevState: stateLabel(row && row.status, wh),
    stateSince: businessDay(opts.on),
  };
}

/**
 * Append one `bale.moved` row per distinct bale in `rows`.
 *
 * @param {Array<object>} rows the Inventory rows that moved (one per than)
 * @param {{to:string, toWarehouse?:string, fromWarehouse?:string,
 *          on?:string, ref?:string, kind?:string, user?:string}} m
 *        `to` is the new status; `kind` names the event
 *        (dispatch/receive/reject/sale/return/intake/repair).
 * @returns {Promise<number>} rows appended (0 on any failure — logging must
 *          never break a stock movement)
 */
async function record(rows, m = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return 0;
  const on = businessDay(m.on);
  const byBale = new Map();
  for (const r of list) {
    const key = `${r.design || ''}|${r.packageNo || r.baleUid || '?'}`;
    if (!byBale.has(key)) {
      byBale.set(key, {
        bale: String(r.packageNo || ''),
        design: String(r.design || ''),
        shade: String(r.shade || ''),
        container: String(r.arrivalBatch || ''),
        thans: 0,
        thanNos: [],
        from: stateLabel(r.status, m.fromWarehouse !== undefined && m.fromWarehouse !== null
          ? m.fromWarehouse : r.warehouse),
      });
    }
    const e = byBale.get(key);
    e.thans += 1;
    if (r.thanNo) e.thanNos.push(r.thanNo);
  }
  const events = [...byBale.values()].map((e) => ({
    eventType: 'bale.moved',
    payload: {
      bale: e.bale,
      design: e.design,
      shade: e.shade,
      container: e.container || undefined,
      thans: e.thans,
      thanNos: e.thanNos.length && e.thanNos.length <= 12 ? e.thanNos.sort((a, b) => a - b) : undefined,
      from: e.from,
      to: stateLabel(m.to, m.toWarehouse),
      on,
      kind: m.kind || 'move',
      ref: m.ref || undefined,
    },
    user: String(m.user || 'system'),
  }));
  try {
    await auditLogRepository.appendMany(events);
    return events.length;
  } catch (e) {
    // The physical move already happened; a failed log must not undo it.
    logger.warn(`baleMovementLog: append failed (${events.length} events): ${e.message}`);
    return 0;
  }
}

module.exports = { record, pairFor, stateLabel, businessDay };
