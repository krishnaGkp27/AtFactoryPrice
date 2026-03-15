/**
 * Generic Google Sheets repository — single gateway for all sheet operations.
 * Wraps the existing sheetsClient so business logic never touches the API directly.
 * Use this layer for: readSheet, appendRow, updateRow. Enables future swapping of storage.
 */

const sheets = require('./sheetsClient');

/**
 * Read rows from a sheet.
 * @param {string} sheetName - Name of the sheet tab
 * @param {string} [range='A:Z'] - A1 notation range (e.g. 'A2:K', 'A1:Z')
 * @returns {Promise<Array<Array>>} Array of rows (each row is array of cell values)
 */
async function readSheet(sheetName, range = 'A:Z') {
  if (!sheetName) throw new Error('sheetName is required');
  return sheets.readRange(sheetName, range);
}

/**
 * Append one or more rows to a sheet.
 * @param {string} sheetName - Name of the sheet tab
 * @param {Array<Array>} rows - Array of rows; each row is an array of cell values
 */
async function appendRow(sheetName, row) {
  if (!sheetName) throw new Error('sheetName is required');
  const rows = Array.isArray(row[0]) ? row : [row];
  await sheets.appendRows(sheetName, rows);
}

/**
 * Update a range in a sheet (single cell or block).
 * @param {string} sheetName - Name of the sheet tab
 * @param {string} range - A1 notation (e.g. 'A5', 'B2:D2')
 * @param {Array<Array>} values - 2D array of values to write
 */
async function updateRow(sheetName, range, values) {
  if (!sheetName || !range) throw new Error('sheetName and range are required');
  await sheets.updateRange(sheetName, range, values);
}

/**
 * Find 1-based row index where a column matches a value (for update by key).
 * @param {string} sheetName - Name of the sheet tab
 * @param {number} columnIndex - 0-based column index to match
 * @param {string} matchValue - Value to find
 * @returns {Promise<number>} 1-based row index or -1
 */
async function findRowIndex(sheetName, columnIndex, matchValue) {
  return sheets.findRowIndex(sheetName, columnIndex, matchValue);
}

module.exports = {
  readSheet,
  appendRow,
  updateRow,
  findRowIndex,
};
