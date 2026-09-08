'use strict';

/**
 * ISC-1 Phase 2a — the sold-date repair PLANNER, pinned on the exact cell
 * shapes the 04-Sep-2026 Inventory PDF showed (§2a of the spec).
 *
 * This planner decides which live SoldDate cells get rewritten, so most of
 * these tests are about what it REFUSES to plan: a real date cell (its
 * display is another script's job), an available row, text that nothing
 * parses, a relative word, a cell whose two renders disagree. And the
 * invariant the whole repair rests on — what is written reads back as the
 * same day — checked twice: on the planned string, and on what the sheet
 * actually shows once the cell is a date (verifyAfterWrite).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const repair = require('../../../src/services/soldDateRepair');
const { normalizeSalesDate } = require('../../../src/utils/dates');

/** One A..M Inventory row as readRange returns it. */
function row({ pkg = '1234', design = '44200', than = 1, status = 'sold', soldTo = 'madam oshodi', soldDate = '' } = {}) {
  return [pkg, 'SA/1326', '1', design, '4', than, 30, status, 'Lagos', 0, '2026-02-24', soldTo, soldDate];
}

/* ── the five fixtures the item names ── */

test('cashmere prefix (75 madam oshodi rows) → planned, reason (a)', () => {
  const v = repair.classifyRow({
    rowIndex: 12,
    formatted: row({ soldDate: 'cashmere 12-February-2026' }),
    unformatted: 'cashmere 12-February-2026',
  });
  assert.equal(v.verdict, 'plan');
  assert.deepEqual(v.entry, {
    rowIndex: 12, packageNo: '1234', design: '44200', thanNo: '1', soldTo: 'madam oshodi',
    current: 'cashmere 12-February-2026', proposed: '2026-02-12', reason: 'a',
  });
});

test('cashmere + ISO tail (30 Madam motunrayo rows) → planned, reason (a)', () => {
  const v = repair.classifyRow({
    rowIndex: 40,
    formatted: row({ soldTo: 'Madam motunrayo', soldDate: 'cashmere 2026-07-27' }),
    unformatted: 'cashmere 2026-07-27',
  });
  assert.equal(v.verdict, 'plan');
  assert.equal(v.entry.proposed, '2026-07-27');
  assert.equal(v.entry.reason, 'a');
});

test('a TEXT cell holding a parseable date → planned, reason (b), same day the bot already reads', () => {
  for (const text of ['07 April 2026', '13-04-2026', '22-April-2026', '2026-08-05']) {
    const v = repair.classifyRow({ rowIndex: 7, formatted: row({ soldDate: text }), unformatted: text });
    assert.equal(v.verdict, 'plan', text);
    assert.equal(v.entry.reason, 'b', text);
    assert.equal(v.entry.proposed, normalizeSalesDate(text), `${text}: the bot's own reading of the cell`);
  }
});

test('a DATE-typed cell (stored as a serial number) is never touched, whatever it displays', () => {
  for (const shown of ['22-April-2026', '2026-08-05', '07 April 2026', '13-04-2026']) {
    const v = repair.classifyRow({ rowIndex: 9, formatted: row({ soldDate: shown }), unformatted: 46134 });
    assert.equal(v.verdict, 'skip', shown);
    assert.equal(v.why, 'date-typed', shown);
  }
});

test('an available row is skipped, even with junk in M', () => {
  const v = repair.classifyRow({
    rowIndex: 3,
    formatted: row({ status: 'available', soldTo: '', soldDate: 'cashmere 12-February-2026' }),
    unformatted: 'cashmere 12-February-2026',
  });
  assert.deepEqual(v, { verdict: 'skip', why: 'not-sold', rowIndex: 3 });
});

test('unparseable garbage is reported, not planned — never guessed', () => {
  for (const text of ['sometime soon', 'cashmere', '12 cashmere February 2026', '31-02-2026']) {
    const v = repair.classifyRow({ rowIndex: 5, formatted: row({ soldDate: text }), unformatted: text });
    assert.equal(v.verdict, 'skip', text);
    assert.equal(v.why, 'unparseable', text);
    assert.equal(v.current, text);
  }
});

/* ── the refusals beyond the five ── */

test('a relative word is refused: "today" means the day it was typed, not the day the script runs', () => {
  for (const text of ['today', 'Yesterday', 'cashmere today']) {
    const v = repair.classifyRow({ rowIndex: 5, formatted: row({ soldDate: text }), unformatted: text });
    assert.equal(v.verdict, 'skip', text);
    assert.equal(v.why, 'relative-word', text);
  }
});

test('a sold row with a blank M, or a cell whose two renders disagree, is reported', () => {
  const blank = repair.classifyRow({ rowIndex: 5, formatted: row({ soldDate: '' }), unformatted: undefined });
  assert.equal(blank.why, 'blank');
  const bool = repair.classifyRow({ rowIndex: 5, formatted: row({ soldDate: 'TRUE' }), unformatted: true });
  assert.equal(bool.why, 'odd-cell-type');
  const differs = repair.classifyRow({ rowIndex: 5, formatted: row({ soldDate: '2026-08-05' }), unformatted: '2026-08-06' });
  assert.equal(differs.why, 'odd-cell-type');
  assert.match(differs.detail, /differs from the display/);
});

test('every planned day reads back as itself through normalizeSalesDate', () => {
  const texts = ['cashmere 12-February-2026', 'cashmere 2026-07-27', '07 April 2026', '13-04-2026', '2026-08-05'];
  for (const text of texts) {
    const v = repair.classifyRow({ rowIndex: 2, formatted: row({ soldDate: text }), unformatted: text });
    assert.equal(normalizeSalesDate(v.entry.proposed), v.entry.proposed, text);
  }
});

/* ── planRepairs over a sheet ── */

const FORMATTED = [
  row({ pkg: '1234', than: 1, soldDate: 'cashmere 12-February-2026' }),                          // row 2 (a)
  row({ pkg: '1234', than: 2, soldTo: 'Madam motunrayo', soldDate: 'cashmere 2026-07-27' }),    // row 3 (a)
  row({ pkg: '6001', design: '9037', than: 1, soldTo: 'CJE', soldDate: '07 April 2026' }),      // row 4 (b)
  row({ pkg: '6001', design: '9037', than: 2, soldTo: 'CJE', soldDate: '22-April-2026' }),      // row 5 date-typed
  row({ pkg: '6001', design: '9037', than: 3, status: 'available', soldTo: '', soldDate: '' }), // row 6 available
  row({ pkg: '6002', design: '9037', than: 1, soldTo: 'ABBA', soldDate: 'sometime soon' }),     // row 7 garbage
];
const UNFORMATTED = [
  ['cashmere 12-February-2026'], ['cashmere 2026-07-27'], ['07 April 2026'], [46134], [], ['sometime soon'],
];

test('planRepairs: plans the text cells in sheet order, counts the rest, reports the garbage', () => {
  const { plan, reported, counts } = repair.planRepairs({ formattedRows: FORMATTED, unformattedRows: UNFORMATTED });
  assert.deepEqual(plan.map((e) => [e.rowIndex, e.proposed, e.reason]),
    [[2, '2026-02-12', 'a'], [3, '2026-07-27', 'a'], [4, '2026-04-07', 'b']]);
  assert.deepEqual(reported.map((r) => [r.rowIndex, r.why]), [[7, 'unparseable']]);
  assert.deepEqual(counts, { scanned: 6, filtered: 0, sold: 5, dateTyped: 1, planned: 3, reported: 1 });
});

test('planRepairs: --design narrows to one design (case-insensitive), --rows to listed sheet rows', () => {
  const byDesign = repair.planRepairs({ formattedRows: FORMATTED, unformattedRows: UNFORMATTED, design: '44200' });
  assert.deepEqual(byDesign.plan.map((e) => e.rowIndex), [2, 3]);
  assert.equal(byDesign.counts.filtered, 4);
  assert.equal(byDesign.reported.length, 0, 'the garbage row is on another design, so out of scope');

  const byRows = repair.planRepairs({
    formattedRows: FORMATTED, unformattedRows: UNFORMATTED, rows: repair.parseRowsArg('4-7'),
  });
  assert.deepEqual(byRows.plan.map((e) => e.rowIndex), [4]);
  assert.deepEqual(byRows.reported.map((r) => r.rowIndex), [7]);
  assert.equal(byRows.counts.filtered, 2);
});

test('planRepairs: an unformatted read shorter than the formatted one is a blank, never a crash', () => {
  const { plan, reported } = repair.planRepairs({ formattedRows: FORMATTED, unformattedRows: UNFORMATTED.slice(0, 2) });
  assert.deepEqual(plan.map((e) => e.rowIndex), [2, 3]);
  assert.ok(reported.some((r) => r.rowIndex === 4 && r.why === 'odd-cell-type'), 'row 4 lost its stored type → reported');
});

/* ── the CUS-ID1 guard ── */

const ENTRY = {
  rowIndex: 2, packageNo: '1234', design: '44200', thanNo: '1', soldTo: 'madam oshodi',
  current: 'cashmere 12-February-2026', proposed: '2026-02-12', reason: 'a',
};

test('verifyBeforeWrite: passes only when text, type and identity all still match', () => {
  assert.deepEqual(repair.verifyBeforeWrite(ENTRY, FORMATTED[0], 'cashmere 12-February-2026'), { ok: true });

  const fixedByHand = repair.verifyBeforeWrite(ENTRY, row({ soldDate: '12-February-2026' }), 46065);
  assert.equal(fixedByHand.ok, false);
  assert.match(fixedByHand.why, /SoldDate now reads/);

  const nowADate = repair.verifyBeforeWrite(ENTRY, FORMATTED[0], 46065);
  assert.equal(nowADate.ok, false);
  assert.match(nowADate.why, /now a real date/);

  const otherBale = repair.verifyBeforeWrite(ENTRY, row({ pkg: '9999', soldDate: 'cashmere 12-February-2026' }), 'cashmere 12-February-2026');
  assert.equal(otherBale.ok, false);
  assert.match(otherBale.why, /packageNo now reads "9999"/);

  const otherBuyer = repair.verifyBeforeWrite(ENTRY, row({ soldTo: 'CJE', soldDate: 'cashmere 12-February-2026' }), 'cashmere 12-February-2026');
  assert.equal(otherBuyer.ok, false);
  assert.match(otherBuyer.why, /soldTo now reads "CJE"/);

  const gone = repair.verifyBeforeWrite(ENTRY, undefined, undefined);
  assert.equal(gone.ok, false);
});

/* ── the read-back ── */

test('verifyAfterWrite: the sheet\'s own rendering must read back as the planned day', () => {
  const written = { ...ENTRY, proposed: '2026-04-07' };

  // The Phase 0a look (dd-mmmm-yyyy) and the ISO look both read back.
  assert.deepEqual(repair.verifyAfterWrite(written, '07-April-2026', 46119),
    { ok: true, display: '07-April-2026', readBack: '2026-04-07', storedAsDate: true });
  assert.equal(repair.verifyAfterWrite(written, '2026-04-07', 46119).ok, true);

  // dd/mm/yy: the normaliser needs a 4-digit year → reads nothing → the sale
  // would drop out of every window. Reported, never silently accepted.
  const twoDigitYear = repair.verifyAfterWrite(written, '07/04/26', 46119);
  assert.equal(twoDigitYear.ok, false);
  assert.equal(twoDigitYear.readBack, null);
  assert.match(twoDigitYear.why, /now displays "07\/04\/26", which reads back as nothing — wanted 2026-04-07/);

  // m/d/yyyy: read DMY as 4 July — silently the wrong day. Caught.
  const monthFirst = repair.verifyAfterWrite(written, '4/7/2026', 46119);
  assert.equal(monthFirst.ok, false);
  assert.equal(monthFirst.readBack, '2026-07-04');
  assert.match(monthFirst.why, /reads back as 2026-07-04 — wanted 2026-04-07/);

  // A blank or missing cell reads back as nothing.
  assert.equal(repair.verifyAfterWrite(written, undefined, undefined).ok, false);
});

test('verifyAfterWrite: a cell Sheets still stores as TEXT reads the right day but is flagged storedAsDate=false', () => {
  const written = { ...ENTRY, proposed: '2026-04-07' };
  assert.deepEqual(repair.verifyAfterWrite(written, '2026-04-07', '2026-04-07'),
    { ok: true, display: '2026-04-07', readBack: '2026-04-07', storedAsDate: false });
});

/* ── --rows parsing ── */

test('parseRowsArg: "12,13-40" → the 29 listed rows; anything else is refused', () => {
  const rows = repair.parseRowsArg('12,13-40');
  assert.equal(rows.size, 29);
  assert.ok(rows.has(12) && rows.has(13) && rows.has(40) && !rows.has(41));
  assert.throws(() => repair.parseRowsArg('abc'), /not a row number/);
  assert.throws(() => repair.parseRowsArg('1'), /rows ≥ 2/);
  assert.throws(() => repair.parseRowsArg('40-13'), /low then high/);
  assert.throws(() => repair.parseRowsArg(''), /no rows given/);
});
