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

/* ── SEC-FI1: formula-injection guard ──────────────────────────────────────
 * Every write below uses valueInputOption 'USER_ENTERED', which is what makes
 * Sheets type dates and numbers correctly — but it also means a value that
 * STARTS with = + - @ is evaluated as a FORMULA. Free text typed into the bot
 * (customer names, notes, task titles, expense titles, warehouse names) lands
 * in cells verbatim, so "=IMPORTXML(...)" from any allow-listed user would be
 * live in the owner's spreadsheet — corrupting the cell at best, fetching an
 * attacker URL with sheet data at worst (CWE-1236).
 *
 * Nothing in this codebase writes a deliberate formula (verified repo-wide),
 * so neutralising the leading character cannot break a feature. The escape is
 * the leading apostrophe already proven in settingsRepository: Sheets strips
 * it on storage and marks the cell text, so reads come back unchanged.
 */

/** Leading characters Sheets treats as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Neutralise a single cell value if — and only if — it is a string that
 * Sheets would evaluate as a formula.
 *
 * Deliberately NOT touched, so existing data keeps its exact typing:
 *  - non-strings (numbers/booleans/null) — never formulas;
 *  - anything numeric, including "-5" and "+2348012345678" (a phone number
 *    parses as a finite number, so its storage is unchanged);
 *  - values already apostrophe-escaped by a caller (settingsRepository).
 *
 * @param {*} v raw cell value
 * @returns {*} the value, apostrophe-escaped when it would evaluate
 */
function sanitizeCell(v) {
  if (typeof v !== 'string' || !v) return v;
  if (v[0] === "'") return v;
  if (!FORMULA_LEAD.test(v)) return v;
  if (Number.isFinite(Number(v))) return v; // "-5", "+234…" stay numeric
  return `'${v}`;
}

/** Apply {@link sanitizeCell} across a rows-of-cells payload. */
function sanitizeRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => (Array.isArray(row) ? row.map(sanitizeCell) : row));
}

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
      requestBody: { values: sanitizeRows(rows) },
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
      requestBody: { values: sanitizeRows(values) },
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
    values: sanitizeRows(u.values),
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

/**
 * 1-indexed column number → A1-notation column letter (1→A, 26→Z, 27→AA).
 * Canonical home for the helper previously copy-pasted in per-sheet repos
 * and schemaMapper.
 */
function columnLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
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
  columnLetter,
  // Exported for the SEC-FI1 unit tests only — writes are already guarded.
  _internals: { sanitizeCell, sanitizeRows },
};
