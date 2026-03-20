/**
 * Generic Google Sheets repository for Manufacturing (NYN) spreadsheet.
 * Same API as googleSheetsRepository.js but uses mfgSheetsClient (MFG_GOOGLE_SHEET_ID).
 * All manufacturing repos import this instead of googleSheetsRepository.
 */

const sheets = require('./mfgSheetsClient');

async function readSheet(sheetName, range = 'A:Z') {
  if (!sheetName) throw new Error('sheetName is required');
  return sheets.readRange(sheetName, range);
}

async function appendRow(sheetName, row) {
  if (!sheetName) throw new Error('sheetName is required');
  const rows = Array.isArray(row[0]) ? row : [row];
  await sheets.appendRows(sheetName, rows);
}

async function updateRow(sheetName, range, values) {
  if (!sheetName || !range) throw new Error('sheetName and range are required');
  await sheets.updateRange(sheetName, range, values);
}

async function findRowIndex(sheetName, columnIndex, matchValue) {
  return sheets.findRowIndex(sheetName, columnIndex, matchValue);
}

module.exports = { readSheet, appendRow, updateRow, findRowIndex };
