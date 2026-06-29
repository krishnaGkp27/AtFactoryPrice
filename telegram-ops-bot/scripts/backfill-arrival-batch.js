/**
 * One-time backfill of the Inventory `arrival_batch` column (V).
 *
 * Stamps a single container/arrival label (default "Mar26") onto every
 * Inventory row whose arrival_batch cell is currently empty — both available
 * and already-sold rows — so existing stock is "wrapped" into a named
 * container. Idempotent: rows that already carry a label are left untouched,
 * so it is safe to re-run and it never clobbers labels set by later uploads.
 *
 * SAFETY: dry-run by default. It only writes when you pass --commit.
 *
 * Usage:
 *   node scripts/backfill-arrival-batch.js                # dry-run, label "Mar26"
 *   node scripts/backfill-arrival-batch.js --label Mar26  # dry-run, explicit label
 *   node scripts/backfill-arrival-batch.js --label Mar26 --commit   # writes
 *
 * Requires the same .env (Google Sheets credentials) as the bot.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const inventoryRepo = require('../src/repositories/inventoryRepository');

function parseArgs(argv) {
  const args = { label: 'Mar26', commit: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--label') { args.label = argv[i + 1] || args.label; i += 1; }
    else if (a.startsWith('--label=')) args.label = a.slice('--label='.length);
  }
  return args;
}

async function main() {
  const { label, commit } = parseArgs(process.argv);
  if (!label || !label.trim()) {
    console.error('FAIL: --label must be a non-empty string (e.g. --label Mar26)');
    process.exit(1);
  }

  console.log(`arrival_batch backfill — label="${label}" mode=${commit ? 'COMMIT (will write)' : 'DRY-RUN (no writes)'}`);

  // Dry-run first to report the count regardless of mode.
  const preview = await inventoryRepo.backfillArrivalBatch(label, { dryRun: true });
  console.log(`Rows with empty arrival_batch that would be stamped "${label}": ${preview.matched}`);

  if (!commit) {
    console.log('\nDRY-RUN only — nothing written. Re-run with --commit to apply.');
    return;
  }
  if (!preview.matched) {
    console.log('\nNothing to backfill — every row already has an arrival_batch.');
    return;
  }

  const result = await inventoryRepo.backfillArrivalBatch(label, { dryRun: false });
  console.log(`\nDone. Wrote "${label}" to ${result.written} row(s).`);
}

main().catch((e) => {
  console.error('Backfill failed:', e.message);
  process.exit(1);
});
