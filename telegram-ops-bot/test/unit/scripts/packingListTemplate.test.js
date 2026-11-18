'use strict';

/**
 * PL-2 — the hand-entry packing list template (owner, 18-Nov-2026: "I want
 * supplier packing list format to make manual entry").
 *
 * The template is only useful if the bot's OWN reader accepts it, so every
 * check here runs through src/services/packingListImportService — the code
 * the 📦 Add Stock door uses. If that reader's layout ever changes, this
 * file fails and the template is rebuilt
 * (`node scripts/build-packing-list-template.js`).
 *
 * In memory and on the committed file. No sheet, no Telegram, no credentials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const XLSX = require('xlsx');

const plImport = require('../../../src/services/packingListImportService');
const builder = require('../../../scripts/build-packing-list-template');

/** Type bales into the form the way a person would: by cell, from row 7. */
function fill(wb, bales) {
  const ws = wb.Sheets[builder.FORM_SHEET];
  bales.forEach((b, i) => {
    const r = builder.HEADER_ROW_INDEX + 2 + i; // 0-based row of the i-th data row
    const put = (c, v) => { if (v != null) ws[XLSX.utils.encode_cell({ r, c })] = { t: typeof v === 'number' ? 'n' : 's', v }; };
    put(1, b.bale); put(3, b.indent); put(4, b.cs); put(5, b.design); put(7, b.shade);
    put(9, b.thans.length);
    b.thans.forEach((y, k) => put(10 + k, y));
    put(17, b.thans.reduce((s, y) => s + y, 0));
  });
  return wb;
}
/** Through a real .xlsx byte round trip, as an uploaded file arrives. */
const roundTrip = (wb) => XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });

test('the empty template is recognised as a packing list: the form sheet, header on row 5', () => {
  const d = plImport.detect(roundTrip(builder.buildWorkbook()));
  assert.ok(d, 'the bot\'s reader accepts the layout');
  assert.equal(d.sheetName, 'PACKING LIST');
  assert.equal(d.headerRow, 4, 'row 5 on the sheet');
});

test('an empty template adds nothing — the numbered S. No. column alone is not a bale', () => {
  const { thans, summary } = plImport.transform(plImport.detect(roundTrip(builder.buildWorkbook())));
  assert.equal(thans.length, 0);
  assert.equal(summary.bales, 0);
  assert.deepEqual([summary.dupCartons, summary.noYardCells, summary.thanCountFix, summary.yardMismatch, summary.excluded],
    [[], [], [], [], []], 'and nothing is reported');
});

test('bales typed from row 7 become one than per yard cell, with indent, CS, design and shade carried', () => {
  const wb = fill(builder.buildWorkbook(), [
    { bale: 1201, indent: 'SA/2521', cs: 1, design: 9006, shade: 3, thans: [30, 30, 30, 30, 30] },
    { bale: 1202, indent: 'SA/2521', cs: 2, design: 9006, shade: 4, thans: [30, 28.5, 30] },
    { bale: 1203, indent: 'SA/2522', cs: 3, design: '9037-D', shade: 1, thans: [42] },
  ]);
  const { thans, summary } = plImport.transform(plImport.detect(roundTrip(wb)));

  assert.equal(summary.bales, 3);
  assert.equal(thans.length, 9);
  assert.equal(summary.yards, 150 + 88.5 + 42);
  assert.deepEqual(summary.designs.sort(), ['9006', '9037-D']);
  assert.deepEqual(summary.indents.sort(), ['SA/2521', 'SA/2522']);
  assert.deepEqual([summary.dupCartons, summary.noYardCells, summary.thanCountFix, summary.yardMismatch],
    [[], [], [], []], 'a correctly filled form raises no warning');

  assert.deepEqual(thans.filter((t) => t.packageNo === '1202'), [
    { packageNo: '1202', thanNo: 1, design: '9006', shade: '4', yards: 30, indent: 'SA/2521', csNo: '2' },
    { packageNo: '1202', thanNo: 2, design: '9006', shade: '4', yards: 28.5, indent: 'SA/2521', csNo: '2' },
    { packageNo: '1202', thanNo: 3, design: '9006', shade: '4', yards: 30, indent: 'SA/2521', csNo: '2' },
  ]);
  assert.deepEqual(thans.filter((t) => t.packageNo === '1203').map((t) => [t.thanNo, t.yards, t.design]), [[1, 42, '9037-D']]);
});

test('seven thans fit; the form holds a thousand numbered rows', () => {
  const wb = fill(builder.buildWorkbook(), [{ bale: 1300, design: 9006, shade: 1, thans: [30, 30, 30, 30, 30, 30, 30] }]);
  const { thans } = plImport.transform(plImport.detect(roundTrip(wb)));
  assert.deepEqual(thans.map((t) => t.thanNo), [1, 2, 3, 4, 5, 6, 7]);

  const rows = XLSX.utils.sheet_to_json(builder.buildWorkbook().Sheets[builder.FORM_SHEET], { header: 1, defval: null });
  assert.equal(rows[builder.HEADER_ROW_INDEX + 2][0], 1, 'row 7 is S. No. 1');
  assert.equal(rows[builder.HEADER_ROW_INDEX + 1 + builder.SERIALS][0], builder.SERIALS);
  assert.equal(builder.SERIALS, 1000);
});

test('the guide sheet can never be read as a packing list — alone, or placed first', () => {
  const full = builder.buildWorkbook();
  // alone
  const only = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(only, full.Sheets[builder.GUIDE_SHEET], builder.GUIDE_SHEET);
  assert.equal(plImport.detect(roundTrip(only)), null, 'its example rows start one column to the right');
  // dragged in front of the form by hand
  const swapped = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(swapped, full.Sheets[builder.GUIDE_SHEET], builder.GUIDE_SHEET);
  XLSX.utils.book_append_sheet(swapped, full.Sheets[builder.FORM_SHEET], builder.FORM_SHEET);
  assert.equal(plImport.detect(roundTrip(swapped)).sheetName, 'PACKING LIST');
});

test('the guide names every column the reader uses, by the letter the reader uses', () => {
  const { COL } = plImport._internals;
  const letter = (c) => XLSX.utils.encode_col(c);
  const guide = XLSX.utils.sheet_to_json(builder.buildWorkbook().Sheets[builder.GUIDE_SHEET], { header: 1, defval: null });
  const byLetter = new Map(guide.filter((r) => r[1] && r[2] && r[3]).map((r) => [String(r[1]), String(r[2])]));
  assert.equal(byLetter.get(letter(COL.sno)), 'S. No.');
  assert.equal(byLetter.get(letter(COL.carton)), 'Carton No.');
  assert.equal(byLetter.get(letter(COL.indent)), 'INDENT');
  assert.equal(byLetter.get(letter(COL.cs)), 'CS No.');
  assert.equal(byLetter.get(letter(COL.design)), 'LOT/DGN.');
  assert.equal(byLetter.get(letter(COL.shade)), 'SHADE');
  assert.equal(byLetter.get(letter(COL.thans)), 'No of THAN');
  assert.equal(byLetter.get(`${letter(COL.thanStart)} to ${letter(COL.thanEnd)}`), 'THAN 1 to 7');
  assert.equal(byLetter.get(letter(COL.yards)), 'Net Yards');
});

test('the committed file in docs/ is the template the script builds', () => {
  assert.ok(fs.existsSync(builder.DEFAULT_OUT), 'docs/PACKING_LIST_TEMPLATE.xlsx is committed — rebuild with the script');
  const onDisk = XLSX.readFile(builder.DEFAULT_OUT);
  const fresh = roundTrip(builder.buildWorkbook());
  assert.deepEqual(onDisk.SheetNames, fresh.SheetNames);
  for (const name of fresh.SheetNames) {
    assert.deepEqual(
      XLSX.utils.sheet_to_json(onDisk.Sheets[name], { header: 1, defval: null }),
      XLSX.utils.sheet_to_json(fresh.Sheets[name], { header: 1, defval: null }), name);
  }
  const d = plImport.detect(onDisk);
  assert.equal(d.sheetName, 'PACKING LIST');
  assert.equal(plImport.transform(d).thans.length, 0, 'the committed template is empty');
});
