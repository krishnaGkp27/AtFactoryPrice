'use strict';

/**
 * ISC-1 Phase 2d — the pure planner behind scripts/repair-shade-spellings.js.
 *
 * Ruling R4 is deliberately narrow: strip the TRAILING dot and nothing
 * else. Most of these tests pin what the planner refuses to touch — case,
 * word shades, interior dots, blanks — and that the write guard treats any
 * drift between plan and live row as a skip, never a guess.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const repair = require(path.join(__dirname, '..', '..', '..', 'src', 'services', 'shadeSpellingRepair'));

const {
  canonicalShade, rowsFromCells, countRecords, buildPlan, blankShadeRows, blankAfterStripRows, verifyPlan,
} = repair;

/** One Inventory row A..F: PackageNo | Indent | CSNo | Design | Shade | ThanNo. */
const row = (pkg, design, shade, than) => [pkg, 'SA/1326', '', design, shade, than];

/** The §2c census in miniature — sheet row numbers start at 2. */
function census() {
  return [
    row('6483', '75142', '4-5.', 1),   // row 2  — the finding
    row('6483', '75142', '4-5.', 2),   // row 3
    row('6485', '75142', '2-6.', 1),   // row 4
    row('6486', '75142', '7-3.', 1),   // row 5
    row('950', '77018', '4-5', 1),     // row 6  — already canonical
    row('6001', '9037', 'BLACK', 1),   // row 7  — word shade, untouched
    row('6002', '9037', '4.5', 1),     // row 8  — interior dot, untouched
    row('6100', '9043-A', '', 1),      // row 9  — blank (report only)
    row('6100', '9043-A', '', 2),      // row 10 — blank (report only)
    row('6200', 'R-R', '.', 1),        // row 11 — dots only, refused
    ['', '', '', '', '', ''],          // row 12 — spacer, ignored everywhere
    row('6300', 'r-r', 'MIX.', 1),     // row 13 — another design with a dot
  ];
}

test('canonicalShade strips trailing dots only', () => {
  assert.equal(canonicalShade('4-5.'), '4-5');
  assert.equal(canonicalShade('2-6..'), '2-6');
  assert.equal(canonicalShade('7-3.'), '7-3');
  assert.equal(canonicalShade(' 7-3. '), '7-3', 'trimmed first');
  assert.equal(canonicalShade('4-5 .'), '4-5', 'no trailing space is left behind the dot');
  assert.equal(canonicalShade('.'), '', 'dots only strips to nothing — the planner refuses these');
});

test('canonicalShade leaves everything that is not a trailing dot alone', () => {
  assert.equal(canonicalShade('BLACK'), 'BLACK');
  assert.equal(canonicalShade('black.'), 'black', 'the dot goes, the case stays');
  assert.equal(canonicalShade('4.5'), '4.5', 'an interior dot is not trailing');
  assert.equal(canonicalShade('MIX'), 'MIX');
  assert.equal(canonicalShade(''), '');
  assert.equal(canonicalShade(null), '');
  assert.equal(canonicalShade(undefined), '');
  assert.equal(canonicalShade(12), '12', 'a numeric cell is a string spelling');
});

test('rowsFromCells keeps the shade RAW and tolerates short rows', () => {
  const rows = rowsFromCells([['6483', 'SA/1326', '', '75142', ' 4-5. ', '1'], ['6100', '', '', '9043-A'], []]);
  assert.equal(rows[0].rowIndex, 2);
  assert.equal(rows[0].shade, ' 4-5. ', 'untrimmed — the guard compares character for character');
  assert.equal(rows[0].packageNo, '6483');
  assert.equal(rows[0].design, '75142');
  assert.equal(rows[0].thanNo, 1);
  assert.equal(rows[1].rowIndex, 3);
  assert.equal(rows[1].shade, '', 'a row shorter than E reads as blank');
  assert.equal(rows[2].rowIndex, 4);
  assert.equal(rowsFromCells([['x']], 10)[0].rowIndex, 10, 'firstRow is honoured');
});

test('buildPlan lists exactly the dotted rows with current → next, in sheet order', () => {
  const plan = buildPlan(rowsFromCells(census()));
  assert.deepEqual(plan, [
    { rowIndex: 2, design: '75142', packageNo: '6483', thanNo: 1, current: '4-5.', next: '4-5' },
    { rowIndex: 3, design: '75142', packageNo: '6483', thanNo: 2, current: '4-5.', next: '4-5' },
    { rowIndex: 4, design: '75142', packageNo: '6485', thanNo: 1, current: '2-6.', next: '2-6' },
    { rowIndex: 5, design: '75142', packageNo: '6486', thanNo: 1, current: '7-3.', next: '7-3' },
    { rowIndex: 13, design: 'r-r', packageNo: '6300', thanNo: 1, current: 'MIX.', next: 'MIX' },
  ]);
});

test('buildPlan never plans a canonical, word, interior-dot, blank, dots-only or spacer row', () => {
  const planned = new Set(buildPlan(rowsFromCells(census())).map((p) => p.rowIndex));
  for (const r of [6, 7, 8, 9, 10, 11, 12]) assert.ok(!planned.has(r), `row ${r} is not touched`);
});

test('buildPlan --design filter is case-insensitive and exact', () => {
  const rows = rowsFromCells(census());
  assert.deepEqual(buildPlan(rows, { design: '75142' }).map((p) => p.rowIndex), [2, 3, 4, 5]);
  assert.deepEqual(buildPlan(rows, { design: 'R-R' }).map((p) => p.rowIndex), [13], 'r-r matches R-R');
  assert.deepEqual(buildPlan(rows, { design: '7514' }), [], 'a prefix is not a design');
  assert.equal(buildPlan(rows, { design: '' }).length, 5, 'an empty filter means every design');
});

test('countRecords counts the records the design filter matches, zero for a design that is not there', () => {
  const rows = rowsFromCells(census());
  assert.equal(countRecords(rows), 11, 'every record; the spacer row is not one');
  assert.equal(countRecords(rows, { design: '75142' }), 4);
  assert.equal(countRecords(rows, { design: '9043-a' }), 2, 'case-insensitive');
  assert.equal(countRecords(rows, { design: 'r-r' }), 2, 'both spellings of R-R');
  assert.equal(countRecords(rows, { design: '9043A' }), 0, 'the mistyped 9043-A matches nothing');
  assert.equal(countRecords(rows, { design: '75l42' }), 0, 'a typo is not a design');
  assert.equal(countRecords([], { design: '75142' }), 0);
});

test('blankShadeRows reports the gaps and only the gaps', () => {
  const rows = rowsFromCells(census());
  assert.deepEqual(blankShadeRows(rows), [
    { design: '9043-A', packageNo: '6100', rowIndex: 9 },
    { design: '9043-A', packageNo: '6100', rowIndex: 10 },
  ]);
  assert.deepEqual(blankShadeRows(rows, { design: '75142' }), [], 'the design filter applies to the report too');
  assert.deepEqual(blankShadeRows(rows, { design: '9043-a' }).map((b) => b.rowIndex), [9, 10]);
});

test('blankAfterStripRows names the dots-only cells the planner refuses', () => {
  const rows = rowsFromCells(census());
  assert.deepEqual(blankAfterStripRows(rows), [
    { design: 'R-R', packageNo: '6200', rowIndex: 11, current: '.' },
  ]);
  assert.deepEqual(blankAfterStripRows(rows, { design: '75142' }), []);
});

test('verifyPlan is ready only when design, bale, than and raw shade all still match', () => {
  const rows = rowsFromCells(census());
  const plan = buildPlan(rows);
  const same = verifyPlan(plan, rowsFromCells(census()));
  assert.equal(same.ready.length, 5);
  assert.deepEqual(same.skipped, []);
});

test('verifyPlan skips — with the reason — a row that was edited, moved, re-keyed or deleted', () => {
  const plan = buildPlan(rowsFromCells(census()));
  const live = census();
  live[0][4] = '4-5';                        // row 2: someone already fixed it by hand
  live[2] = row('6485', '75142', '2-6.', 3); // row 4: than renumbered
  live[3] = row('9999', '77018', '7-3.', 1); // row 5: a different bale now sits here (sorted sheet)
  live.length = 11;                          // row 13 is gone
  const { ready, skipped } = verifyPlan(plan, rowsFromCells(live));

  assert.deepEqual(ready.map((p) => p.rowIndex), [3], 'only the untouched row is written');
  assert.deepEqual(skipped.map((s) => s.rowIndex), [2, 4, 5, 13]);
  assert.match(skipped[0].why, /shade is now "4-5"/);
  assert.match(skipped[1].why, /than is now 3/);
  assert.match(skipped[2].why, /design is now "77018"/);
  assert.match(skipped[2].why, /bale is now "9999"/);
  assert.match(skipped[3].why, /no longer exists/);
});

test('verifyPlan compares the raw cell, so a whitespace drift is a skip too', () => {
  const plan = buildPlan(rowsFromCells([row('6483', '75142', '4-5.', 1)]));
  const { ready, skipped } = verifyPlan(plan, rowsFromCells([row('6483', '75142', '4-5. ', 1)]));
  assert.equal(ready.length, 0);
  assert.equal(skipped.length, 1);
});
