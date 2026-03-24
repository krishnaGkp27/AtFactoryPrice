/**
 * Google Sheets API client. Uses service account credentials from config.
 * All API calls include retry with exponential backoff for quota/rate-limit errors.
 */

const { google } = require('googleapis');
const config = require('../config');
const logger = require('../utils/logger');

let sheets = null;
let auth = null;

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

function isRetryableError(err) {
  const code = err?.code || err?.response?.status || err?.status;
  if (code === 429 || code === 503) return true;
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('quota') || msg.includes('rate limit') || msg.includes('too many requests');
}

async function withRetry(fn, label = 'sheets') {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
        logger.warn(`[${label}] Quota/rate error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${Math.round(delay)}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

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
  return withRetry(async () => {
    const res = await s.spreadsheets.values.get({
      spreadsheetId: spreadsheetId(),
      range: `${sheetName}!${range}`,
    });
    return res.data.values || [];
  }, `readRange(${sheetName})`);
}

async function appendRows(sheetName, rows) {
  const s = await getSheets();
  return withRetry(async () => {
    await s.spreadsheets.values.append({
      spreadsheetId: spreadsheetId(),
      range: `${sheetName}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
  }, `appendRows(${sheetName})`);
}

async function updateRange(sheetName, range, values) {
  const s = await getSheets();
  return withRetry(async () => {
    await s.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `${sheetName}!${range}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  }, `updateRange(${sheetName})`);
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
  return withRetry(async () => {
    const res = await s.spreadsheets.get({ spreadsheetId: spreadsheetId(), fields: 'sheets.properties.title' });
    return (res.data.sheets || []).map((s) => s.properties.title);
  }, 'getSheetNames');
}

async function batchUpdateRanges(sheetName, updates) {
  const s = await getSheets();
  const data = updates.map((u) => ({
    range: `${sheetName}!${u.range}`,
    values: u.values,
  }));
  return withRetry(async () => {
    await s.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
  }, `batchUpdate(${sheetName})`);
}

async function addSheet(title) {
  const s = await getSheets();
  return withRetry(async () => {
    await s.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }, `addSheet(${title})`);
}

module.exports = {
  getSheets,
  spreadsheetId,
  readRange,
  appendRows,
  updateRange,
  findRowIndex,
  batchUpdateRanges,
  getSheetNames,
  addSheet,
};
