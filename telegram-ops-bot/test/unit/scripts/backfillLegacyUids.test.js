'use strict';

/**
 * ISC-1 Phase 2c — scripts/backfill-legacy-uids.js, the thin wrapper over
 * inventoryRepository.backfillLegacyBales / dedupeBaleUids / baleUidCensus.
 *
 * Pinned: dry-run prints counts + samples and writes nothing; --commit
 * prints every planned row BEFORE writing, runs backfill then dedupe, then
 * verifies column R (blank 0, duplicates 0) and reports ok=false — the
 * process's non-zero exit — when the verification does not come back clean.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

const HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
const DUP = 'BAL-20260713-864-bjwg';

function row(pkg, design, thanNo, uid) {
  return [pkg, '', '', design, '01', String(thanNo), '30', 'available', 'IDUMOTA', '0',
    '2026-02-24', '', '', '', '', '', 'fabric', uid, '', '', '', 'Mar26', ''];
}

function fixture() {
  return [
    HEADER,
    row('6534', '9006', 1, ''),
    row('6534', '9006', 2, ''),
    row('6534', '9006', 3, ''),
    row('6534', '9006', 4, ''),
    row('6534', '9006', 5, ''),
    row('6535', '9006', 1, ''),   // six blank rows: a dry-run sample shows 5 + "1 more"
    row('864', '77014', 4, DUP),
    row('864', '77014', 5, DUP),
  ];
}

let fake;
let restore;
let sheets;
const script = require(path.join(__dirname, '../../../scripts/backfill-legacy-uids'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));

test.beforeEach(() => {
  if (restore) restore();
  fake = createFakeSheets({ Inventory: fixture() });
  restore = installFakeSheets(fake);
  sheets = require(path.join(SRC, 'repositories/sheetsClient'));
  inventoryRepository.invalidateCache();
});
test.after(() => restore && restore());

const colR = () => fake._store.get('Inventory').slice(1).map((r) => r[17]);

test('parseArgs: dry-run by default, --commit and --verbose recognised', () => {
  assert.deepEqual(script.parseArgs(['node', 'x']), { commit: false, verbose: false });
  assert.deepEqual(script.parseArgs(['node', 'x', '--commit']), { commit: true, verbose: false });
  assert.deepEqual(script.parseArgs(['node', 'x', '--verbose']), { commit: false, verbose: true });
});

test('dry-run: counts + samples for both operations, nothing written, summary last', async () => {
  const out = [];
  const res = await script.run(['node', 'x'], (l) => out.push(l));
  assert.equal(res.ok, true);
  assert.equal(res.planned, 7, '6 blank rows + 1 duplicate carrier');
  assert.equal(res.written, 0);
  assert.equal(res.skipped, 0);
  const text = out.join('\n');
  assert.match(text, /DRY-RUN \(no writes\)/);
  assert.match(text, /Backfill \(blank R → real uid\): 6 row\(s\) planned/);
  assert.match(text, /… 1 more \(--verbose lists every row\)/, 'sample of 5, the rest counted');
  assert.match(text, /Dedupe \(shared uid → fresh uid on the later rows\): 1 row\(s\) planned/);
  assert.match(text, /row 9\s+bale 864\s+than 5\s+R: "BAL-20260713-864-bjwg" → BAL-\d{8}-864-/);
  assert.match(text, /Backfill: matched 6 · written 0 · skipped 0/);
  assert.match(text, /Dedupe: matched 1 · written 0 · skipped 0/);
  assert.doesNotMatch(text, /Verification/, 'a dry-run does not verify (nothing changed)');
  assert.equal(out[out.length - 1], '\nSummary: planned 7 / written 0 / skipped 0');
  assert.deepEqual(colR(), ['', '', '', '', '', '', DUP, DUP], 'the sheet is untouched');
});

test('--verbose dry-run lists every planned row', async () => {
  const out = [];
  await script.run(['node', 'x', '--verbose'], (l) => out.push(l));
  const text = out.join('\n');
  assert.doesNotMatch(text, /more \(--verbose/);
  assert.equal((text.match(/R: \(blank\) → BAL-/g) || []).length, 6, 'all six blank rows listed');
});

test('--commit: prints the full plan before writing, backfills then dedupes, verifies clean', async () => {
  const out = [];
  const res = await script.run(['node', 'x', '--commit'], (l) => out.push(l));
  assert.equal(res.ok, true);
  assert.equal(res.planned, 7);
  assert.equal(res.written, 7);
  assert.equal(res.skipped, 0);
  const text = out.join('\n');
  assert.match(text, /COMMIT \(writes column R\)/);
  assert.equal((text.match(/R: \(blank\) → BAL-/g) || []).length, 6, 'every row printed, not a sample');
  assert.match(text, /Verification: blank-R rows = 0 \(expected 0\) · duplicate uids = 0 \(expected 0\)/);
  assert.equal(out[out.length - 1], '\nSummary: planned 7 / written 7 / skipped 0');
  const r = colR();
  assert.ok(r.every((u) => /^BAL-\d{8}-\d+-[a-z0-9]+$/.test(u)), 'every row now carries a real uid');
  assert.equal(r[6], DUP, 'the first carrier keeps the original');
  assert.notEqual(r[7], DUP, 'the second carrier was re-minted');
  assert.equal(new Set(r).size, r.length, 'no duplicates remain');
  // The plan printed BEFORE the write: the first plan line precedes the first result line.
  assert.ok(text.indexOf('R: (blank) → BAL-') < text.indexOf('Backfill: matched'));
});

test('--commit reports ok=false when the verification is not clean (a write was lost)', async () => {
  // A batch write that silently does nothing: the census must catch it.
  const orig = sheets.batchUpdateRanges;
  sheets.batchUpdateRanges = async () => {};
  try {
    const out = [];
    const res = await script.run(['node', 'x', '--commit'], (l) => out.push(l));
    assert.equal(res.ok, false);
    assert.equal(res.census.blank, 6);
    assert.equal(res.census.duplicates.length, 1);
    assert.match(out.join('\n'), /FAIL: column R is not clean/);
    assert.match(out.join('\n'), /BAL-20260713-864-bjwg on rows 8, 9/);
  } finally {
    sheets.batchUpdateRanges = orig;
  }
});
