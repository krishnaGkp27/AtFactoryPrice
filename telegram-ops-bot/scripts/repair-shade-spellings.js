#!/usr/bin/env node
'use strict';

/**
 * ISC-1 Phase 2d (ruling R4) — strip the trailing dot from shade spellings.
 *
 * The 04-Sep-2026 census (specs/ISC-1_INVENTORY_SHEET_CLEANUP.md §2c): design
 * 75142 stores its shades as `2-6.`, `4-5.`, `7-3.` (bales 6485, 6483, 6486)
 * while 77018/950 stores `4-5`. Shade pickers key their chips on the raw
 * cell, so one shade shows as two chips. The owner's ruling (R4): strip the
 * dot, nothing else.
 *
 * What it does, and nothing else:
 *   1. reads Inventory A2:F (bale · design · shade · than); column E (Shade)
 *      is the ONLY cell it ever writes;
 *   2. plans every row whose shade differs from canonicalShade() — trim, then
 *      strip trailing dots. No case change, no word → number mapping;
 *   3. prints the plan grouped by design and bale, then — informational —
 *      the rows with NO shade (the §2c gaps, e.g. three 9043-A Mar26 rows),
 *      which the owner supplies and this script never fills;
 *   4. with --commit: re-reads the same range, writes a cell only when its
 *      design, bale, than and raw shade all still match the plan (the
 *      CUS-ID1 guard — verifyPlan), reports every skip, writes in one
 *      batchUpdateRanges, then invalidates the Inventory read cache.
 *
 * Values are written as TEXT (leading apostrophe, the same escape the
 * SHEET-FIX-2 phone repair uses): batchUpdateRanges is USER_ENTERED, and
 * Sheets parses a typed `4-5` or `2-6` as a DATE. The apostrophe is dropped
 * on storage, so the cell reads back as exactly `4-5`.
 *
 * SAFETY: dry-run by default; only --commit writes. A cell that would be
 * BLANK after the strip (dots only) is refused, never written. A --design
 * that matches no Inventory row is an error, not an all-clear.
 *
 * Usage:
 *   node scripts/repair-shade-spellings.js                    # dry-run, whole sheet
 *   node scripts/repair-shade-spellings.js --design 75142     # dry-run, one design
 *   node scripts/repair-shade-spellings.js --design 75142 --commit
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sheets = require('../src/repositories/sheetsClient');
const inventoryRepository = require('../src/repositories/inventoryRepository');
const repair = require('../src/services/shadeSpellingRepair');

const SHEET = 'Inventory';
const RANGE = 'A2:F'; // PackageNo … ThanNo — read for the plan and the guard only
const SHADE_COL = 'E';
const BALES_SHOWN = 20; // per design in the blank-shade report before "… +N more"

/**
 * The value typed after `--design`. An empty value, or one that is really the
 * next flag (`--design --commit`), is refused: silently falling back to "no
 * filter" would turn the one-design commit the owner typed into a whole-sheet
 * write without a word.
 * @param {unknown} raw
 * @param {string} spelling the flag as typed, for the error message
 * @returns {string}
 */
function designValue(raw, spelling) {
  const design = String(raw == null ? '' : raw).trim();
  if (!design || design.startsWith('--')) {
    throw new Error(`${spelling} needs a design number (e.g. --design 75142); `
      + 'omit the flag entirely to run over the whole sheet');
  }
  return design;
}

/**
 * @param {string[]} argv process.argv
 * @returns {{commit: boolean, design: string}}
 */
function parseArgs(argv) {
  const a = { commit: false, design: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--commit') a.commit = true;
    else if (v === '--design') { a.design = designValue(argv[i + 1], '--design'); i += 1; }
    else if (v.startsWith('--design=')) a.design = designValue(v.slice('--design='.length), '--design=');
    else throw new Error(`unknown argument: ${v}`);
  }
  return a;
}

/** Plan entries grouped design → bale, in sheet order. */
function groupPlan(plan) {
  const designs = new Map();
  for (const p of plan) {
    if (!designs.has(p.design)) designs.set(p.design, new Map());
    const bales = designs.get(p.design);
    if (!bales.has(p.packageNo)) bales.set(p.packageNo, []);
    bales.get(p.packageNo).push(p);
  }
  return designs;
}

function printPlan(plan) {
  if (!plan.length) {
    console.log('\nNothing to rewrite: every shade already matches its canonical spelling.');
    return;
  }
  console.log(`\n${plan.length} shade cell(s) to rewrite (column ${SHADE_COL} only):\n`);
  for (const [design, bales] of groupPlan(plan)) {
    console.log(`Design ${design}`);
    for (const [packageNo, rows] of bales) {
      console.log(`  bale ${packageNo} — ${rows.length} than(s)`);
      for (const p of rows) {
        console.log(`    row ${String(p.rowIndex).padEnd(5)} than ${String(p.thanNo).padEnd(2)}  '${p.current}'  →  '${p.next}'`);
      }
    }
  }
}

function printRefused(refused) {
  if (!refused.length) return;
  console.log('\nREFUSED — dots only, stripping would leave the shade BLANK (R4 does not license that):');
  for (const r of refused) {
    console.log(`  row ${String(r.rowIndex).padEnd(5)} ${r.design} / bale ${r.packageNo}  '${r.current}'  left as is`);
  }
}

function printBlank(blank) {
  console.log('\nRows with NO shade (report only — the owner supplies these; this script never fills a blank):');
  if (!blank.length) { console.log('  none'); return; }
  const byDesign = new Map();
  for (const b of blank) {
    if (!byDesign.has(b.design)) byDesign.set(b.design, { rows: [], bales: [] });
    const d = byDesign.get(b.design);
    d.rows.push(b);
    if (!d.bales.includes(b.packageNo)) d.bales.push(b.packageNo);
  }
  for (const [design, d] of byDesign) {
    const shown = d.bales.slice(0, BALES_SHOWN).join(', ');
    const more = d.bales.length > BALES_SHOWN ? ` … +${d.bales.length - BALES_SHOWN} more` : '';
    console.log(`  ${(design || '(no design)').padEnd(10)} ${String(d.rows.length).padStart(4)} row(s) across ${d.bales.length} bale(s): ${shown}${more}`);
    // A handful of gaps is a to-do list — print each row so the owner can
    // find it; a whole suffixed design with no shade (9037-D) is a pattern.
    if (d.rows.length <= 10) {
      for (const r of d.rows) console.log(`      row ${String(r.rowIndex).padEnd(5)} bale ${r.packageNo}`);
    }
  }
}

/**
 * Run the repair. Importable so it can be driven against a fake sheet with
 * no credentials — this writes live business records, so its behaviour is
 * pinned by tests rather than trusted.
 * @param {{commit?: boolean, design?: string}} [opts]
 * @returns {Promise<{plan: Array<object>, written: number, skipped: Array<object>, refused: Array<object>, blank: Array<object>}>}
 */
async function run({ commit = false, design = '' } = {}) {
  console.log(`ISC-1 2d shade-spelling repair — sheet=${SHEET}${design ? ` design=${design}` : ''} `
    + `mode=${commit ? 'COMMIT (will write)' : 'DRY-RUN (no writes)'}`);

  const rows = repair.rowsFromCells(await sheets.readRange(SHEET, RANGE));
  if (design && repair.countRecords(rows, { design }) === 0) {
    // The filter is exact, so a mistyped --design 9043A (real: 9043-A) or
    // 75l42 matches nothing. Reporting "Nothing to rewrite" and "Rows with
    // NO shade: none" for it would tell the owner the dotted cells and the
    // blank rows are gone when every one of them is still there.
    throw new Error(`no Inventory row carries design "${design}" — check the spelling `
      + '(a whole-sheet dry-run, no --design, lists every design with a dotted or blank shade)');
  }
  const plan = repair.buildPlan(rows, { design });
  const refused = repair.blankAfterStripRows(rows, { design });
  const blank = repair.blankShadeRows(rows, { design });

  printPlan(plan);
  printRefused(refused);
  printBlank(blank);

  let written = 0;
  let skipped = [];
  if (commit && plan.length) {
    // Re-read moments before the write: a row that moved (a sorted sheet),
    // was re-keyed or was hand-edited since the plan is skipped, never
    // guessed at.
    const live = repair.rowsFromCells(await sheets.readRange(SHEET, RANGE));
    const verdict = repair.verifyPlan(plan, live);
    skipped = verdict.skipped;
    if (skipped.length) {
      console.log('');
      for (const s of skipped) console.log(`  row ${s.rowIndex}: SKIPPED — ${s.why}`);
    }
    if (verdict.ready.length) {
      await sheets.batchUpdateRanges(SHEET, verdict.ready.map((p) => ({
        range: `${SHADE_COL}${p.rowIndex}`,
        values: [[`'${p.next}`]], // TEXT — see the docblock
      })));
      inventoryRepository.invalidateCache();
      written = verdict.ready.length;
      console.log(`\n✅ Rewrote ${written} shade cell(s) in column ${SHADE_COL}.`);
    }
  }

  if (!commit) console.log('\nDRY-RUN: nothing written. Re-run with --commit to apply.');
  console.log(`\nSummary: planned ${plan.length} · written ${written} · skipped ${skipped.length}`);
  return { plan, written, skipped, refused, blank };
}

async function main() {
  await run(parseArgs(process.argv));
}

if (require.main === module) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { run, parseArgs, groupPlan, SHEET, RANGE, SHADE_COL };
