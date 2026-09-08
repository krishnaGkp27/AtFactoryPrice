'use strict';

/**
 * soldDateRepair — ISC-1 Phase 2a, the planning half of
 * scripts/repair-inventory-sold-dates.js.
 *
 * WHY (specs/ISC-1_INVENTORY_SHEET_CLEANUP.md §2a). Column M (SoldDate) on
 * Inventory holds 105 sold rows whose cell reads `cashmere 12-February-2026`
 * or `cashmere 2026-07-27` — a product word typed into the date by hand.
 * normalizeSalesDate returns null for them, so those 21 bales fall outside
 * every date window and sort after every real day. Other M cells are TEXT
 * cells holding a date-shaped string ('07 April 2026', '13-04-2026'): the
 * bot reads them, but a Sheets date filter never will — to Sheets they are
 * words.
 *
 * WHAT THIS DECIDES, per row, from two reads of the same range — the
 * FORMATTED cells (what the bot and the owner see) and the UNFORMATTED M
 * cell (what Sheets stores: a number for a real date, a string for text):
 *   (a) sold + text + the normaliser fails but the salvage succeeds
 *       → plan: write the salvaged ISO day;
 *   (b) sold + text + the normaliser already reads an ISO day
 *       → plan: write that same day so Sheets stores a real date;
 *   date-typed cell (unformatted value is a number) → never touched, its
 *       DISPLAY is scripts/format-date-columns.js's job;
 *   not sold → never touched;
 *   sold + text that nothing parses, a relative word ('today' means the
 *       day it was typed, not the day the script runs), a blank, or a cell
 *       whose two renders disagree → reported, never guessed.
 *
 * INVARIANT. Every planned ISO day is fed back through normalizeSalesDate
 * and must come out unchanged: what is written must read back as the same
 * day. A violation throws — the normaliser and the salvage disagree, and
 * no write is safe until they do not. That check sees only the string in
 * memory; what the bot reads AFTER the write is the cell's rendered
 * display, which a per-cell number format decides — so the script reads
 * every written cell back and verifyAfterWrite checks the sheet's own
 * rendering against the plan.
 *
 * Pure: no I/O. The script owns the reads, the CUS-ID1 re-read guard
 * (verifyBeforeWrite is its per-row check), the write and the read-back
 * (verifyAfterWrite is its per-row check).
 */

const { normalizeSalesDate, salvageSalesDate } = require('../utils/dates');

const SHEET = 'Inventory';
/** Columns read: A (PackageNo) … M (SoldDate). Nothing to the right is needed. */
const FORMATTED_RANGE = 'A2:M';
/** Column M alone: read unformatted to know each cell's stored TYPE, and read formatted after the write to see what the bot reads now. */
const SOLD_DATE_RANGE = 'M2:M';
/** The one column whose stored TYPE decides the verdict. */
const UNFORMATTED_RANGE = SOLD_DATE_RANGE;
/** Row 1 is the header; both ranges start at row 2. */
const FIRST_ROW = 2;
/** The only column the repair ever writes. */
const SOLD_DATE_COLUMN = 'M';
/** 0-based indexes inside an A:M row. */
const COL = { packageNo: 0, design: 3, thanNo: 5, status: 7, soldTo: 11, soldDate: 12 };
/** The identity cells a row must still show before its M cell is written. */
const IDENTITY_KEYS = ['packageNo', 'design', 'thanNo', 'soldTo'];

const RELATIVE_WORD = /^(today|yesterday)$/i;
const REASON_LABEL = { a: 'stray word(s) stripped', b: 'text cell, already readable' };

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Classify one Inventory row.
 *
 * @param {object} args
 * @param {number} args.rowIndex 1-based sheet row
 * @param {Array} args.formatted cells A..M as readRange returns them
 * @param {*} args.unformatted the M cell as readRangeUnformatted returns it
 *   (number for a date cell, string for text, undefined when blank)
 * @returns {{verdict:'plan', entry:object}|{verdict:'skip', why:string}}
 *   `why` is one of: not-sold · blank · date-typed · odd-cell-type ·
 *   relative-word · unparseable. A plan entry carries rowIndex, the four
 *   identity cells, `current` (the text now), `proposed` (the ISO day) and
 *   `reason` 'a' | 'b'.
 */
function classifyRow({ rowIndex, formatted, unformatted }) {
  const cells = formatted || [];
  if (str(cells[COL.status]).toLowerCase() !== 'sold') return { verdict: 'skip', why: 'not-sold', rowIndex };

  const identity = { rowIndex };
  for (const k of IDENTITY_KEYS) identity[k] = str(cells[COL[k]]);
  const current = str(cells[COL.soldDate]);
  const skip = (why, detail) => ({ verdict: 'skip', why, ...identity, current, ...(detail ? { detail } : {}) });

  if (!current) return skip('blank');
  if (typeof unformatted === 'number') return skip('date-typed');
  if (typeof unformatted !== 'string') return skip('odd-cell-type', `stored value is ${typeof unformatted}`);
  if (str(unformatted) !== current) return skip('odd-cell-type', `stored text "${str(unformatted)}" differs from the display`);

  const salvage = salvageSalesDate(current);
  if (RELATIVE_WORD.test(salvage.stripped)) return skip('relative-word');

  let proposed = normalizeSalesDate(current);
  let reason = 'b';
  if (!proposed && salvage.iso) { proposed = salvage.iso; reason = 'a'; }
  if (!proposed) return skip('unparseable');

  // What is written must read back as the same day.
  if (normalizeSalesDate(proposed) !== proposed) {
    throw new Error(`row ${rowIndex}: "${current}" → "${proposed}" does not read back as itself — normaliser and salvage disagree`);
  }
  return { verdict: 'plan', entry: { ...identity, current, proposed, reason } };
}

/**
 * Plan the whole repair from the two reads.
 *
 * @param {object} args
 * @param {Array<Array>} args.formattedRows Inventory A2:M, formatted
 * @param {Array<Array>} args.unformattedRows Inventory M2:M, unformatted
 * @param {Set<number>|null} [args.rows] rehearsal filter: only these sheet rows
 * @param {string|null} [args.design] rehearsal filter: only this design (case-insensitive)
 * @returns {{plan:object[], reported:object[], counts:object}} plan entries
 *   in sheet order; `reported` are the sold rows that could not be planned
 *   (with their `why`); counts of scanned / filtered / sold / dateTyped /
 *   planned / reported rows
 */
function planRepairs({ formattedRows, unformattedRows, rows = null, design = null }) {
  const counts = { scanned: 0, filtered: 0, sold: 0, dateTyped: 0, planned: 0, reported: 0 };
  const plan = [];
  const reported = [];
  const wantDesign = design ? str(design).toUpperCase() : null;

  (formattedRows || []).forEach((formatted, i) => {
    const rowIndex = FIRST_ROW + i;
    counts.scanned += 1;
    if (rows && !rows.has(rowIndex)) { counts.filtered += 1; return; }
    if (wantDesign && str((formatted || [])[COL.design]).toUpperCase() !== wantDesign) { counts.filtered += 1; return; }

    const unformatted = ((unformattedRows || [])[i] || [])[0];
    const v = classifyRow({ rowIndex, formatted, unformatted });
    if (v.verdict === 'skip' && v.why === 'not-sold') return;
    counts.sold += 1;
    if (v.verdict === 'plan') { plan.push(v.entry); return; }
    if (v.why === 'date-typed') { counts.dateTyped += 1; return; }
    reported.push(v);
  });

  counts.planned = plan.length;
  counts.reported = reported.length;
  return { plan, reported, counts };
}

/**
 * The CUS-ID1 guard, per row: is the cell still exactly what the plan saw?
 * Called with a FRESH read taken immediately before the write.
 *
 * @param {object} entry a plan entry
 * @param {Array} freshFormatted that row's A..M cells, re-read
 * @param {*} freshUnformatted that row's M cell, re-read unformatted
 * @returns {{ok:true}|{ok:false, why:string}}
 */
function verifyBeforeWrite(entry, freshFormatted, freshUnformatted) {
  const cells = freshFormatted || [];
  const now = str(cells[COL.soldDate]);
  if (now !== entry.current) return { ok: false, why: `SoldDate now reads "${now}"` };
  if (typeof freshUnformatted === 'number') return { ok: false, why: 'the cell is now a real date' };
  if (typeof freshUnformatted !== 'string') return { ok: false, why: `stored value is now ${typeof freshUnformatted}` };
  if (str(cells[COL.status]).toLowerCase() !== 'sold') return { ok: false, why: `Status now reads "${str(cells[COL.status])}"` };
  for (const k of IDENTITY_KEYS) {
    if (str(cells[COL[k]]) !== entry[k]) return { ok: false, why: `${k} now reads "${str(cells[COL[k]])}"` };
  }
  return { ok: true };
}

/**
 * The read-back, per row: now that Sheets holds what was written, does the
 * bot still read the planned day? Called with a FRESH read of column M
 * (formatted and unformatted) taken immediately after the write.
 *
 * A TEXT cell can carry any number format without showing it — formats do
 * not render on strings, and the values API never reports them. The moment
 * USER_ENTERED turns the cell into a date, that format decides the display,
 * and the display is what every bot reader parses. With
 * scripts/format-date-columns.js run first (spec §4 Phase 0a) every M cell
 * renders `07-April-2026`; a stray `dd/mm/yy` would render `07/04/26`
 * (the normaliser needs a 4-digit year → null → the sale drops out of every
 * window — the defect this repair exists to fix, created on a row that was
 * fine) and `m/d/yyyy` would render `4/7/2026` (read DMY as 4 July —
 * silently the wrong day, and no sentinel fires because it normalises).
 * Neither is knowable before writing, so the script looks afterwards.
 *
 * @param {object} entry a written plan entry
 * @param {*} displayCell that row's M cell, re-read formatted
 * @param {*} storedCell that row's M cell, re-read unformatted
 * @returns {{ok:boolean, display:string, readBack:(string|null), storedAsDate:boolean, why?:string}}
 *   `ok` is false when the display does not read back as `entry.proposed`
 *   (`why` says what it shows and what that reads as). `storedAsDate` is
 *   false when Sheets still holds TEXT — a plain-text number format on the
 *   cell, which 0a replaces: the day is right, the date filter still
 *   cannot see it.
 */
function verifyAfterWrite(entry, displayCell, storedCell) {
  const display = str(displayCell);
  const readBack = normalizeSalesDate(display);
  const storedAsDate = typeof storedCell === 'number';
  if (readBack !== entry.proposed) {
    return {
      ok: false, display, readBack, storedAsDate,
      why: `now displays "${display}", which reads back as ${readBack || 'nothing'} — wanted ${entry.proposed}`,
    };
  }
  return { ok: true, display, readBack, storedAsDate };
}

/**
 * Parse the `--rows` rehearsal filter: `12,13-40` → Set{12, 13, …, 40}.
 * Throws on anything that is not a row number or a low-high range.
 *
 * @param {string} text
 * @returns {Set<number>}
 */
function parseRowsArg(text) {
  const out = new Set();
  for (const part of String(text || '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`--rows: "${part}" is not a row number or a low-high range`);
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a < FIRST_ROW || b < a) throw new Error(`--rows: "${part}" must name rows ≥ ${FIRST_ROW}, low then high`);
    for (let r = a; r <= b; r += 1) out.add(r);
  }
  if (!out.size) throw new Error('--rows: no rows given');
  return out;
}

module.exports = {
  SHEET,
  FORMATTED_RANGE,
  SOLD_DATE_RANGE,
  UNFORMATTED_RANGE,
  FIRST_ROW,
  SOLD_DATE_COLUMN,
  COL,
  REASON_LABEL,
  classifyRow,
  planRepairs,
  verifyBeforeWrite,
  verifyAfterWrite,
  parseRowsArg,
};
