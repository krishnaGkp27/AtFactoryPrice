'use strict';

/**
 * ISC-1 Phase 2c (spec §2e, ruling R8) — give every legacy Inventory than a
 * REAL bale_uid, and split the one duplicated uid.
 *
 * WHY. 2,853 Mar26 rows have a blank column R, so the bot identifies them
 * as `BAL-LEGACY-<rowIndex>` — their POSITION in the sheet. Sorting the
 * sheet or inserting a row silently re-keys every one of them: transfer
 * pinning, the Postgres mirror and the bundle-sale cart all carry the uid.
 * This is the one-off that makes sorting safe (§2f item 1). It also
 * re-mints the second copy of `BAL-20260713-864-bjwg` (77014/864 thans #4
 * and #5 share it), so uid-scoped operations stop treating two thans as one.
 *
 * WHAT IT WRITES — column R only, on the rows it names. Column S (addedAt)
 * is left alone: the parser already falls back to DateReceived and the
 * column is slated for retirement (§3). Nothing else on the row is touched.
 *
 * SAFETY: dry-run by default — only --commit writes. Every planned row is
 * re-read immediately before the write; a cell that no longer matches the
 * plan (a uid appeared, the duplicate moved, the sheet was re-ordered) is
 * SKIPPED and reported, never guessed. After writing, column R is read
 * again and the process exits non-zero unless blank rows AND duplicate
 * uids are both 0.
 *
 * Usage:
 *   node scripts/backfill-legacy-uids.js             # dry-run: counts + first 5 of each plan
 *   node scripts/backfill-legacy-uids.js --verbose   # dry-run: every planned row
 *   node scripts/backfill-legacy-uids.js --commit    # prints the full plan, writes, verifies
 *
 * Requires the same .env (Google Sheets credentials) as the bot.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const inventoryRepository = require('../src/repositories/inventoryRepository');

const SAMPLE = 5;

/**
 * @param {string[]} argv process.argv
 * @returns {{commit: boolean, verbose: boolean}}
 */
function parseArgs(argv) {
  const a = { commit: false, verbose: false };
  for (const v of argv.slice(2)) {
    if (v === '--commit') a.commit = true;
    else if (v === '--verbose') a.verbose = true;
  }
  return a;
}

/**
 * One plan row as printed: row · bale · than · current R → new R.
 * @param {{rowIndex:number, packageNo:string, thanNo?:string, currentUid:string, baleUid:string}} p
 * @returns {string}
 */
function planLine(p) {
  const cur = p.currentUid ? `"${p.currentUid}"` : '(blank)';
  return `  row ${String(p.rowIndex).padEnd(6)} bale ${String(p.packageNo || '(none)').padEnd(8)} `
    + `than ${String(p.thanNo || '?').padEnd(3)} R: ${cur} → ${p.baleUid}`;
}

function printPlan(title, plan, full, log) {
  log(`\n${title}: ${plan.length} row(s) planned`);
  const shown = full ? plan : plan.slice(0, SAMPLE);
  for (const p of shown) log(planLine(p));
  if (plan.length > shown.length) log(`  … ${plan.length - shown.length} more (--verbose lists every row)`);
}

function printResult(title, res, log) {
  log(`${title}: matched ${res.matched} · written ${res.written} · skipped ${res.skipped.length}`);
  for (const s of res.skipped) log(`  row ${s.rowIndex} (bale ${s.packageNo || '(none)'}): SKIPPED — ${s.why}`);
}

/**
 * Run both operations (backfill, then dedupe) and, on --commit, verify.
 * Importable so the behaviour is pinned against a fake sheet; `log` lets a
 * test capture the output.
 * @param {string[]} argv
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ok:boolean, planned:number, written:number, skipped:number, backfill:object, dedupe:object, census:object|null}>}
 */
async function run(argv, log = console.log) {
  const { commit, verbose } = parseArgs(argv);
  // The full plan always prints before a write; a dry-run shows a sample
  // unless asked for everything.
  const full = commit || verbose;
  log(`ISC-1 2c legacy uid backfill — mode=${commit ? 'COMMIT (writes column R)' : 'DRY-RUN (no writes)'}`);

  const backfill = await inventoryRepository.backfillLegacyBales({
    dryRun: !commit,
    onPlan: (plan) => printPlan('Backfill (blank R → real uid)', plan, full, log),
  });
  printResult('Backfill', backfill, log);

  const dedupe = await inventoryRepository.dedupeBaleUids({
    dryRun: !commit,
    onPlan: (plan) => printPlan('Dedupe (shared uid → fresh uid on the later rows)', plan, full, log),
  });
  printResult('Dedupe', dedupe, log);

  const planned = backfill.matched + dedupe.matched;
  const written = backfill.written + dedupe.written;
  const skipped = backfill.skipped.length + dedupe.skipped.length;

  let ok = true;
  let census = null;
  if (commit) {
    census = await inventoryRepository.baleUidCensus();
    log(`\nVerification: blank-R rows = ${census.blank} (expected 0) · duplicate uids = ${census.duplicates.length} (expected 0)`);
    for (const d of census.duplicates.slice(0, 10)) log(`  ${d.uid} on rows ${d.rowIndexes.join(', ')}`);
    ok = census.blank === 0 && census.duplicates.length === 0;
    if (!ok) log('FAIL: column R is not clean after the write — see the verification lines above.');
  } else {
    log('\nDRY-RUN: nothing written. Re-run with --commit to apply.');
  }
  log(`\nSummary: planned ${planned} / written ${written} / skipped ${skipped}`);
  return { ok, planned, written, skipped, backfill, dedupe, census };
}

if (require.main === module) {
  run(process.argv)
    .then((r) => { if (!r.ok) process.exit(1); })
    .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { run, parseArgs, planLine };
