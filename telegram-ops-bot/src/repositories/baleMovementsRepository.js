'use strict';

/**
 * Data access for the **BaleMovements** sheet — BMV-1 (owner, 03-Aug-2026:
 * "don't add any unnecessary columns in inventory sheet, but you can add in
 * different sheet").
 *
 * One row per BALE per state change. Inventory stays exactly as it was: its
 * Status + Warehouse remain the current truth, and this sheet answers the
 * two questions the sheet could never answer before — *since when*, and
 * *what came before*.
 *
 * Columns:
 *   A Timestamp   when the bot wrote the row (machine clock)
 *   B MovedOn     the BUSINESS date of the move — the day the goods
 *                 physically left, the sale date, the return date. This is
 *                 the column to filter and sort on.
 *   C BaleNo      the printed bale number (BUSINESS_RULES §1)
 *   D Design
 *   E Shade
 *   F Container   arrival_batch
 *   G Thans       how many than rows moved in this event
 *   H FromState   "available @ IDUMOTA"
 *   I ToState     "in_transit @ Kano office"
 *   J Kind        dispatch | receive | reject | sale | return | repair
 *   K Ref         transfer id, customer — whatever identifies the event
 *   L User        who did it
 *   M Current     'YES' on the bale's most recent row, else blank
 *
 * `Current` is what makes the everyday question a ONE-filter answer:
 * `Current = YES` + `ToState` starting `in_transit` is exactly what is on
 * the road right now, with `MovedOn` telling you since when. Appending a
 * new row for a bale clears the flag on its previous rows.
 *
 * Append-only otherwise: rows are never edited or deleted, so the full
 * chain of every bale survives.
 */

const sheets = require('./sheetsClient');

const SHEET = 'BaleMovements';
const HEADERS = ['Timestamp', 'MovedOn', 'BaleNo', 'Design', 'Shade', 'Container',
  'Thans', 'FromState', 'ToState', 'Kind', 'Ref', 'User', 'Current'];
const CURRENT_COL = 'M';
const CURRENT_YES = 'YES';

let _headerReady = false;

function str(v) { return (v ?? '').toString().trim(); }

async function ensureHeader() {
  if (_headerReady) return;
  const rows = await sheets.readRange(SHEET, 'A1:M1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await sheets.updateRange(SHEET, 'A1:M1', [HEADERS]);
  }
  _headerReady = true;
}

/** Parse a sheet row (A=0) into an object; rowIndex is 1-based. */
function parseRow(r, rowIndex) {
  return {
    rowIndex,
    timestamp: str(r[0]),
    movedOn: str(r[1]),
    baleNo: str(r[2]),
    design: str(r[3]),
    shade: str(r[4]),
    container: str(r[5]),
    thans: parseInt(r[6], 10) || 0,
    fromState: str(r[7]),
    toState: str(r[8]),
    kind: str(r[9]),
    ref: str(r[10]),
    user: str(r[11]),
    current: str(r[12]).toUpperCase() === CURRENT_YES,
  };
}

/** Every movement row. */
async function getAll() {
  try {
    const rows = await sheets.readRange(SHEET, 'A2:M');
    return rows.map((r, i) => parseRow(r, i + 2)).filter((r) => r.baleNo || r.toState);
  } catch (_) {
    return [];
  }
}

/**
 * The identity a `Current` flag is tracked against. A printed bale number
 * is legitimately re-used across arrivals (BUSINESS_RULES §5), so the
 * container joins the key — otherwise a new Jul26 bale 869 would clear the
 * flag on the Mar26 bale that shares its number.
 */
function baleKey(design, baleNo, container) {
  return `${str(design).toUpperCase()}|${str(baleNo).toUpperCase()}|${str(container).toUpperCase()}`;
}

/**
 * Append movement rows and move the `Current` flag onto them.
 *
 * @param {Array<object>} entries {movedOn, baleNo, design, shade, container,
 *        thans, fromState, toState, kind, ref, user}
 * @returns {Promise<number>} rows appended
 */
async function append(entries) {
  const list = (entries || []).filter(Boolean);
  if (!list.length) return 0;
  await ensureHeader();

  // Clear the flag on whatever was current for these bales. Done BEFORE the
  // append so a crash in between leaves zero current rows (recoverable and
  // visibly wrong) rather than two (silently wrong).
  const keys = new Set(list.map((e) => baleKey(e.design, e.baleNo, e.container)));
  try {
    const existing = await getAll();
    const stale = existing.filter((r) => r.current && keys.has(baleKey(r.design, r.baleNo, r.container)));
    if (stale.length) {
      await sheets.batchUpdateRanges(SHEET, stale.map((r) => ({
        range: `${CURRENT_COL}${r.rowIndex}:${CURRENT_COL}${r.rowIndex}`,
        values: [['']],
      })));
    }
  } catch (_) {
    // A failed flag sweep must not block the movement record itself; the
    // worst case is two rows flagged current for one bale, which reads as
    // an anomaly rather than losing history.
  }

  const now = new Date().toISOString();
  const rows = list.map((e) => [
    now,
    str(e.movedOn),
    str(e.baleNo),
    str(e.design),
    str(e.shade),
    str(e.container),
    e.thans || '',
    str(e.fromState),
    str(e.toState),
    str(e.kind),
    str(e.ref),
    str(e.user),
    CURRENT_YES,
  ]);
  await sheets.appendRows(SHEET, rows);
  return rows.length;
}

/** Every movement of one bale, oldest first. */
async function historyFor(baleNo, opts = {}) {
  const all = await getAll();
  const n = str(baleNo).toUpperCase();
  return all.filter((r) => r.baleNo.toUpperCase() === n
    && (!opts.design || str(r.design).toUpperCase() === str(opts.design).toUpperCase())
    && (!opts.container || str(r.container).toUpperCase() === str(opts.container).toUpperCase()));
}

/** The current row for each bale (the one carrying the flag). */
async function currentRows() {
  return (await getAll()).filter((r) => r.current);
}

module.exports = {
  SHEET, HEADERS, ensureHeader, getAll, append, historyFor, currentRows,
  _internals: { parseRow, baleKey, CURRENT_YES },
};
