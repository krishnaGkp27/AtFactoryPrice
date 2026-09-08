'use strict';

/**
 * ISC-1 Phase 1a — inventoryAudit, the pure census over parsed Inventory
 * rows (specs/ISC-1_INVENTORY_SHEET_CLEANUP.md §2).
 *
 * Every function is pinned with the exact shapes the 04-Sep PDF census
 * found — and with the legitimate states each must NOT accuse: a readable
 * date in any of the four good shapes, a synthetic legacy uid on two rows,
 * two different shades that merely look alike, two people who share a word.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const audit = require(path.join(__dirname, '..', '..', '..', 'src', 'services', 'inventoryAudit'));

let nextRow = 2;
/** A parsed Inventory row (the parseRow shape) with sensible defaults. */
function row(extra = {}) {
  const rowIndex = extra.rowIndex || nextRow;
  nextRow = Math.max(nextRow, rowIndex) + 1;
  return {
    rowIndex, packageNo: '6151', indent: 'SA/1326', csNo: '1', design: '44200', shade: '1',
    thanNo: 1, yards: 30, status: 'available', warehouse: 'Lagos', pricePerYard: 2500,
    dateReceived: '2026-02-24', soldTo: '', soldDate: '', netMtrs: 27.43, netWeight: 0,
    updatedAt: '', productType: 'fabric', baleUid: `BAL-20260713-6151-${rowIndex}`,
    addedAt: '2026-02-24', grnId: '', binLocation: '', arrivalBatch: 'Mar26', designCategory: '',
    _legacy: false, ...extra,
  };
}
function sold(extra = {}) {
  return row({ status: 'sold', soldTo: 'CJE', soldDate: '2026-08-05', ...extra });
}

/* ── unparseableSoldDates ── */
test('unparseableSoldDates: the word-prefixed cell is junk; the four readable shapes are not', () => {
  const rows = [
    sold({ rowIndex: 10, soldDate: 'cashmere 12-February-2026', soldTo: 'madam oshodi', packageNo: '6151', thanNo: 3 }),
    sold({ rowIndex: 11, soldDate: 'cashmere 2026-07-27' }),
    sold({ rowIndex: 12, soldDate: '22-April-2026' }),
    sold({ rowIndex: 13, soldDate: '07 April 2026' }),
    sold({ rowIndex: 14, soldDate: '13-04-2026' }),
    sold({ rowIndex: 15, soldDate: '2026-08-05' }),
  ];
  const out = audit.unparseableSoldDates(rows);
  assert.deepEqual(out.map((o) => o.rowIndex), [10, 11]);
  assert.deepEqual(out[0], {
    rowIndex: 10, design: '44200', packageNo: '6151', thanNo: 3, soldTo: 'madam oshodi', soldDate: 'cashmere 12-February-2026',
  });
});

test('unparseableSoldDates: a BLANK date on a sold row, and junk on an AVAILABLE row, are not this finding', () => {
  const rows = [
    sold({ soldDate: '' }),
    row({ status: 'available', soldDate: 'TBD' }),
    sold({ soldDate: '   ' }),
  ];
  assert.deepEqual(audit.unparseableSoldDates(rows), []);
});

/* ── dateShape / dateShapes ── */
test('dateShape classifies every shape the PDF census found', () => {
  assert.equal(audit.dateShape('2026-08-05'), 'iso');
  assert.equal(audit.dateShape('22-April-2026'), 'day-monthname-year');
  assert.equal(audit.dateShape('07 April 2026'), 'day-monthname-year-spaces');
  assert.equal(audit.dateShape('13-04-2026'), 'dmy-numeric');
  assert.equal(audit.dateShape('2026-07-27T09:12:00.000Z'), 'timestamp');
  assert.equal(audit.dateShape('2026-02-24 10:00:00'), 'timestamp');
  assert.equal(audit.dateShape('cashmere 12-February-2026'), 'text-with-word-prefix');
  assert.equal(audit.dateShape('cashmere 2026-07-27'), 'text-with-word-prefix');
  assert.equal(audit.dateShape('madam oshodi cashmere 2026-07-27'), 'text-with-word-prefix');
  assert.equal(audit.dateShape('cashmere sometime'), 'other');
  assert.equal(audit.dateShape('TBD'), 'other');
  assert.equal(audit.dateShape(''), 'blank');
  assert.equal(audit.dateShape(null), 'blank');
  assert.equal(audit.dateShape(undefined), 'blank');
});

test('dateShapes counts every class (zeros included) and keeps up to 3 distinct examples', () => {
  const cells = ['2026-08-05', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', 'cashmere 12-February-2026', '', undefined, 'junk'];
  const { counts, examples } = audit.dateShapes(cells);
  assert.deepEqual(counts, {
    iso: 5, 'day-monthname-year': 0, 'day-monthname-year-spaces': 0, 'dmy-numeric': 0,
    timestamp: 0, 'text-with-word-prefix': 1, other: 1, blank: 2,
  });
  assert.deepEqual(examples.iso, ['2026-08-05', '2026-08-06', '2026-08-07'], 'distinct, capped at 3');
  assert.deepEqual(examples['text-with-word-prefix'], ['cashmere 12-February-2026']);
  assert.deepEqual(examples.other, ['junk']);
  assert.deepEqual(examples.blank, []);
  assert.deepEqual(Object.keys(counts), audit.DATE_SHAPES);
});

/* ── cellType / serialToIso / soldDateCensus ── */
test('cellType: a number is a date serial, a string is text, nothing is blank', () => {
  assert.equal(audit.cellType(46180), 'date');
  assert.equal(audit.cellType(46180.5), 'date');
  assert.equal(audit.cellType('cashmere 12-February-2026'), 'text');
  assert.equal(audit.cellType('2026-08-05'), 'text', 'ISO-looking TEXT is still text');
  assert.equal(audit.cellType(''), 'blank');
  assert.equal(audit.cellType(null), 'blank');
  assert.equal(audit.cellType(undefined), 'blank');
  // A hand-typed space: parseRow trims it to '' and the display shows
  // nothing, so the type must say blank too — otherwise the audit script's
  // alignment guard sees "formatted blank, unformatted text" on every run.
  assert.equal(audit.cellType(' '), 'blank');
  assert.equal(audit.cellType('\t \n'), 'blank');
  assert.equal(audit.cellType(' x '), 'text');
  assert.equal(audit.serialToIso(' '), null, 'whitespace is not serial 0 (1899-12-30)');
});

test('serialToIso converts a Sheets serial to the calendar day and rejects non-numbers', () => {
  assert.equal(audit.serialToIso(46216), '2026-07-13');
  assert.equal(audit.serialToIso(46216.75), '2026-07-13', 'the fraction is the time of day');
  assert.equal(audit.serialToIso(1), '1899-12-31');
  assert.equal(audit.serialToIso('2026-08-05'), null);
  assert.equal(audit.serialToIso(''), null);
  assert.equal(audit.serialToIso(null), null);
});

test('soldDateCensus lists every sold row with raw text, cell type and what the bot reads', () => {
  const rows = [
    sold({ rowIndex: 20, soldDate: '2026-08-05', packageNo: '869', soldTo: 'OKESON', thanNo: 2 }),
    sold({ rowIndex: 21, soldDate: 'cashmere 12-February-2026', soldTo: 'madam oshodi' }),
    row({ rowIndex: 22, status: 'available' }),
    sold({ rowIndex: 23, soldDate: '2026-03-01' }),
  ];
  const formatted = new Map([[20, '05-August-2026'], [21, 'cashmere 12-February-2026']]);
  const unformatted = new Map([[20, 46239], [21, 'cashmere 12-February-2026']]);
  const out = audit.soldDateCensus(rows, formatted, unformatted);
  assert.deepEqual(out.map((o) => o.rowIndex), [20, 21, 23], 'sold rows only');
  assert.deepEqual(out[0], {
    rowIndex: 20, bale: '869', design: '44200', thanNo: 2, buyer: 'OKESON',
    raw: '05-August-2026', cellType: 'date', normalised: '2026-08-05', serialIso: '2026-08-05',
  });
  assert.equal(out[1].cellType, 'text');
  assert.equal(out[1].normalised, null, 'the bot cannot read it');
  assert.equal(out[1].serialIso, null);
  // A row the K2:M read did not cover falls back to the parsed value.
  assert.equal(out[2].raw, '2026-03-01');
  assert.equal(out[2].cellType, 'text');
  assert.equal(out[2].normalised, '2026-03-01');
});

/* ── duplicateUids / legacyRows ── */
test('duplicateUids: one real uid on two rows is a duplicate; a BAL-LEGACY- stand-in on two rows is NOT', () => {
  const rows = [
    row({ rowIndex: 5201, baleUid: 'BAL-20260713-864-bjwg' }),
    row({ rowIndex: 5202, baleUid: 'BAL-20260713-864-bjwg' }),
    row({ rowIndex: 5203, baleUid: 'BAL-20260713-864-k2m9' }),
    row({ rowIndex: 30, baleUid: 'BAL-LEGACY-30', _legacy: true }),
    row({ rowIndex: 31, baleUid: 'BAL-LEGACY-30', _legacy: true }),
    row({ rowIndex: 32, baleUid: '', _legacy: true }),
    row({ rowIndex: 33, baleUid: '', _legacy: true }),
  ];
  assert.deepEqual(audit.duplicateUids(rows), [{ baleUid: 'BAL-20260713-864-bjwg', rows: [5201, 5202] }]);
});

test('legacyRows counts the parser flag (or the synthetic prefix) and lists the rows', () => {
  const rows = [
    row({ rowIndex: 2, _legacy: true, baleUid: 'BAL-LEGACY-2' }),
    row({ rowIndex: 3 }),
    row({ rowIndex: 4, _legacy: true, baleUid: 'BAL-LEGACY-4' }),
    row({ rowIndex: 5, _legacy: undefined, baleUid: 'BAL-LEGACY-5' }),
  ];
  assert.deepEqual(audit.legacyRows(rows), { count: 3, rowIndexes: [2, 4, 5] });
  assert.deepEqual(audit.legacyRows([]), { count: 0, rowIndexes: [] });
});

/* ── shadeSpellingVariants / blankShadesByDesign ── */
test("shadeSpellingVariants: '4-5' vs '4-5.' is a variant; '4-5' vs '4-6' is not; designs are separate", () => {
  const rows = [
    row({ rowIndex: 40, design: '75142', shade: '4-5' }),
    row({ rowIndex: 41, design: '75142', shade: '4-5.' }),
    row({ rowIndex: 42, design: '75142', shade: '4-5.' }),
    row({ rowIndex: 43, design: '75142', shade: '4-6' }),
    row({ rowIndex: 44, design: '77018', shade: '4-5' }),
    row({ rowIndex: 45, design: '9037', shade: 'BLACK' }),
    row({ rowIndex: 46, design: '9037', shade: 'black' }),
    row({ rowIndex: 47, design: '9037', shade: 'BLUE' }),
  ];
  const out = audit.shadeSpellingVariants(rows);
  assert.deepEqual(out, [
    { design: '75142', canonical: '4-5', variants: [{ shade: '4-5', rows: [40] }, { shade: '4-5.', rows: [41, 42] }] },
    { design: '9037', canonical: 'BLACK', variants: [{ shade: 'BLACK', rows: [45] }, { shade: 'black', rows: [46] }] },
  ]);
  // Same spelling on every row of a design → nothing to report.
  assert.deepEqual(audit.shadeSpellingVariants([row({ design: '75142', shade: '4-5' }), row({ design: '75142', shade: '4-5' })]), []);
  // The design match is case-insensitive.
  const mixedCase = audit.shadeSpellingVariants([row({ design: 'r-r', shade: 'MIX' }), row({ design: 'R-R', shade: 'mix' })]);
  assert.equal(mixedCase.length, 1);
});

test('blankShadesByDesign groups shadeless rows per design', () => {
  const rows = [
    row({ rowIndex: 50, design: '9037-D', shade: '' }),
    row({ rowIndex: 51, design: '9037-D', shade: '' }),
    row({ rowIndex: 52, design: '9043-A', shade: '  ' }),
    row({ rowIndex: 53, design: '9043-A', shade: '2' }),
  ];
  assert.deepEqual(audit.blankShadesByDesign(rows), [
    { design: '9037-D', rows: [50, 51] },
    { design: '9043-A', rows: [52] },
  ]);
});

/* ── oversizeThans / zeroPriceSold ── */
test('oversizeThans lists thans at or above the threshold (default 40) with the physical-audit fields', () => {
  const rows = [
    row({ rowIndex: 60, packageNo: '6061', design: '77014', indent: 'SA/2521', arrivalBatch: 'Jul26', thanNo: 3, yards: 60, warehouse: 'IDUMOTA' }),
    row({ rowIndex: 61, yards: 40 }),
    row({ rowIndex: 62, yards: 39.9 }),
    row({ rowIndex: 63, yards: 30 }),
    sold({ rowIndex: 64, yards: 45, soldTo: 'ABBA' }),
  ];
  const out = audit.oversizeThans(rows);
  assert.deepEqual(out.map((o) => o.rowIndex), [60, 61, 64]);
  assert.deepEqual(out[0], {
    rowIndex: 60, design: '77014', packageNo: '6061', indent: 'SA/2521', arrivalBatch: 'Jul26',
    thanNo: 3, yards: 60, status: 'available', warehouse: 'IDUMOTA', soldTo: '',
  });
  assert.equal(out[2].soldTo, 'ABBA');
  assert.deepEqual(audit.oversizeThans(rows, { minYards: 50 }).map((o) => o.rowIndex), [60]);
});

test('zeroPriceSold groups SOLD rows at zero price per sale; priced and available rows are ignored', () => {
  const rows = [
    sold({ rowIndex: 70, design: '9037', packageNo: '900', soldTo: 'CJE', soldDate: '2026-08-05', pricePerYard: 0 }),
    sold({ rowIndex: 71, design: '9037', packageNo: '900', soldTo: 'CJE', soldDate: '2026-08-05', pricePerYard: 0 }),
    sold({ rowIndex: 72, design: '9037', packageNo: '901', soldTo: 'OKESON', soldDate: '2026-08-06', pricePerYard: 0 }),
    sold({ rowIndex: 73, design: '9037', packageNo: '902', soldTo: 'CJE', soldDate: '2026-08-05', pricePerYard: 2500 }),
    row({ rowIndex: 74, pricePerYard: 0 }),
  ];
  assert.deepEqual(audit.zeroPriceSold(rows), [
    { design: '9037', packageNo: '900', soldTo: 'CJE', soldDate: '2026-08-05', rows: [70, 71] },
    { design: '9037', packageNo: '901', soldTo: 'OKESON', soldDate: '2026-08-06', rows: [72] },
  ]);
});

/* ── customerSpellingClusters ── */
test('customerSpellingClusters: Awunawu / Awurawu / awunawu cluster; Ketu madam / ketu police Man do not', () => {
  const rows = [
    sold({ rowIndex: 80, soldTo: 'Awunawu', warehouse: 'Lagos' }),
    sold({ rowIndex: 81, soldTo: 'Awunawu', warehouse: 'Lagos' }),
    sold({ rowIndex: 82, soldTo: 'Awurawu', warehouse: 'IDUMOTA' }),
    sold({ rowIndex: 83, soldTo: 'awunawu', warehouse: 'IDUMOTA' }),
    sold({ rowIndex: 84, soldTo: 'Ketu madam' }),
    sold({ rowIndex: 85, soldTo: 'ketu police Man' }),
    sold({ rowIndex: 86, soldTo: 'CJE' }),
    sold({ rowIndex: 87, soldTo: 'ABBA' }),
    sold({ rowIndex: 88, soldTo: 'ABBI' }),
  ];
  const out = audit.customerSpellingClusters(rows);
  assert.equal(out.length, 1, 'exactly the Awunawu cluster');
  // Members: most rows first, then by name (locale order, so `awunawu` < `Awurawu`).
  assert.deepEqual(out[0].members, [
    { soldTo: 'Awunawu', rows: [80, 81], warehouses: ['Lagos'] },
    { soldTo: 'awunawu', rows: [83], warehouses: ['IDUMOTA'] },
    { soldTo: 'Awurawu', rows: [82], warehouses: ['IDUMOTA'] },
  ]);
  assert.match(out[0].reason, /same letters/);
  assert.match(out[0].reason, /one letter apart/);
  // ABBA / ABBI are one edit apart but too short (4 chars) to trust.
  assert.ok(!out.some((c) => c.members.some((m) => m.soldTo === 'ABBA')));
});

test("customerSpellingClusters: 'madam oshodi' and 'oshodi madam' cluster by token set", () => {
  const rows = [
    sold({ rowIndex: 90, soldTo: 'madam oshodi' }),
    sold({ rowIndex: 91, soldTo: 'oshodi madam' }),
    sold({ rowIndex: 92, soldTo: 'Oshodi alaja' }),
    sold({ rowIndex: 93, soldTo: 'Alhaja oshodi' }),
  ];
  const out = audit.customerSpellingClusters(rows);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].members.map((m) => m.soldTo), ['madam oshodi', 'oshodi madam']);
  assert.equal(out[0].reason, 'same words, different order');
  // Oshodi alaja / Alhaja oshodi share neither letters nor a token set —
  // that pair is the owner's ruling (R2), not a candidate this code invents.
});

test('customerSpellingClusters: nothing to cluster → []; a lone spelling is never a cluster', () => {
  assert.deepEqual(audit.customerSpellingClusters([]), []);
  assert.deepEqual(audit.customerSpellingClusters([sold({ soldTo: 'CJE' }), row({ soldTo: '' })]), []);
});

test('damerauLevenshtein counts an adjacent swap as ONE edit', () => {
  const { damerauLevenshtein } = audit._internals;
  assert.equal(damerauLevenshtein('awunawu', 'awurawu'), 1);
  assert.equal(damerauLevenshtein('awunawu', 'awnuawu'), 1, 'transposition');
  assert.equal(damerauLevenshtein('awunawu', 'awunawu'), 0);
  assert.equal(damerauLevenshtein('awunawu', 'awunaw'), 1);
  assert.equal(damerauLevenshtein('ketumadam', 'ketupoliceman') > 1, true);
  assert.equal(damerauLevenshtein('', 'abc'), 3);
});

/* ── blankRates ── */
test('blankRates counts blanks per parsed field, with baleUid taken from the legacy flag', () => {
  const rows = [
    row({ rowIndex: 2, shade: '', pricePerYard: 0, netWeight: 0, _legacy: true, baleUid: 'BAL-LEGACY-2' }),
    row({ rowIndex: 3, binLocation: '', grnId: 'GRN-20260713-001', netWeight: 12 }),
  ];
  const out = audit.blankRates(rows);
  assert.deepEqual(out.shade, { blank: 1, total: 2 });
  assert.deepEqual(out.pricePerYard, { blank: 1, total: 2 });
  assert.deepEqual(out.netWeight, { blank: 1, total: 2 });
  assert.deepEqual(out.binLocation, { blank: 2, total: 2 });
  assert.deepEqual(out.grnId, { blank: 1, total: 2 });
  assert.deepEqual(out.baleUid, { blank: 1, total: 2 }, 'the stand-in uid is not a value');
  assert.deepEqual(out.design, { blank: 0, total: 2 });
  assert.equal(Object.keys(out).length, 23, 'every parsed column');
});

/* ── audit (all at once) ── */
test('audit runs every list over one snapshot and honours minYards', () => {
  const rows = [
    sold({ rowIndex: 100, soldDate: 'cashmere 12-February-2026', pricePerYard: 0 }),
    row({ rowIndex: 101, yards: 60 }),
  ];
  const out = audit.audit(rows, { minYards: 50 });
  assert.deepEqual(Object.keys(out), [
    'unparseableSoldDates', 'duplicateUids', 'shadeVariants', 'blankShades', 'legacy',
    'oversize', 'zeroPriceSold', 'customerClusters', 'blankRates',
  ]);
  assert.equal(out.unparseableSoldDates.length, 1);
  assert.equal(out.oversize.length, 1);
  assert.equal(out.zeroPriceSold.length, 1);
  assert.equal(out.legacy.count, 0);
  assert.equal(out.blankRates.yards.total, 2);
});
