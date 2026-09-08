'use strict';

/**
 * ISC-1 Phase 1a — the read-only audit script, pinned without a sheet:
 * argument parsing (there is no --commit), the one-snapshot A2:W load, the
 * K2:M column maps, the formatted-vs-unformatted alignment guard, the cell
 * type tally, and the shape of the console report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArgs, buildReport, columnMap, typeCounts, loadInventory, cellMismatch, misalignedCells, assertAligned, OUT_FILES,
} = require('../../../scripts/audit-inventory-sheet');
const inventoryAudit = require('../../../src/services/inventoryAudit');

/** An A2:W row with only the cells that matter here (K = index 10, M = index 12). */
function sheetRow({ packageNo = '6061', design = '77014', status = 'available', dateReceived = '', soldTo = '', soldDate = '', uid = 'BAL-1' } = {}) {
  const r = [];
  r[0] = packageNo; r[3] = design; r[4] = '1'; r[5] = '1'; r[6] = '30'; r[7] = status; r[8] = 'Lagos'; r[9] = '2500';
  r[10] = dateReceived; r[11] = soldTo; r[12] = soldDate; r[17] = uid;
  return r;
}

test('parseArgs: --out and --min-yards; --commit is refused because the audit is read-only', () => {
  assert.deepEqual(parseArgs(['node', 'x']), { out: '', minYards: 40 });
  assert.deepEqual(parseArgs(['node', 'x', '--out', '/tmp/isc1']), { out: '/tmp/isc1', minYards: 40 });
  assert.deepEqual(parseArgs(['node', 'x', '--out=/tmp/isc1', '--min-yards=50']), { out: '/tmp/isc1', minYards: 50 });
  assert.throws(() => parseArgs(['node', 'x', '--commit']), /read-only/);
  assert.throws(() => parseArgs(['node', 'x', '--min-yards', '0']), /positive/);
  assert.throws(() => parseArgs(['node', 'x', '--bogus']), /unknown argument/);
});

test('columnMap keys a K2:M read by sheet row; typeCounts tallies date/text/blank over the rows the bot sees', () => {
  const grid = [[46000, 'CJE', 'cashmere 12-February-2026'], [46050], []];
  const k = columnMap(grid, 0);
  const m = columnMap(grid, 2);
  assert.equal(k.get(2), 46000);
  assert.equal(m.get(2), 'cashmere 12-February-2026');
  assert.equal(k.get(3), 46050);
  assert.equal(m.get(3), undefined, 'trailing cells the API omitted are blank');
  assert.equal(k.get(4), undefined);
  const rows = [{ rowIndex: 2 }, { rowIndex: 3 }, { rowIndex: 4 }, { rowIndex: 9 }];
  assert.deepEqual(typeCounts(rows, k), { date: 2, text: 0, blank: 2 });
  assert.deepEqual(typeCounts(rows, m), { date: 0, text: 1, blank: 3 });
});

test('loadInventory: parsed rows and the raw K/M cells come from the ONE A2:W grid, blank rows dropped with rowIndex kept', () => {
  const grid = [
    sheetRow({ status: 'sold', dateReceived: '07 April 2026', soldTo: 'madam oshodi', soldDate: '05-August-2026' }),
    [], // a blank sheet row — getAll drops it, the next row is still sheet row 4
    sheetRow({ status: 'sold', dateReceived: '2026-02-24', soldTo: 'Awunawu', soldDate: 'cashmere 12-February-2026', uid: '' }),
    sheetRow({ dateReceived: '13-04-2026' }),
  ];
  const { rows, fmtK, fmtM } = loadInventory(grid);
  assert.deepEqual(rows.map((r) => r.rowIndex), [2, 4, 5]);
  assert.equal(rows[0].soldDate, '2026-08-05', 'parsed the way inventoryRepository.parseRow does');
  assert.equal(rows[1].soldDate, 'cashmere 12-February-2026', 'unparseable text left as is, like parseRow');
  assert.equal(rows[1]._legacy, true);
  assert.equal(fmtM.get(2), '05-August-2026', 'raw M text of the same grid row');
  assert.equal(fmtM.get(4), 'cashmere 12-February-2026');
  assert.equal(fmtM.get(5), '');
  assert.equal(fmtK.get(5), '13-04-2026');
  assert.equal(fmtK.get(3), undefined, 'the blank row has no cells');
  assert.deepEqual(loadInventory([]).rows, []);
});

test('cellMismatch: the two renders of ONE cell agree; only a shifted pair is flagged', () => {
  assert.equal(cellMismatch('', undefined), null, 'blank / blank');
  assert.equal(cellMismatch(undefined, ''), null);
  assert.equal(cellMismatch('cashmere 12-February-2026', 'cashmere 12-February-2026'), null, 'text cell, same string');
  assert.equal(cellMismatch('05-August-2026', 46239), null, 'date cell whose serial IS the displayed day');
  assert.equal(cellMismatch('2026-08-05', 46239), null);
  assert.equal(cellMismatch('45', 45), null, 'a number the display cannot date is not accused');
  assert.equal(cellMismatch('05/08/2026 14:30', 46239.6), null, 'time-stamped display does not normalise — left alone');
  assert.match(cellMismatch('05-August-2026', 'cashmere 12-February-2026'), /text differs/);
  assert.equal(cellMismatch('cashmere 12-February-2026', 46239), null, 'a display that cannot be dated is not compared to the serial');
  assert.match(cellMismatch('2026-08-06', 46239), /displays 2026-08-06, serial is 2026-08-05/);
  assert.match(cellMismatch('', 46239), /formatted cell is blank, unformatted cell is date/);
  assert.match(cellMismatch('', 'x'), /formatted cell is blank, unformatted cell is text/);
  assert.match(cellMismatch('05-August-2026', ''), /formatted cell has text, unformatted cell is blank/);
  // A whitespace-only cell is blank under both renders — it is data, not a
  // re-order, and must not abort the run.
  assert.equal(cellMismatch(' ', ' '), null, 'hand-typed space / hand-typed space');
  assert.equal(cellMismatch('', ' '), null);
  assert.equal(cellMismatch(' ', undefined), null);
});

test('a whitespace-only date cell passes the alignment guard and counts as blank', () => {
  const grid = [
    ['869', 'IND1', '', '9060-A', '01', '1', '30', 'sold', 'IDUMOTA', '', ' ', 'OKSON', ' '],
    ['869', 'IND1', '', '9060-A', '01', '2', '30', 'sold', 'IDUMOTA', '', '05-August-2026', 'OKSON', '05-August-2026'],
  ];
  const { rows, fmtK, fmtM } = loadInventory(grid);
  const unf = [[' ', 'OKSON', ' '], [46239, 'OKSON', 46239]];
  const byCol = { K: misalignedCells(rows, fmtK, columnMap(unf, 0)), M: misalignedCells(rows, fmtM, columnMap(unf, 2)) };
  assert.deepEqual(byCol, { K: [], M: [] });
  assert.doesNotThrow(() => assertAligned(byCol));
  assert.deepEqual(typeCounts(rows, columnMap(unf, 2)), { date: 1, text: 0, blank: 1 });
});

test('misalignedCells + assertAligned: a K2:M read shifted by one row is refused before anything is reported', () => {
  const grid = [
    sheetRow({ status: 'sold', dateReceived: '2026-02-24', soldTo: 'madam oshodi', soldDate: '2026-08-05' }),
    sheetRow({ status: 'sold', dateReceived: '2026-02-24', soldTo: 'Awunawu', soldDate: 'cashmere 12-February-2026' }),
    sheetRow({ dateReceived: '2026-02-24' }),
  ];
  const { rows, fmtK, fmtM } = loadInventory(grid);

  // Same snapshot: row 2 is a date cell (serial 46239), row 3 a text cell, row 4 blank.
  const aligned = [[46077, 'madam oshodi', 46239], [46077, 'Awunawu', 'cashmere 12-February-2026'], [46077]];
  assert.deepEqual(misalignedCells(rows, fmtM, columnMap(aligned, 2)), []);
  assert.deepEqual(misalignedCells(rows, fmtK, columnMap(aligned, 0)), []);
  assert.doesNotThrow(() => assertAligned({ K: [], M: [] }));

  // The finding's probe: a row inserted (or a sort) between the two reads shifts K2:M down one.
  const shifted = [[46077, 'Awunawu', 'cashmere 12-February-2026'], [46077, '', ''], [46077, 'madam oshodi', 46239]];
  const badM = misalignedCells(rows, fmtM, columnMap(shifted, 2));
  assert.deepEqual(badM.map((m) => m.rowIndex), [2, 3, 4], 'every shifted row is named, not just the first');
  assert.match(badM[0].why, /text differs/);
  assert.equal(badM[0].formatted, '2026-08-05');
  assert.equal(badM[0].unformatted, 'cashmere 12-February-2026');
  assert.match(badM[1].why, /formatted cell has text, unformatted cell is blank/);
  assert.match(badM[2].why, /formatted cell is blank, unformatted cell is date/);
  assert.equal(misalignedCells(rows, fmtK, columnMap(shifted, 0)).length, 0, 'K is all one date — the shift is invisible there, M catches it');

  assert.throws(
    () => assertAligned({ K: [], M: badM }),
    (e) => /^reads misaligned — re-run/.test(e.message)
      && /column M: 3 row\(s\) disagree/.test(e.message)
      && /row 2 · formatted "2026-08-05" · unformatted "cashmere 12-February-2026" · text differs/.test(e.message)
      && /nothing was reported or written/.test(e.message),
  );
});

test('assertAligned caps the named rows at five per column and says how many more', () => {
  const list = Array.from({ length: 8 }, (_, i) => ({ rowIndex: 2 + i, formatted: '2026-08-05', unformatted: 'x', why: 'text differs between the two renders' }));
  assert.throws(() => assertAligned({ K: list, M: [] }), (e) => {
    assert.match(e.message, /column K: 8 row\(s\) disagree/);
    assert.equal((e.message.match(/ · text differs/g) || []).length, 5, 'five example rows');
    assert.match(e.message, /…and 3 more/);
    assert.doesNotMatch(e.message, /column M/);
    return true;
  });
});

test('buildReport prints every section with its count and first examples', () => {
  const rows = [
    {
      rowIndex: 2, packageNo: '6151', design: '44200', shade: '1', thanNo: 1, yards: 30, status: 'sold',
      warehouse: 'Lagos', pricePerYard: 0, soldTo: 'madam oshodi', soldDate: 'cashmere 12-February-2026',
      baleUid: 'BAL-LEGACY-2', _legacy: true, indent: 'SA/1326', arrivalBatch: 'Mar26',
    },
    {
      rowIndex: 3, packageNo: '6061', design: '77014', shade: '4-5.', thanNo: 3, yards: 60, status: 'available',
      warehouse: 'IDUMOTA', pricePerYard: 2500, soldTo: '', soldDate: '',
      baleUid: 'BAL-1', _legacy: false, indent: 'SA/2521', arrivalBatch: 'Jul26',
    },
    {
      rowIndex: 4, packageNo: '6061', design: '77014', shade: '4-5', thanNo: 4, yards: 30, status: 'sold',
      warehouse: 'IDUMOTA', pricePerYard: 2500, soldTo: 'oshodi madam', soldDate: '2026-08-05',
      baleUid: 'BAL-1', _legacy: false, indent: 'SA/2521', arrivalBatch: 'Jul26',
    },
  ];
  const findings = inventoryAudit.audit(rows);
  const fmtM = new Map([[2, 'cashmere 12-February-2026'], [4, '05-August-2026']]);
  const unfM = new Map([[2, 'cashmere 12-February-2026'], [4, 46239]]);
  const census = inventoryAudit.soldDateCensus(rows, fmtM, unfM);
  const columns = {
    K: { cellTypes: { date: 3, text: 0, blank: 0 }, shapes: inventoryAudit.dateShapes(['2026-02-24', '2026-07-13', '2026-07-13']) },
    M: { cellTypes: { date: 1, text: 1, blank: 1 }, shapes: inventoryAudit.dateShapes(rows.map((r) => fmtM.get(r.rowIndex))) },
  };
  const lines = buildReport({ rows, findings, census, columns, minYards: 40 });
  assert.ok(Array.isArray(lines) && lines.every((l) => typeof l === 'string'));
  const text = lines.join('\n');
  assert.match(text, /READ-ONLY — 3 row\(s\) read from Inventory \(no sheet cell is written\)/);
  assert.match(text, /Column K DateReceived — cell type: date 3 · text 0 · blank 0/);
  assert.match(text, /shapes: iso 3/);
  assert.match(text, /Column M SoldDate — cell type: date 1 · text 1 · blank 1/);
  assert.match(text, /shapes: day-monthname-year 1 · text-with-word-prefix 1 · blank 1/);
  assert.match(text, /e\.g\. text-with-word-prefix: "cashmere 12-February-2026"/);
  assert.match(text, /1\. Sold rows the bot cannot date \(C9\): 1/);
  assert.match(text, /row 2 · 44200\/6151 #1 · madam oshodi · "cashmere 12-February-2026"/);
  assert.match(text, /2\. Duplicate bale_uids \(C10\): 1/);
  assert.match(text, /BAL-1 → rows 3, 4/);
  assert.match(text, /3\. Shade spelling variants inside a design \(C11\): 1/);
  assert.match(text, /77014 · "4-5\." \(1\) vs "4-5" \(1\)/);
  assert.match(text, /4\. Designs with blank shades: 0 design\(s\) \/ 0 row\(s\)/);
  assert.match(text, /5\. Legacy rows \(no bale_uid — do NOT sort or insert rows until the backfill runs\): 1/);
  assert.match(text, /6\. Oversize thans \(≥ 40 yd\): 1/);
  assert.match(text, /row 3 · 77014\/6061 \(SA\/2521, Jul26\) #3 · 60 yd · available @ IDUMOTA/);
  assert.match(text, /7\. Sold rows at zero price: 1 row\(s\) in 1 sale group\(s\)/);
  assert.match(text, /44200\/6151 · madam oshodi · cashmere 12-February-2026 · 1 row\(s\)/);
  assert.match(text, /8\. Customer spelling clusters \(CANDIDATES only — nothing is merged\): 1/);
  assert.match(text, /"madam oshodi" \(1; Lagos\) · "oshodi madam" \(1; IDUMOTA\) — same words, different order/);
  assert.match(text, /9\. Sold-date census: 2 sold row\(s\) — date cells 1 · text cells 1 · unreadable 1/);
  assert.match(text, /10\. Blank rates \(field blank\/total, non-zero only\): .*baleUid 1\/3/);
});

test('buildReport caps each list at five examples and says how many more are in the JSON', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    rowIndex: 2 + i, packageNo: String(100 + i), design: '9037', shade: '1', thanNo: 1, yards: 60,
    status: 'available', warehouse: 'Lagos', pricePerYard: 1, soldTo: '', soldDate: '', baleUid: `BAL-${i}`, _legacy: false,
  }));
  const findings = inventoryAudit.audit(rows);
  const columns = {
    K: { cellTypes: { date: 8, text: 0, blank: 0 }, shapes: inventoryAudit.dateShapes([]) },
    M: { cellTypes: { date: 0, text: 0, blank: 8 }, shapes: inventoryAudit.dateShapes([]) },
  };
  const text = buildReport({ rows, findings, census: [], columns, minYards: 40 }).join('\n');
  assert.match(text, /6\. Oversize thans \(≥ 40 yd\): 8/);
  assert.equal((text.match(/ yd · available @ Lagos/g) || []).length, 5, 'five examples');
  assert.match(text, /…and 3 more \(see the JSON\)/);
});

test('OUT_FILES names the ten lists the one-offs consume', () => {
  assert.equal(OUT_FILES.length, 10);
  for (const f of ['sold-dates.json', 'oversize-thans.json', 'customer-clusters.json', 'shade-variants.json',
    'blank-shades.json', 'duplicate-uids.json', 'legacy-rows.json', 'zero-price-sold.json', 'blank-rates.json', 'date-shapes.json']) {
    assert.ok(OUT_FILES.includes(f), f);
  }
});
