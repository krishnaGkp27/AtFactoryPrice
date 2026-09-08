#!/usr/bin/env node
'use strict';

/**
 * ISC-1 Phase 2a — make every sold row's SoldDate (Inventory column M) a
 * date that both the bot AND a Sheets date filter can see.
 *
 * WHY (specs/ISC-1_INVENTORY_SHEET_CLEANUP.md §2a). 105 sold rows carry
 * `cashmere 12-February-2026` (75 rows, 44200 → madam oshodi) or
 * `cashmere 2026-07-27` (30 rows, 44200 → Madam motunrayo) — a product
 * word typed into the date cell by hand. normalizeSalesDate cannot read
 * them, so those 21 bales sit outside every date window (Supply Ledger day
 * keys, sales windows, the movement ledger) and sort after every real day.
 * Other M cells are TEXT cells that happen to hold a date-shaped string
 * ('07 April 2026', '13-04-2026'): the bot reads them, but to Sheets they
 * are words, so the owner's date filter skips them.
 *
 * WHAT IT DOES. Reads Inventory A:M formatted (what the bot sees) and
 * column M unformatted (what Sheets stores: a number for a real date, a
 * string for text). For each SOLD row whose M cell is TEXT it plans one
 * write — the ISO day the salvage recovers (reason a) or the ISO day the
 * normaliser already reads (reason b) — sent with USER_ENTERED so Sheets
 * stores a real date. Date-typed cells are never touched: their DISPLAY is
 * scripts/format-date-columns.js's job. Text that nothing parses is
 * reported, never guessed. The planning rules and the per-row guard live
 * in src/services/soldDateRepair.js; this file is the door.
 *
 * WHAT IT NEVER DOES. Write any column but M. The sale itself — buyer,
 * status, price, booking time (P, UpdatedAt) — is unchanged: the cell said
 * the sale happened on that day and afterwards still says so, in a shape
 * every reader agrees on. Reason-(b) rows keep the day the bot already
 * reads, so no report moves for them; reason-(a) rows are the fix — those
 * sales enter the date windows they always belonged to.
 *
 * SAFETY. Dry-run by default; --commit writes. The full plan is printed
 * first (row, bale #than, buyer, current text, proposed day, reason).
 * Immediately before writing, the target range is re-read and a cell whose
 * text, stored type or row identity no longer matches the plan is SKIPPED
 * and reported — the CUS-ID1 guard. Every proposed day was already asserted
 * to read back as itself (normalizeSalesDate(iso) === iso) when planned;
 * that sees only the string in memory, so after the write the sheet's own
 * rendering is checked too (ORDER, below).
 *
 * ORDER (spec §4). Phase 0a — `node scripts/format-date-columns.js
 * --commit` — runs BEFORE this script. A text cell can carry any number
 * format without showing it (formats do not render on strings, and the
 * values API never reports them); the moment this script turns the cell
 * into a date, that format decides what the bot reads. 0a gives every M
 * cell the one dd-mmmm-yyyy format the normaliser reads, so the answer is
 * known before anything is written. Because the format is invisible, the
 * script also LOOKS: after the batch it re-reads the written cells
 * FORMATTED and checks each one reads back as the planned day. A cell that
 * does not (a stray `dd/mm/yy` shows `07/04/26` → unreadable; `m/d/yyyy`
 * shows `4/7/2026` → 4 July, silently wrong) is printed with both strings
 * and the exit code is 1 — the stored date is right, only its display is
 * off: run 0a, then this script again (a clean sheet plans 0 rows). A cell
 * that comes back still stored as TEXT carries a plain-text format 0a
 * would have replaced — reported as a warning, same remedy.
 *
 * Usage:
 *   node scripts/repair-inventory-sold-dates.js                   # dry-run, full plan
 *   node scripts/repair-inventory-sold-dates.js --design 44200    # rehearse on one design
 *   node scripts/repair-inventory-sold-dates.js --rows 12,13-40   # rehearse on sheet rows
 *   node scripts/repair-inventory-sold-dates.js --commit          # write column M
 *
 * Requires the same .env (Google Sheets credentials) as the bot. Exit code
 * 1 when any written cell does not read back as the planned day.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sheets = require('../src/repositories/sheetsClient');
const inventoryRepository = require('../src/repositories/inventoryRepository');
const repair = require('../src/services/soldDateRepair');

function parseArgs(argv) {
  const a = { commit: false, rows: null, design: null };
  for (let i = 2; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--commit') a.commit = true;
    else if (v === '--rows') { a.rows = repair.parseRowsArg(argv[i + 1]); i += 1; }
    else if (v.startsWith('--rows=')) a.rows = repair.parseRowsArg(v.slice('--rows='.length));
    else if (v === '--design') { a.design = String(argv[i + 1] || '').trim(); i += 1; }
    else if (v.startsWith('--design=')) a.design = v.slice('--design='.length).trim();
    else throw new Error(`unknown argument: ${v}`);
  }
  if (a.design === '') throw new Error('--design: no design given');
  return a;
}

const pad = (v, n) => String(v).padEnd(n);
const bale = (e) => `${e.design}/${e.packageNo} #${e.thanNo}`;

/**
 * Plan, print, and (with commit) guard-and-write.
 *
 * @param {object} opts
 * @param {boolean} opts.commit write column M; otherwise dry-run
 * @param {Set<number>|null} [opts.rows] rehearsal filter
 * @param {string|null} [opts.design] rehearsal filter
 * @param {Function} [opts.log] line sink (console.log)
 * @returns {Promise<{plan:object[], reported:object[], written:object[], skipped:object[],
 *   mismatched:object[], stillText:object[], counts:object}>} `mismatched` are
 *   written cells whose rendering does not read back as the planned day
 *   (exit 1 territory); `stillText` are written cells Sheets still stores
 *   as text (warning)
 */
async function run({ commit, rows = null, design = null, log = console.log }) {
  const {
    SHEET, FORMATTED_RANGE, UNFORMATTED_RANGE, SOLD_DATE_RANGE, FIRST_ROW, SOLD_DATE_COLUMN, REASON_LABEL,
  } = repair;
  const scope = [rows ? `rows=${rows.size} listed` : null, design ? `design=${design}` : null].filter(Boolean).join(' ');
  log(`ISC-1 sold-date repair — sheet="${SHEET}" column=${SOLD_DATE_COLUMN} `
    + `mode=${commit ? 'COMMIT (will write)' : 'DRY-RUN (no writes)'}${scope ? ` ${scope}` : ''}`);

  const [formattedRows, unformattedRows] = await Promise.all([
    sheets.readRange(SHEET, FORMATTED_RANGE),
    sheets.readRangeUnformatted(SHEET, UNFORMATTED_RANGE),
  ]);
  const { plan, reported, counts } = repair.planRepairs({ formattedRows, unformattedRows, rows, design });

  log(`\nScanned ${counts.scanned} row(s)` + (counts.filtered ? ` (${counts.filtered} outside the filter)` : '')
    + `: ${counts.sold} sold in scope, ${counts.dateTyped} already real dates (untouched), `
    + `${plan.length} to repair, ${reported.length} reported.\n`);

  for (const e of plan) {
    log(`  row ${pad(e.rowIndex, 5)} ${pad(bale(e), 20)} ${pad(e.soldTo || '(no buyer)', 18)} `
      + `${pad(`"${e.current}"`, 30)} → ${e.proposed}   (${e.reason}) ${REASON_LABEL[e.reason]}`);
  }
  if (reported.length) {
    log('\nReported, NOT planned (nothing here is guessed):');
    for (const r of reported) {
      log(`  row ${pad(r.rowIndex, 5)} ${pad(bale(r), 20)} ${pad(r.soldTo || '(no buyer)', 18)} `
        + `${pad(`"${r.current}"`, 30)} — ${r.why}${r.detail ? ` (${r.detail})` : ''}`);
    }
  }

  const written = [];
  const skipped = [];
  const mismatched = [];
  const stillText = [];
  if (!commit) {
    log('\nDRY-RUN: nothing written. Re-run with --commit to apply.');
  } else if (!plan.length) {
    log('\nNothing to write.');
  } else {
    // CUS-ID1 guard — re-read the range immediately before writing and
    // compare every target cell (and its row's identity) to the plan.
    const [fresh, freshUnformatted] = await Promise.all([
      sheets.readRange(SHEET, FORMATTED_RANGE),
      sheets.readRangeUnformatted(SHEET, UNFORMATTED_RANGE),
    ]);
    const updates = [];
    for (const e of plan) {
      const i = e.rowIndex - FIRST_ROW;
      const check = repair.verifyBeforeWrite(e, fresh[i], (freshUnformatted[i] || [])[0]);
      if (!check.ok) { skipped.push({ ...e, why: check.why }); continue; }
      updates.push({ range: `${SOLD_DATE_COLUMN}${e.rowIndex}`, values: [[e.proposed]] });
      written.push(e);
    }
    if (updates.length) {
      await sheets.batchUpdateRanges(SHEET, updates);
      inventoryRepository.invalidateCache();
      // Read back what was just written. The cells are dates now, so each
      // one's number format decides what the bot reads — and the values
      // API never reports formats, so the only way to know is to look.
      const [after, afterStored] = await Promise.all([
        sheets.readRange(SHEET, SOLD_DATE_RANGE),
        sheets.readRangeUnformatted(SHEET, SOLD_DATE_RANGE),
      ]);
      for (const e of written) {
        const i = e.rowIndex - FIRST_ROW;
        const check = repair.verifyAfterWrite(e, (after[i] || [])[0], (afterStored[i] || [])[0]);
        if (!check.ok) mismatched.push({ ...e, ...check });
        else if (!check.storedAsDate) stillText.push({ ...e, ...check });
      }
    }
    for (const s of skipped) log(`  row ${s.rowIndex}: SKIPPED — ${s.why} (the sheet moved since the plan)`);
    if (written.length) {
      log(`\n${mismatched.length ? '⚠️' : '✅'} Wrote ${written.length} SoldDate cell(s) in column ${SOLD_DATE_COLUMN}; `
        + `${written.length - mismatched.length} read back as the planned day. No other column was touched.`);
    }
    if (stillText.length) {
      log(`\n⚠️ ${stillText.length} written cell(s) are still stored as TEXT (a plain-text number format on the cell) — `
        + 'the bot reads the right day, a Sheets date filter still cannot see it:');
      for (const t of stillText) log(`  row ${pad(t.rowIndex, 5)} ${pad(bale(t), 20)} wrote ${t.proposed}, stored as text`);
      log('  Remedy: run `node scripts/format-date-columns.js --commit` (spec §4 Phase 0a), then this script again.');
    }
    if (mismatched.length) {
      log(`\n❌ ${mismatched.length} written cell(s) do NOT read back as the planned day. The stored date is right; `
        + 'its DISPLAY is rendered through a per-cell number format the bot cannot read:');
      for (const m of mismatched) {
        log(`  row ${pad(m.rowIndex, 5)} ${pad(bale(m), 20)} ${pad(`"${m.current}"`, 30)} → wrote ${m.proposed}, `
          + `now displays "${m.display}", reads back as ${m.readBack || 'nothing'}`);
      }
      log('  Until the display is fixed those sales sit outside every date window. Remedy: run '
        + '`node scripts/format-date-columns.js --commit` NOW (spec §4 Phase 0a — one dd-mmmm-yyyy format on the '
        + 'whole column), then this script again to confirm 0 planned.');
    }
  }

  log(`\nISC-1 sold-date repair: planned ${plan.length} / written ${written.length} / skipped ${skipped.length}`
    + (reported.length ? ` · ${reported.length} reported, not planned` : '')
    + (stillText.length ? ` · ${stillText.length} still text` : '')
    + (mismatched.length ? ` · ${mismatched.length} READ BACK WRONG` : ''));
  return { plan, reported, written, skipped, mismatched, stillText, counts };
}

/**
 * @param {string[]} [argv] process.argv shape
 * @param {Function} [log] line sink
 * @returns {Promise<number>} exit code: 1 when a written cell does not read
 *   back as the planned day, else 0
 */
async function main(argv = process.argv, log = console.log) {
  const out = await run({ ...parseArgs(argv), log });
  return out.mismatched.length ? 1 : 0;
}

// Importable so the repair can be exercised against a fake sheet with no
// credentials — this writes to live business records, so its behaviour is
// pinned by tests rather than trusted.
if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { run, main, parseArgs };
