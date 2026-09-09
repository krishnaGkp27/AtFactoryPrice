'use strict';

/**
 * shadeSpellingRepair — ISC-1 Phase 2d (ruling R4): the pure half of
 * scripts/repair-shade-spellings.js.
 *
 * WHY. The 04-Sep-2026 Inventory census (specs/ISC-1_INVENTORY_SHEET_CLEANUP.md
 * §2c) found design 75142 storing its shades as `2-6.`, `4-5.`, `7-3.`
 * (bales 6485, 6483, 6486) while 77018/950 stores `4-5`. Every shade picker
 * keys its chips on the raw cell — upper-cased, never dot-stripped — so
 * `4-5` and `4-5.` sit side by side as two chips for one shade, and a
 * design-wide lookup for `4-5` misses the dotted rows.
 *
 * WHAT (R4's recommended answer, built exactly and nothing broader): a cell
 * whose trailing dot(s) are the only difference is rewritten without them.
 * No case changes, no BLACK → number mapping, and none of the 188 blank
 * shades (§2c) are filled — those are listed for the owner and left alone.
 * A cell that would become BLANK after the strip (dots and nothing else) is
 * refused, never written: this repair removes dots, it never removes a shade.
 *
 * GUARDS (the CUS-ID1 pattern, src/services/customerIdRepair.js): the
 * script re-reads every target row immediately before writing and a cell is
 * written ONLY when its design, bale number, than number and raw shade all
 * still match the plan (verifyPlan). A sorted sheet (§2f — row position is
 * the legacy key), a re-keyed row or a hand edit in between makes the row a
 * reported skip, never a guess. Column E is the only cell ever written.
 */

const cell = (v) => (v === null || v === undefined ? '' : String(v));
const upper = (v) => cell(v).trim().toUpperCase();
const num = (v) => Number(v) || 0;

/**
 * The R4 canonical spelling of a shade: trimmed, trailing dot(s) removed,
 * nothing else touched.
 *   '4-5.'  → '4-5'     '2-6..' → '2-6'     'BLACK' → 'BLACK'
 *   '4.5'   → '4.5'     (the dot is not trailing)         '' → ''
 * @param {*} raw the shade cell as read
 * @returns {string}
 */
function canonicalShade(raw) {
  return cell(raw).trim().replace(/\.+$/, '').trim();
}

/**
 * Shape raw Inventory rows (A2:F or wider, as sheetsClient.readRange
 * returns them) into the row objects the planner reads. The shade is kept
 * RAW — untrimmed — because the write guard compares it to the live cell
 * character for character.
 * @param {Array<Array<*>>} cells rows starting at sheet row `firstRow`
 * @param {number} [firstRow=2] sheet row number of cells[0]
 * @returns {Array<{rowIndex:number, packageNo:string, design:string, shade:string, thanNo:number}>}
 */
function rowsFromCells(cells, firstRow = 2) {
  return (cells || []).map((r, i) => {
    const row = r || [];
    return {
      rowIndex: i + firstRow,
      packageNo: cell(row[0]).trim(),
      design: cell(row[3]).trim(),
      shade: cell(row[4]),
      thanNo: num(row[5]),
    };
  });
}

/** A row that carries a bale or a design — blank spacer rows are ignored everywhere. */
function isRecord(row) {
  return !!(row && (cell(row.packageNo).trim() || cell(row.design).trim()));
}

/** Case-insensitive design filter; no filter matches every row. */
function matchesDesign(row, design) {
  return !design || upper(row.design) === upper(design);
}

/**
 * How many Inventory records (rows carrying a bale or a design) the design
 * filter matches. The filter is exact (case aside), so a mistyped
 * `--design 9043A` for `9043-A` matches nothing — and an empty plan plus an
 * empty blank-shade list for a design that does not exist would read as
 * "that design is clean". The script refuses to run on zero.
 * @param {Array<object>} rows from rowsFromCells
 * @param {{design?: string}} [opts] optional case-insensitive design filter
 * @returns {number}
 */
function countRecords(rows, { design } = {}) {
  let n = 0;
  for (const row of rows || []) if (isRecord(row) && matchesDesign(row, design)) n += 1;
  return n;
}

/**
 * The rows whose stored shade differs from its canonical spelling — the
 * cells the script will rewrite. A row whose canonical form is blank (dots
 * only) is NOT planned; see blankAfterStripRows.
 * @param {Array<object>} rows from rowsFromCells (rowIndex/design/packageNo/thanNo/shade)
 * @param {{design?: string}} [opts] optional case-insensitive design filter
 * @returns {Array<{rowIndex:number, design:string, packageNo:string, thanNo:number, current:string, next:string}>}
 */
function buildPlan(rows, { design } = {}) {
  const plan = [];
  for (const row of rows || []) {
    if (!isRecord(row) || !matchesDesign(row, design)) continue;
    const current = cell(row.shade);
    const next = canonicalShade(current);
    if (next === current || !next) continue;
    plan.push({
      rowIndex: row.rowIndex,
      design: cell(row.design).trim(),
      packageNo: cell(row.packageNo).trim(),
      thanNo: num(row.thanNo),
      current,
      next,
    });
  }
  return plan;
}

/**
 * Rows with no shade at all — the §2c gaps (e.g. three 9043-A Mar26 rows).
 * REPORT ONLY: the owner supplies those shades; this repair never fills one.
 * @param {Array<object>} rows from rowsFromCells
 * @param {{design?: string}} [opts] optional case-insensitive design filter
 * @returns {Array<{design:string, packageNo:string, rowIndex:number}>}
 */
function blankShadeRows(rows, { design } = {}) {
  const out = [];
  for (const row of rows || []) {
    if (!isRecord(row) || !matchesDesign(row, design)) continue;
    if (cell(row.shade).trim() !== '') continue;
    out.push({ design: cell(row.design).trim(), packageNo: cell(row.packageNo).trim(), rowIndex: row.rowIndex });
  }
  return out;
}

/**
 * Rows whose cell is dots and nothing else ('.', '..'): stripping would
 * leave a BLANK shade, which R4 does not license. Reported, never written.
 * @param {Array<object>} rows from rowsFromCells
 * @param {{design?: string}} [opts] optional case-insensitive design filter
 * @returns {Array<{design:string, packageNo:string, rowIndex:number, current:string}>}
 */
function blankAfterStripRows(rows, { design } = {}) {
  const out = [];
  for (const row of rows || []) {
    if (!isRecord(row) || !matchesDesign(row, design)) continue;
    const current = cell(row.shade);
    if (current.trim() === '' || canonicalShade(current) !== '') continue;
    out.push({
      design: cell(row.design).trim(), packageNo: cell(row.packageNo).trim(), rowIndex: row.rowIndex, current,
    });
  }
  return out;
}

/**
 * The write guard. `live` is the sheet re-read moments before writing (the
 * same range, through rowsFromCells again). A plan entry is ready only when
 * the live row at the same index still carries the same design, bale
 * number, than number and the exact raw shade the plan was built from;
 * anything else is a skip with the reason spelled out.
 * @param {Array<object>} plan from buildPlan
 * @param {Array<object>} live from rowsFromCells
 * @returns {{ready: Array<object>, skipped: Array<{rowIndex:number, why:string}>}}
 */
function verifyPlan(plan, live) {
  const byRow = new Map((live || []).map((r) => [r.rowIndex, r]));
  const ready = [];
  const skipped = [];
  for (const p of plan || []) {
    const row = byRow.get(p.rowIndex);
    if (!row) { skipped.push({ rowIndex: p.rowIndex, why: 'row no longer exists' }); continue; }
    const diffs = [];
    if (cell(row.design).trim() !== p.design) diffs.push(`design is now "${cell(row.design).trim()}"`);
    if (cell(row.packageNo).trim() !== p.packageNo) diffs.push(`bale is now "${cell(row.packageNo).trim()}"`);
    if (num(row.thanNo) !== num(p.thanNo)) diffs.push(`than is now ${num(row.thanNo)}`);
    if (cell(row.shade) !== p.current) diffs.push(`shade is now "${cell(row.shade)}"`);
    if (diffs.length) { skipped.push({ rowIndex: p.rowIndex, why: diffs.join(', ') }); continue; }
    ready.push(p);
  }
  return { ready, skipped };
}

module.exports = {
  canonicalShade,
  rowsFromCells,
  countRecords,
  buildPlan,
  blankShadeRows,
  blankAfterStripRows,
  verifyPlan,
};
