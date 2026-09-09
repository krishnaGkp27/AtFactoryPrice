'use strict';

/**
 * ISC-1 Phase 2d — scripts/repair-shade-spellings.js against a fake
 * Inventory sheet. The script rewrites live business records, so what it
 * WRITES, where, and what it refuses to write are pinned here:
 *
 *  - dry-run writes nothing at all;
 *  - --commit rewrites column E of the planned rows only, as TEXT, and
 *    leaves every other cell of every row byte-identical;
 *  - --design narrows both the writes and the reports, and a --design that
 *    matches no row fails loudly instead of reporting a clean design;
 *  - a row that drifted between the plan read and the pre-write re-read is
 *    skipped and reported, never written;
 *  - a dots-only cell is refused even under --commit;
 *  - the Inventory read cache is invalidated after a write;
 *  - a second run is a no-op (idempotent).
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const script = require(path.join(__dirname, '../../../scripts/repair-shade-spellings'));

const HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse'];
const row = (pkg, design, shade, than) => [pkg, 'SA/1326', '', design, shade, than, 30, 'available', 'Lagos'];

/** The §2c census in miniature; row 1 is the header, so sheet row numbers start at 2. */
function fixture() {
  return [
    HEADER,
    row('6483', '75142', '4-5.', 1),   // row 2
    row('6483', '75142', '4-5.', 2),   // row 3
    row('6485', '75142', '2-6.', 1),   // row 4
    row('6486', '75142', '7-3.', 1),   // row 5
    row('950', '77018', '4-5', 1),     // row 6  canonical already
    row('6001', '9037', 'BLACK', 1),   // row 7  word shade
    row('6100', '9043-A', '', 1),      // row 8  blank — report only
    row('6200', 'R-R', '.', 1),        // row 9  dots only — refused
    row('6300', 'R-R', 'MIX.', 1),     // row 10 another design
  ];
}

/** Seed the fake, capture every batch write, count cache invalidations, silence the report. */
function harness(rows = fixture()) {
  const fake = createFakeSheets({ Inventory: rows });
  installFakeSheets(fake);
  const writes = [];
  const realBatch = sheets.batchUpdateRanges;
  sheets.batchUpdateRanges = async (name, updates) => { writes.push({ name, updates }); return realBatch(name, updates); };
  const calls = { invalidate: 0 };
  inventoryRepository.invalidateCache = () => { calls.invalidate += 1; };
  const silence = test.mock.method(console, 'log', () => {});
  return {
    writes, calls, store: () => fake._store.get('Inventory'), restore: () => silence.mock.restore(),
  };
}

test('dry-run plans the dotted rows and writes absolutely nothing', async () => {
  const h = harness();
  try {
    const res = await script.run({ commit: false });
    assert.deepEqual(res.plan.map((p) => `${p.rowIndex}:${p.current}>${p.next}`),
      ['2:4-5.>4-5', '3:4-5.>4-5', '4:2-6.>2-6', '5:7-3.>7-3', '10:MIX.>MIX']);
    assert.equal(res.written, 0);
    assert.deepEqual(res.skipped, []);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.store(), fixture(), 'the sheet is untouched');
    assert.equal(h.calls.invalidate, 0);
  } finally { h.restore(); }
});

test('--commit rewrites column E of the planned rows as TEXT and nothing else', async () => {
  const h = harness();
  try {
    const res = await script.run({ commit: true });
    assert.equal(res.written, 5);
    assert.deepEqual(res.skipped, []);

    const updates = h.writes.flatMap((w) => w.updates);
    assert.equal(h.writes.length, 1, 'one batch write');
    assert.deepEqual(updates.map((u) => u.range), ['E2', 'E3', 'E4', 'E5', 'E10'], 'column E only');
    updates.forEach((u) => assert.ok(String(u.values[0][0]).startsWith("'"),
      `written with a leading apostrophe so Sheets stores TEXT, not a date: ${u.values[0][0]}`));

    const expected = fixture();
    expected[1][4] = "'4-5"; expected[2][4] = "'4-5"; expected[3][4] = "'2-6"; expected[4][4] = "'7-3"; expected[9][4] = "'MIX";
    assert.deepEqual(h.store(), expected, 'every other cell of every row is byte-identical');
    assert.equal(h.calls.invalidate, 1, 'the Inventory read cache is invalidated after the write');
  } finally { h.restore(); }
});

test('--design narrows the writes and the reports to that design, case-insensitively', async () => {
  const h = harness();
  try {
    const res = await script.run({ commit: true, design: 'r-r' });
    assert.equal(res.written, 1);
    assert.deepEqual(h.writes.flatMap((w) => w.updates).map((u) => u.range), ['E10']);
    assert.equal(h.store()[1][4], '4-5.', '75142 is left for its own run');
    assert.deepEqual(res.blank, [], 'the 9043-A gap belongs to another design');
    assert.deepEqual(res.refused.map((r) => r.rowIndex), [9], 'the R-R dots-only row is reported');
  } finally { h.restore(); }
});

test('a --design that matches no Inventory row fails loudly instead of reporting a clean design', async () => {
  const h = harness();
  try {
    // 9043A for the real 9043-A: the blank Mar26 rows must not come back as "none".
    await assert.rejects(() => script.run({ commit: false, design: '9043A' }),
      /no Inventory row carries design "9043A" — check the spelling/);
    // 75l42 for 75142, under --commit: not "Nothing to rewrite", and nothing written.
    await assert.rejects(() => script.run({ commit: true, design: '75l42' }),
      /no Inventory row carries design "75l42"/);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.store(), fixture(), 'the sheet is untouched');
    assert.equal(h.calls.invalidate, 0);
    // The real spellings still run, in either case.
    const ok = await script.run({ commit: false, design: '9043-a' });
    assert.deepEqual(ok.blank.map((b) => b.rowIndex), [8], 'the 9043-A gap is reported');
    assert.equal(ok.plan.length, 0);
  } finally { h.restore(); }
});

test('a row that drifted between the plan and the pre-write re-read is skipped, never written', async () => {
  const h = harness();
  try {
    // The first read builds the plan; the second (the guard) sees a hand
    // edit on row 2 and a different bale at row 4 — as after a sort.
    let reads = 0;
    const drifted = fixture();
    drifted[1][4] = '4-5';
    drifted[3] = row('7777', '75142', '2-6.', 1);
    sheets.readRange = async () => { reads += 1; return (reads === 1 ? fixture() : drifted).slice(1); };

    const res = await script.run({ commit: true });
    assert.equal(reads, 2, 'the sheet is re-read right before writing');
    assert.deepEqual(res.skipped.map((s) => s.rowIndex), [2, 4]);
    assert.match(res.skipped[0].why, /shade is now "4-5"/);
    assert.match(res.skipped[1].why, /bale is now "7777"/);
    assert.equal(res.written, 3);
    assert.deepEqual(h.writes.flatMap((w) => w.updates).map((u) => u.range), ['E3', 'E5', 'E10']);
  } finally { h.restore(); }
});

test('a dots-only cell is refused under --commit and a blank is never filled', async () => {
  const h = harness();
  try {
    const res = await script.run({ commit: true });
    assert.deepEqual(res.refused, [{ design: 'R-R', packageNo: '6200', rowIndex: 9, current: '.' }]);
    assert.deepEqual(res.blank, [{ design: '9043-A', packageNo: '6100', rowIndex: 8 }]);
    assert.equal(h.store()[8][4], '.', 'dots-only left exactly as it was');
    assert.equal(h.store()[7][4], '', 'the blank stays blank');
  } finally { h.restore(); }
});

test('nothing to do when the plan is empty: no write, no cache invalidation', async () => {
  const h = harness([HEADER, row('950', '77018', '4-5', 1), row('6001', '9037', 'BLACK', 1)]);
  try {
    const res = await script.run({ commit: true });
    assert.equal(res.plan.length, 0);
    assert.equal(res.written, 0);
    assert.deepEqual(h.writes, []);
    assert.equal(h.calls.invalidate, 0);
  } finally { h.restore(); }
});

test('a second --commit run is a no-op', async () => {
  const h = harness();
  try {
    await script.run({ commit: true });
    const again = await script.run({ commit: true });
    assert.equal(again.plan.length, 0);
    assert.equal(again.written, 0);
    assert.equal(h.writes.length, 1, 'only the first run wrote');
  } finally { h.restore(); }
});

test('parseArgs: --commit, --design in both spellings, and an unknown flag is refused', () => {
  assert.deepEqual(script.parseArgs(['node', 'x']), { commit: false, design: '' });
  assert.deepEqual(script.parseArgs(['node', 'x', '--commit']), { commit: true, design: '' });
  assert.deepEqual(script.parseArgs(['node', 'x', '--design', '75142']), { commit: false, design: '75142' });
  assert.deepEqual(script.parseArgs(['node', 'x', '--design=75142', '--commit']), { commit: true, design: '75142' });
  assert.throws(() => script.parseArgs(['node', 'x', '--desing', '75142']), /unknown argument/);
});

test('parseArgs: a --design with no value is refused, never widened to the whole sheet', () => {
  // The value forgotten at the end of the line.
  assert.throws(() => script.parseArgs(['node', 'x', '--commit', '--design']), /--design needs a design number/);
  // The value forgotten mid-line: the next flag must not be swallowed as the design.
  assert.throws(() => script.parseArgs(['node', 'x', '--design', '--commit']), /--design needs a design number/);
  // The = spelling with nothing after it, alone and with --commit.
  assert.throws(() => script.parseArgs(['node', 'x', '--design=']), /--design= needs a design number/);
  assert.throws(() => script.parseArgs(['node', 'x', '--design=', '--commit']), /--design= needs a design number/);
  // Whitespace-only is empty too.
  assert.throws(() => script.parseArgs(['node', 'x', '--design', '  ']), /--design needs a design number/);
  assert.throws(() => script.parseArgs(['node', 'x', '--design=  ']), /--design= needs a design number/);
  // A real value still parses in both spellings, either side of --commit.
  assert.deepEqual(script.parseArgs(['node', 'x', '--commit', '--design', '75142']), { commit: true, design: '75142' });
  assert.deepEqual(script.parseArgs(['node', 'x', '--commit', '--design=75142']), { commit: true, design: '75142' });
});

test('groupPlan orders design → bale → rows as the sheet does', () => {
  const grouped = script.groupPlan([
    { rowIndex: 2, design: '75142', packageNo: '6483' },
    { rowIndex: 4, design: '75142', packageNo: '6485' },
    { rowIndex: 3, design: '75142', packageNo: '6483' },
    { rowIndex: 10, design: 'R-R', packageNo: '6300' },
  ]);
  assert.deepEqual([...grouped.keys()], ['75142', 'R-R']);
  assert.deepEqual([...grouped.get('75142').keys()], ['6483', '6485']);
  assert.deepEqual(grouped.get('75142').get('6483').map((p) => p.rowIndex), [2, 3]);
});
