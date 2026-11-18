'use strict';

/**
 * PL-2 — builds docs/PACKING_LIST_TEMPLATE.xlsx: an EMPTY supplier "DETAIL
 * PACKING LIST" in the exact layout the bot reads, for typing a container
 * in by hand (owner, 18-Nov-2026: "I want supplier packing list format to
 * make manual entry").
 *
 * The layout is not invented here — it is the one
 * src/services/packingListImportService.js detects (PL-1): a two-row table
 * header whose first row reads `S. | Carton | BALE …`, then ONE ROW PER
 * BALE with the yards of each than in THAN 1..7. The filled file goes into
 * Inventory → 📥 Add Stock → 📦 Add Stock (CSV) unchanged.
 *
 * Sheet 1 `PACKING LIST` is the form: header rows 5–6, data from row 7, the
 * S. No. column already numbered (the reader drops a row whose S. No. is
 * blank — the one slip a hand entry makes silently).
 * Sheet 2 `HOW TO FILL` is the guide. Every row there starts one column to
 * the right, so the reader can never mistake it for a packing list.
 *
 * Offline, zero credentials. Usage:
 *   node scripts/build-packing-list-template.js            # writes docs/PACKING_LIST_TEMPLATE.xlsx
 *   node scripts/build-packing-list-template.js --out <path>
 */

const path = require('path');
const XLSX = require('xlsx');

const DEFAULT_OUT = path.join(__dirname, '..', 'docs', 'PACKING_LIST_TEMPLATE.xlsx');
const FORM_SHEET = 'PACKING LIST';
const GUIDE_SHEET = 'HOW TO FILL';
/** Rows 5 and 6 of the form (1-based); data starts on row 7. */
const HEADER_ROW_INDEX = 4;
const SERIALS = 1000;

const HEADER_1 = ['S.', 'Carton', 'BALE', null, 'CS', null, null, null, 'No of', 'No of', 'THAN', null, null, null, null, null, null, 'Net'];
const HEADER_2 = ['No.', 'No.', 'NO', 'INDENT', 'No.', 'LOT/DGN.', 'QUALITY', 'SHADE', 'COL', 'THAN', 1, 2, 3, 4, 5, 6, 7, 'Yards'];

/** The form: letterhead, the two header rows, then numbered empty rows. */
function formRows() {
  const rows = [
    [null, null, null, null, null, 'DETAIL PACKING LIST'],
    ['Exporter/Shipper/Beneficiary'],
    [null], // A3 — the supplier's name (optional)
    [],
    HEADER_1,
    HEADER_2,
  ];
  for (let i = 1; i <= SERIALS; i++) rows.push([i]);
  return rows;
}

/** One guide line: shifted one column right so it is never read as a list. */
const g = (...cells) => [null, ...cells];

function guideRows() {
  return [
    g('HOW TO FILL THE PACKING LIST'),
    [],
    g('Fill the sheet named PACKING LIST. One row = one bale. Start on row 7.'),
    g('Do not move, rename or delete header rows 5 and 6. Do not insert or delete columns.'),
    [],
    g('Column', 'Header', 'What to type', 'Needed?'),
    g('A', 'S. No.', 'Already numbered. Leave it. A row with no S. No. is not read.', 'yes'),
    g('B', 'Carton No.', 'The bale number printed on the bale.', 'yes'),
    g('C', 'BALE NO', 'Leave blank. The bot does not read it.', 'no'),
    g('D', 'INDENT', 'Supplier indent number, for example SA/2521.', 'optional'),
    g('E', 'CS No.', 'Packing-list serial of the bale.', 'optional'),
    g('F', 'LOT/DGN.', 'Design number, spelled as the Inventory sheet spells it.', 'yes'),
    g('G', 'QUALITY', 'Leave blank. The bot does not read it.', 'no'),
    g('H', 'SHADE', 'Shade, spelled as that design already uses.', 'optional'),
    g('I', 'No of COL', 'Leave blank. The bot does not read it.', 'no'),
    g('J', 'No of THAN', 'How many thans are in the bale. A self-check: the bot counts the yard cells.', 'optional'),
    g('K to Q', 'THAN 1 to 7', 'Yards of each than, one cell per than, from the left. Numbers only.', 'yes, at least one'),
    g('R', 'Net Yards', 'Total yards of the bale. A self-check: the bot adds the yard cells.', 'optional'),
    [],
    g('Example. A bale of five thans, a bale of three thans, a bale of one than:'),
    g(...HEADER_1),
    g(...HEADER_2),
    g(1, 1201, null, 'SA/2521', 1, 9006, null, 3, null, 5, 30, 30, 30, 30, 30, null, null, 150),
    g(2, 1202, null, 'SA/2521', 2, 9006, null, 4, null, 3, 30, 28.5, 30, null, null, null, null, 88.5),
    g(3, 1203, null, 'SA/2522', 3, '9037-D', null, 1, null, 1, 42, null, null, null, null, null, null, 42),
    [],
    g('What the bot does with it'),
    g('• Each yard cell becomes one than: THAN 1 is than 1, THAN 2 is than 2, and so on.'),
    g('• The yard cells are trusted. If J or R disagrees, the summary says so and the cells are used.'),
    g('• A bale number may appear once. A second row with the same number is skipped and named.'),
    g('• A bale with no yards in K to Q is skipped and named.'),
    g('• A row whose INDENT is ZSHIPMENT, or whose design says NOT FOR SALE, is left out.'),
    g('• A bale number that is still live in the same store blocks the whole file. Nothing is added.'),
    g('• More than seven thans in one bale do not fit this form. Use the CSV form for that bale:'),
    g('  columns PackageNo, ThanNo, Design, Yards (optional Shade), one row per than.'),
    g('• Price is not on this list. Set it afterwards with Update Price.'),
    [],
    g('How to upload'),
    g('1. Save this file as .xlsx.'),
    g('2. In the bot: Inventory, Add Stock, Add Stock (CSV). Pick the store.'),
    g('3. Send the file as a document.'),
    g('4. Read the summary: bales, thans, yards, designs, warnings.'),
    g('5. Pick the container label, or type a new one (three-letter month and two-digit year, for example Nov26).'),
    g('6. Submit. A second admin approves, then the stock is in the Inventory sheet.'),
  ];
}

/** Build the workbook in memory. Pure: nothing is read or written. */
function buildWorkbook() {
  const wb = XLSX.utils.book_new();

  const form = XLSX.utils.aoa_to_sheet(formRows());
  form['!cols'] = [6, 10, 8, 12, 6, 12, 10, 10, 7, 8, 7, 7, 7, 7, 7, 7, 7, 10].map((wch) => ({ wch }));
  // THAN spans its seven yard columns (K5:Q5), as on the supplier's list.
  form['!merges'] = [{ s: { r: HEADER_ROW_INDEX, c: 10 }, e: { r: HEADER_ROW_INDEX, c: 16 } }];
  XLSX.utils.book_append_sheet(wb, form, FORM_SHEET);

  const guide = XLSX.utils.aoa_to_sheet(guideRows());
  guide['!cols'] = [2, 9, 12, 70, 18, 6, 10, 9, 8, 7, 8, 7, 7, 7, 7, 7, 7, 7, 9].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(wb, guide, GUIDE_SHEET);

  return wb;
}

function main() {
  const i = process.argv.indexOf('--out');
  const out = i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : DEFAULT_OUT;
  XLSX.writeFile(buildWorkbook(), out);
  console.log(`Wrote ${out}`);
}

if (require.main === module) main();

module.exports = { buildWorkbook, FORM_SHEET, GUIDE_SHEET, HEADER_ROW_INDEX, SERIALS, DEFAULT_OUT };
