/**
 * Google Sheets API client for the Manufacturing (NYN) spreadsheet.
 * Same API as sheetsClient.js but uses MFG_GOOGLE_SHEET_ID.
 * Falls back to GOOGLE_SHEET_ID if MFG_GOOGLE_SHEET_ID is not set.
 */

const { google } = require('googleapis');
const config = require('../config');

let sheets = null;

async function getSheets() {
  if (sheets) return sheets;
  const creds = config.sheets.credentials;
  const sid = config.sheets.mfgSheetId || config.sheets.sheetId;
  if (!creds || !sid) {
    throw new Error('GOOGLE_CREDENTIALS_JSON and MFG_GOOGLE_SHEET_ID (or GOOGLE_SHEET_ID) must be set');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  sheets = google.sheets({ version: 'v4', auth: authClient });
  return sheets;
}

const spreadsheetId = () => config.sheets.mfgSheetId || config.sheets.sheetId;

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
    if (rows[i][columnIndex] === String(matchValue)) return i + 1;
  }
  return -1;
}

async function getSheetNames() {
  const s = await getSheets();
  const res = await s.spreadsheets.get({ spreadsheetId: spreadsheetId(), fields: 'sheets.properties.title' });
  return (res.data.sheets || []).map((s) => s.properties.title);
}

async function addSheet(title) {
  const s = await getSheets();
  await s.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
}

module.exports = {
  getSheets, spreadsheetId,
  readRange, appendRows, updateRange, findRowIndex,
  getSheetNames, addSheet,
};
