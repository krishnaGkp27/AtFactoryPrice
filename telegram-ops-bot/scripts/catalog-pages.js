/**
 * CAT-P1 — inspect a design's catalogue pages, and restore one that an
 * earlier upload retired.
 *
 * Before CAT-P1 the catalogue kept exactly ONE active photo per design:
 * uploading a second marked the first `replaced`. So a design the owner
 * meant to give two pages (9037: twelve shades over two sheets) shows only
 * the newer photo, and the older one is sitting in DesignAssets as a
 * previous version rather than as page 1.
 *
 * This turns such a row back into a page. It only ever writes column J
 * (Status), and only from 'replaced' to 'active' — it cannot touch a
 * photo, a shade list, or any other row.
 *
 * SAFETY: dry-run by default. It only writes when you pass --commit.
 *
 * Usage:
 *   node scripts/catalog-pages.js --design 9037              # list the rows
 *   node scripts/catalog-pages.js --design 9037 --restore 5  # dry-run row 5
 *   node scripts/catalog-pages.js --design 9037 --restore 5 --commit
 *
 * Row numbers are the sheet row numbers printed by the listing.
 * Requires the same .env (Google Sheets credentials) as the bot.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const repo = require('../src/repositories/designAssetsRepository');

function parseArgs(argv) {
  const args = { design: '', restore: 0, commit: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--design') { args.design = argv[i + 1] || ''; i += 1; }
    else if (a.startsWith('--design=')) args.design = a.slice('--design='.length);
    else if (a === '--restore') { args.restore = parseInt(argv[i + 1], 10) || 0; i += 1; }
    else if (a.startsWith('--restore=')) args.restore = parseInt(a.slice('--restore='.length), 10) || 0;
  }
  return args;
}

async function main() {
  const { design, restore, commit } = parseArgs(process.argv);
  if (!design.trim()) {
    console.error('FAIL: --design is required (e.g. --design 9037)');
    process.exit(1);
  }

  const all = await repo.getAll();
  const mine = all.filter((r) => String(r.design).toUpperCase() === design.trim().toUpperCase());
  if (!mine.length) {
    console.error(`No DesignAssets rows at all for design "${design}".`);
    process.exit(1);
  }

  console.log(`\nDesignAssets rows for ${design}:\n`);
  const ordered = [...mine].sort((a, b) => (a.uploadedAt || '').localeCompare(b.uploadedAt || ''));
  for (const r of ordered) {
    const batch = r.arrivalBatch ? ` container=${r.arrivalBatch}` : '';
    console.log(`  row ${String(r.rowIndex).padEnd(4)} ${String(r.status).padEnd(9)} `
      + `uploaded=${r.uploadedAt || '(unknown)'} shades=${r.shadeCount}${batch}`);
  }
  const active = ordered.filter((r) => r.status === 'active');
  console.log(`\n  → ${active.length} active page(s) today: `
    + `${active.map((r, i) => `page ${i + 1} = row ${r.rowIndex}`).join(', ') || 'none'}`);

  if (!restore) {
    const replaced = ordered.filter((r) => r.status === 'replaced');
    if (replaced.length) {
      console.log(`\n  ${replaced.length} replaced row(s) could be restored as pages: `
        + `${replaced.map((r) => `--restore ${r.rowIndex}`).join('  ')}`);
    }
    console.log('\n(listing only — pass --restore <row> to bring one back)');
    return;
  }

  const target = mine.find((r) => r.rowIndex === restore);
  if (!target) {
    console.error(`\nFAIL: row ${restore} is not a DesignAssets row for ${design}. `
      + 'Restoring a row belonging to another design is exactly the mistake this check exists to stop.');
    process.exit(1);
  }
  if (target.status === 'active') {
    console.log(`\nRow ${restore} is already active — nothing to do.`);
    return;
  }
  if (target.status !== 'replaced') {
    console.error(`\nFAIL: row ${restore} is "${target.status}", not "replaced". `
      + 'Only a superseded photo can be turned back into a page.');
    process.exit(1);
  }

  console.log(`\nPlan: row ${restore} status "replaced" → "active" `
    + `(design ${target.design}, uploaded ${target.uploadedAt || 'unknown'})`);
  console.log(`Result: ${design} would have ${active.length + 1} page(s).`);

  if (!commit) {
    console.log('\nDRY-RUN: nothing written. Re-run with --commit to apply.');
    return;
  }

  await repo.updateStatus(restore, 'active', 'catalog-pages-script');
  repo.invalidateCache();
  const after = await repo.findActivePages(target.design, target.arrivalBatch || '');
  console.log(`\n✅ Restored. ${design} now has ${after.length} page(s): `
    + `${after.map((r, i) => `page ${i + 1} = row ${r.rowIndex}`).join(', ')}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
