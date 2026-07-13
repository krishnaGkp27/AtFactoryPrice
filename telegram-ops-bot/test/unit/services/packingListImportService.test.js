'use strict';

/**
 * PL-1 — packing-list detection + transform (specs/PL-1_PACKING_LIST_UPLOAD.md).
 * Builds a synthetic supplier workbook in-memory (no fixtures, no creds).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const plImport = require('../../../src/services/packingListImportService');

function syntheticWorkbook() {
  const aoa = [
    [null, null, null, null, null, 'DETAIL PACKING LIST'],
    ['Exporter/Shipper/Beneficiary'],
    ['SAMYAK SYNTHETICS PVT LTD'],
    [], [], [],
    // two-row table header (row 6 + 7)
    ['S.', 'Carton ', 'BALE', null, 'CS', null, null, null, 'No of', 'No of', 'THAN'],
    ['No.', ' No.', 'NO', 'INDENT ', 'No.', 'LOT/DGN. ', 'QUALITY', 'SHADE', 'COL', 'THAN', 1, 2, 3, 4, 5, 6, 7, 'Yards'],
    // data rows: [S, carton, bale, indent, cs, design, quality, shade, cols, thans, t1..t7, netYards]
    [1, 736, null, 'SA/2521', 1, '9059-C', null, '', 6, 3, 30, 30, 30, null, null, null, null, 90],
    [2, 737, null, 'SA/2521', 2, 44200, null, 'BLACK', 5, 3, 20, 21, 30, null, null, null, null, 71],
    // than-count clerical error: declares 3, lists 2 (cells trusted)
    [3, 738, null, 'SA/2522', 3, 44200, null, 'BLUE', 5, 3, 25, 25, null, null, null, null, null, 50],
    // duplicate carton (second 737) — skipped after first
    [4, 737, null, 'SA/2521', 4, 44200, null, 'BLACK', 5, 1, 30, null, null, null, null, null, null, 30],
    // shipment sample — excluded
    [5, 1006, null, 'ZSHIPMENT', 5, 'NOT FOR SALE', null, null, 0, 0, null, null, null, null, null, null, null, 200],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'PACKING LIST');
  // decoy sheet to prove detect() scans all sheets
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['INVOICE', 'just numbers']]), 'INVOICE');
  return wb;
}

test('detect finds the packing-list sheet + header row across sheets', () => {
  const d = plImport.detect(syntheticWorkbook());
  assert.ok(d, 'expected detection');
  assert.equal(d.sheetName, 'PACKING LIST');
  assert.equal(d.headerRow, 6);
});

test('detect returns null for a plain table workbook', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['PackageNo', 'ThanNo', 'Design', 'Yards'], ['1', '1', 'D1', '30'],
  ]), 'Sheet1');
  assert.equal(plImport.detect(wb), null);
});

test('transform: than explosion, exclusions, corrections, supplier', () => {
  const { thans, summary, supplier } = plImport.transform(plImport.detect(syntheticWorkbook()));

  assert.equal(supplier, 'SAMYAK SYNTHETICS PVT LTD');
  // 736 → 3 thans, 737 → 3 thans, 738 → 2 thans (cells trusted); dup 737 + ZSHIPMENT dropped
  assert.equal(summary.bales, 3);
  assert.equal(thans.length, 8);
  assert.equal(summary.yards, 90 + 71 + 50);
  assert.deepEqual(summary.dupCartons, ['737']);
  assert.equal(summary.excluded.length, 1);
  assert.equal(summary.excluded[0].carton, '1006');
  assert.deepEqual(summary.thanCountFix, [{ carton: '738', declared: 3, actual: 2 }]);
  assert.deepEqual(summary.indents.sort(), ['SA/2521', 'SA/2522']);

  const t736 = thans.filter((t) => t.packageNo === '736');
  assert.deepEqual(t736.map((t) => t.thanNo), [1, 2, 3]);
  assert.equal(t736[0].design, '9059-C');
  assert.equal(t736[0].indent, 'SA/2521');
  assert.equal(t736[0].csNo, '1');
  const t737 = thans.filter((t) => t.packageNo === '737');
  assert.equal(t737[0].shade, 'BLACK');
  assert.equal(t737[1].yards, 21);
});
