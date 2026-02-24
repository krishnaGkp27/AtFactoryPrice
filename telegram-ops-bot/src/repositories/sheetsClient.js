/**
 * Google Sheets API client. Uses service account credentials from config.
 */

const { google } = require('googleapis');
const config = require('../config');

let sheets = null;
let auth = null;

async function getSheets() {
  if (sheets) return sheets;
  const creds = config.sheets.credentials;
  if (!creds || !config.sheets.sheetId) {
    throw new Error('GOOGLE_CREDENTIALS_JSON and GOOGLE_SHEET_ID must be set');
  }
  auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  sheets = google.sheets({ version: 'v4', auth: authClient });
  return sheets;
}

const spreadsheetId = () => config.sheets.sheetId;

async function readRange(sheetName, range) {
  const s = await getSheets();
  const res = await s.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${sheetName}!${range}`,
  });
  return res.data.values || [];
}

async function appendRows(sheetName, rows) {
  const s = await getSheets();
  await s.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${sheetName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

async function updateRange(sheetName, range, values) {
  const s = await getSheets();
  await s.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${sheetName}!${range}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

async function findRowIndex(sheetName, columnIndex, matchValue) {
  const rows = await readRange(sheetName, 'A:Z');
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][columnIndex] === String(matchValue)) return i + 1; // 1-based
  }
  return -1;
}

module.exports = {
  getSheets,
  spreadsheetId,
  readRange,
  appendRows,
  updateRange,
  findRowIndex,
};
