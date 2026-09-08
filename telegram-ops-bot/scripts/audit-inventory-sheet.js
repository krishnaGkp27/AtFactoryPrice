#!/usr/bin/env node
'use strict';

/**
 * ISC-1 Phase 1a — census of the LIVE Inventory sheet
 * (specs/ISC-1_INVENTORY_SHEET_CLEANUP.md §4 step 1a; findings §2).
 *
 * The 08-Sep-2026 analysis was made from a PDF. A PDF shows what a cell
 * DISPLAYS, never its TYPE — and the whole §4 2a repair turns on whether a
 * SoldDate cell is a real date (a serial number Sheets can filter) or text
 * that merely looks like one. This script asks the live sheet the same
 * questions, reading the sheet TWICE: once formatted (A2:W — what the bot
 * parses, and the raw text of columns K DateReceived and M SoldDate) and
 * once UNFORMATTED (K2:M only — a date cell comes back as a number, a text
 * cell as a string). It then runs every inventoryAudit question, prints the
 * counts with a few examples each, and with --out files the row lists the
 * Phase 2 one-offs consume — re-run it after each one-off to confirm zero
 * remaining.
 *
 * Two reads are two snapshots joined by row position. The parsed rows and
 * the formatted K/M cells come from the ONE A2:W read, so they cannot
 * disagree; the unformatted read is a second call, and a sort or an
 * inserted row in the gap between the calls would hand every later row its
 * neighbour's cell type — silently, into sold-dates.json, the file the 2a
 * one-off consumes. So before anything is printed every row's formatted
 * cell is checked against its unformatted cell (see cellMismatch) and the
 * run ABORTS with "reads misaligned — re-run" on the first disagreement.
 *
 * READ-ONLY. It never writes to the sheet: the only client calls are
 * readRange / readRangeUnformatted, and the only files it writes are the
 * JSON lists under --out. There is deliberately no --commit. Needs the
 * bot's .env (Sheets credentials), like every other script here.
 *
 * Usage:
 *   node scripts/audit-inventory-sheet.js [--out /tmp/isc1]
 *   node scripts/audit-inventory-sheet.js --min-yards 40 --out /tmp/isc1
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const sheetsClient = require('../src/repositories/sheetsClient');
const inventoryRepository = require('../src/repositories/inventoryRepository');
const inventoryAudit = require('../src/services/inventoryAudit');
const { normalizeSalesDate } = require('../src/utils/dates');

const SHEET = 'Inventory';
/** The formatted read — the same range inventoryRepository.getAll parses. */
const ALL_COLS = 'A2:W';
/** K DateReceived and M SoldDate inside an A2:W row. */
const IDX_K = 10;
const IDX_M = 12;
/** K DateReceived · L SoldTo · M SoldDate — the one UNFORMATTED read. */
const DATE_COLS = 'K2:M';
const COL_K = 0;
const COL_M = 2;
/** Examples printed per finding — the JSON files carry every row. */
const EXAMPLES = 5;

/** The JSON files --out produces, in the order the report prints them. */
const OUT_FILES = [
  'sold-dates.json', 'oversize-thans.json', 'customer-clusters.json', 'shade-variants.json',
  'blank-shades.json', 'duplicate-uids.json', 'legacy-rows.json', 'zero-price-sold.json',
  'blank-rates.json', 'date-shapes.json',
];

/**
 * @param {string[]} argv process.argv
 * @returns {{out: string, minYards: number}}
 */
function parseArgs(argv) {
  const args = { out: '', minYards: inventoryAudit.DEFAULT_OVERSIZE_YARDS };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') { args.out = argv[i + 1] || ''; i += 1; }
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a === '--min-yards') { args.minYards = Number(argv[i + 1]); i += 1; }
    else if (a.startsWith('--min-yards=')) args.minYards = Number(a.slice('--min-yards='.length));
    else if (a === '--commit') throw new Error('this audit is read-only — there is no --commit');
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.minYards) || args.minYards <= 0) throw new Error('--min-yards must be a positive number');
  return args;
}

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const q = (s) => `"${s}"`;
const firstN = (list) => list.slice(0, EXAMPLES);
const more = (list) => (list.length > EXAMPLES ? `     …and ${list.length - EXAMPLES} more (see the JSON)` : null);
const push = (lines, ...xs) => { for (const x of xs) if (x !== null && x !== undefined) lines.push(x); };

/**
 * rowIndex → cell for ONE column of a read that starts at row 2 (A2:W or
 * K2:M). Row i of the read is sheet row i + 2; the API omits trailing blank
 * cells and rows, which read back as undefined (= blank) here.
 */
function columnMap(grid, col) {
  const map = new Map();
  (grid || []).forEach((cells, i) => { map.set(i + 2, (cells || [])[col]); });
  return map;
}

/**
 * ONE formatted A2:W read → the parsed rows exactly as inventoryRepository
 * .getAll builds them (same parseRow, same rowIndex = i + 2, same blank-row
 * filter) plus the raw K and M cells of the SAME grid. Parsed rows and
 * formatted date cells therefore share one snapshot: a row can never carry
 * another row's text.
 *
 * @param {Array<Array>} grid readRange(SHEET, 'A2:W')
 * @returns {{rows: Array<object>, fmtK: Map<number, *>, fmtM: Map<number, *>}}
 */
function loadInventory(grid) {
  const rows = (grid || [])
    .map((r, i) => inventoryRepository.parseRow(r || [], i + 2))
    .filter((r) => r.packageNo || r.design);
  return { rows, fmtK: columnMap(grid, IDX_K), fmtM: columnMap(grid, IDX_M) };
}

/**
 * Why a formatted cell and an unformatted cell cannot be the SAME cell —
 * null when they can. The two renders of one cell agree in a way two
 * different cells rarely do: blank ⇔ blank; a text cell shows the same
 * string under both renders; a date cell (a serial number) always displays
 * something, and when that display normalises to a day it is the serial's
 * day. Anything that fails these is a row re-order between the two reads,
 * not a data finding — a number the display cannot date (a plain 45, a
 * time-stamped format) is left alone rather than accused, and a cell
 * holding only whitespace is blank under BOTH renders (cellType trims), so
 * one hand-typed space can never abort every run as a "re-order".
 *
 * @param {*} formatted the FORMATTED_VALUE cell
 * @param {*} unformatted the UNFORMATTED_VALUE cell of the same row/column
 * @returns {string|null}
 */
function cellMismatch(formatted, unformatted) {
  const shown = str(formatted);
  const type = inventoryAudit.cellType(unformatted);
  if (type === 'blank') return shown ? 'formatted cell has text, unformatted cell is blank' : null;
  if (!shown) return `formatted cell is blank, unformatted cell is ${type}`;
  if (type === 'text') {
    return str(unformatted).toLowerCase() === shown.toLowerCase() ? null : 'text differs between the two renders';
  }
  const shownIso = normalizeSalesDate(shown);
  const serialIso = inventoryAudit.serialToIso(unformatted);
  if (shownIso && serialIso && shownIso !== serialIso) return `displays ${shownIso}, serial is ${serialIso}`;
  return null;
}

/**
 * Every parsed row whose formatted and unformatted cells disagree, for one
 * column. Empty means the unformatted read lines up with the A2:W snapshot
 * row for row.
 *
 * @returns {Array<{rowIndex:number, formatted:string, unformatted:*, why:string}>}
 */
function misalignedCells(rows, fmtMap, unfMap) {
  const out = [];
  for (const r of rows || []) {
    const formatted = fmtMap.get(r.rowIndex);
    const unformatted = unfMap.get(r.rowIndex);
    const why = cellMismatch(formatted, unformatted);
    if (why) out.push({ rowIndex: r.rowIndex, formatted: str(formatted), unformatted: unformatted === undefined ? '' : unformatted, why });
  }
  return out;
}

/**
 * Throws when either column disagrees — nothing downstream may run on a
 * shifted read. The message names the first rows so the owner can see it
 * was a re-order, not a data problem.
 *
 * @param {{K: Array<object>, M: Array<object>}} byColumn misalignedCells per column
 */
function assertAligned(byColumn) {
  const bad = Object.entries(byColumn).filter(([, list]) => list.length);
  if (!bad.length) return;
  const lines = [];
  for (const [letter, list] of bad) {
    lines.push(`column ${letter}: ${list.length} row(s) disagree`);
    for (const m of firstN(list)) lines.push(`  row ${m.rowIndex} · formatted ${q(m.formatted)} · unformatted ${JSON.stringify(m.unformatted)} · ${m.why}`);
    push(lines, more(list));
  }
  throw new Error(`reads misaligned — re-run (the sheet was sorted or a row inserted between the formatted and unformatted reads; nothing was reported or written)\n${lines.join('\n')}`);
}

/** date / text / blank counts of one column over the rows the bot sees. */
function typeCounts(rows, unformattedMap) {
  const counts = { date: 0, text: 0, blank: 0 };
  for (const r of rows) counts[inventoryAudit.cellType(unformattedMap.get(r.rowIndex))] += 1;
  return counts;
}

/**
 * The console report. Pure over the collected data so it can be pinned
 * without a sheet.
 *
 * @param {object} data
 * @param {Array<object>} data.rows parsed rows
 * @param {object} data.findings inventoryAudit.audit(rows)
 * @param {Array<object>} data.census inventoryAudit.soldDateCensus(...)
 * @param {{K: object, M: object}} data.columns per column {cellTypes, shapes}
 * @param {number} data.minYards
 * @returns {string[]} lines
 */
function buildReport({ rows, findings, census, columns, minYards }) {
  const L = [];
  push(L, `ISC-1 Inventory audit — READ-ONLY — ${rows.length} row(s) read from ${SHEET} (no sheet cell is written)`);

  for (const [letter, name] of [['K', 'DateReceived'], ['M', 'SoldDate']]) {
    const c = columns[letter];
    push(L, '', `Column ${letter} ${name} — cell type: date ${c.cellTypes.date} · text ${c.cellTypes.text} · blank ${c.cellTypes.blank}`);
    const shapes = inventoryAudit.DATE_SHAPES.filter((s) => c.shapes.counts[s]).map((s) => `${s} ${c.shapes.counts[s]}`);
    push(L, `  shapes: ${shapes.join(' · ') || '(none)'}`);
    for (const s of inventoryAudit.DATE_SHAPES) {
      if (c.shapes.examples[s].length) push(L, `  e.g. ${s}: ${c.shapes.examples[s].map(q).join(', ')}`);
    }
  }

  const f = findings;
  push(L, '', `1. Sold rows the bot cannot date (C9): ${f.unparseableSoldDates.length}`);
  for (const b of firstN(f.unparseableSoldDates)) push(L, `     row ${b.rowIndex} · ${b.design}/${b.packageNo} #${b.thanNo} · ${b.soldTo} · ${q(b.soldDate)}`);
  push(L, more(f.unparseableSoldDates));

  push(L, `2. Duplicate bale_uids (C10): ${f.duplicateUids.length}`);
  for (const d of firstN(f.duplicateUids)) push(L, `     ${d.baleUid} → rows ${d.rows.join(', ')}`);
  push(L, more(f.duplicateUids));

  push(L, `3. Shade spelling variants inside a design (C11): ${f.shadeVariants.length}`);
  for (const v of firstN(f.shadeVariants)) push(L, `     ${v.design} · ${v.variants.map((x) => `${q(x.shade)} (${x.rows.length})`).join(' vs ')}`);
  push(L, more(f.shadeVariants));

  const blankShadeRows = f.blankShades.reduce((n, d) => n + d.rows.length, 0);
  push(L, `4. Designs with blank shades: ${f.blankShades.length} design(s) / ${blankShadeRows} row(s)`);
  for (const d of firstN(f.blankShades)) push(L, `     ${d.design || '(no design)'} · ${d.rows.length} row(s)`);
  push(L, more(f.blankShades));

  push(L, `5. Legacy rows (no bale_uid — do NOT sort or insert rows until the backfill runs): ${f.legacy.count}`);

  push(L, `6. Oversize thans (≥ ${minYards} yd): ${f.oversize.length}`);
  for (const o of firstN(f.oversize)) push(L, `     row ${o.rowIndex} · ${o.design}/${o.packageNo} (${o.indent}${o.arrivalBatch ? `, ${o.arrivalBatch}` : ''}) #${o.thanNo} · ${o.yards} yd · ${o.status} @ ${o.warehouse}${o.soldTo ? ` · ${o.soldTo}` : ''}`);
  push(L, more(f.oversize));

  const zeroRows = f.zeroPriceSold.reduce((n, g) => n + g.rows.length, 0);
  push(L, `7. Sold rows at zero price: ${zeroRows} row(s) in ${f.zeroPriceSold.length} sale group(s)`);
  for (const g of firstN(f.zeroPriceSold)) push(L, `     ${g.design}/${g.packageNo} · ${g.soldTo || '(no buyer)'} · ${g.soldDate || '(no date)'} · ${g.rows.length} row(s)`);
  push(L, more(f.zeroPriceSold));

  push(L, `8. Customer spelling clusters (CANDIDATES only — nothing is merged): ${f.customerClusters.length}`);
  for (const c of firstN(f.customerClusters)) {
    push(L, `     ${c.members.map((m) => `${q(m.soldTo)} (${m.rows.length}${m.warehouses.length ? `; ${m.warehouses.join(', ')}` : ''})`).join(' · ')} — ${c.reason}`);
  }
  push(L, more(f.customerClusters));

  const textCells = census.filter((c) => c.cellType === 'text').length;
  const dateCells = census.filter((c) => c.cellType === 'date').length;
  const unreadable = census.filter((c) => c.raw && !c.normalised).length;
  push(L, `9. Sold-date census: ${census.length} sold row(s) — date cells ${dateCells} · text cells ${textCells} · unreadable ${unreadable}`);

  const blanks = Object.entries(f.blankRates).filter(([, v]) => v.blank).map(([k, v]) => `${k} ${v.blank}/${v.total}`);
  push(L, `10. Blank rates (field blank/total, non-zero only): ${blanks.join(' · ') || 'none'}`);
  return L;
}

async function main() {
  const { out, minYards } = parseArgs(process.argv);

  // Two reads, two snapshots. The parsed rows and the formatted K/M cells
  // both come out of the A2:W grid; only the unformatted K2:M is a second
  // call, and it is checked row by row against the first before anything
  // else happens.
  const [grid, unformatted] = await Promise.all([
    sheetsClient.readRange(SHEET, ALL_COLS),
    sheetsClient.readRangeUnformatted(SHEET, DATE_COLS),
  ]);
  const { rows, fmtK, fmtM } = loadInventory(grid);
  if (!rows.length) throw new Error(`${SHEET} came back empty — refusing to report on nothing`);

  const unfK = columnMap(unformatted, COL_K);
  const unfM = columnMap(unformatted, COL_M);
  assertAligned({ K: misalignedCells(rows, fmtK, unfK), M: misalignedCells(rows, fmtM, unfM) });
  console.log(`Reads aligned: the unformatted ${DATE_COLS} read agrees cell by cell with the ${ALL_COLS} snapshot on all ${rows.length} row(s).`);

  const findings = inventoryAudit.audit(rows, { minYards });
  const census = inventoryAudit.soldDateCensus(rows, fmtM, unfM);
  const columns = {
    K: { cellTypes: typeCounts(rows, unfK), shapes: inventoryAudit.dateShapes(rows.map((r) => fmtK.get(r.rowIndex))) },
    M: { cellTypes: typeCounts(rows, unfM), shapes: inventoryAudit.dateShapes(rows.map((r) => fmtM.get(r.rowIndex))) },
  };

  for (const line of buildReport({ rows, findings, census, columns, minYards })) console.log(line);

  const lists = findings.unparseableSoldDates.length + findings.duplicateUids.length + findings.shadeVariants.length
    + findings.blankShades.length + (findings.legacy.count ? 1 : 0) + findings.oversize.length
    + findings.zeroPriceSold.length + findings.customerClusters.length;

  if (!out) {
    console.log(`\nSummary: ${rows.length} rows audited · ${lists} finding(s) · no files written (pass --out <dir> for the JSON lists) · sheet untouched.`);
    return;
  }

  fs.mkdirSync(out, { recursive: true });
  const files = {
    'sold-dates.json': census,
    'oversize-thans.json': findings.oversize,
    'customer-clusters.json': findings.customerClusters,
    'shade-variants.json': findings.shadeVariants,
    'blank-shades.json': findings.blankShades,
    'duplicate-uids.json': findings.duplicateUids,
    'legacy-rows.json': findings.legacy,
    'zero-price-sold.json': findings.zeroPriceSold,
    'blank-rates.json': findings.blankRates,
    'date-shapes.json': columns,
  };
  for (const name of OUT_FILES) {
    fs.writeFileSync(path.join(out, name), `${JSON.stringify(files[name], null, 2)}\n`);
  }
  console.log(`\nSummary: ${rows.length} rows audited · ${lists} finding(s) · ${OUT_FILES.length} JSON files written to ${out} · sheet untouched.`);
}

module.exports = {
  parseArgs, buildReport, columnMap, typeCounts, loadInventory, cellMismatch, misalignedCells, assertAligned, OUT_FILES,
};

if (require.main === module) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}
