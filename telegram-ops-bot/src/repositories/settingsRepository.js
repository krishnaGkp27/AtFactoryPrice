/**
 * Data access for Settings sheet (key-value for risk thresholds, etc.).
 * Columns: Key | Value | UpdatedAt
 * Used by Admin page and Risk Engine.
 */

const sheets = require('./sheetsClient');

const SHEET = 'Settings';
const HEADERS = ['Key', 'Value', 'UpdatedAt'];

const DEFAULTS = {
  RISK_THRESHOLD: 300,
  LOW_STOCK_THRESHOLD: 100,
};

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:C1');
  if (!rows.length || rows[0].length < 3) {
    await sheets.updateRange(SHEET, 'A1:C1', [HEADERS]);
  }
}

async function getAll() {
  try {
    const rows = await sheets.readRange(SHEET, 'A2:C');
    const map = { ...DEFAULTS };
    rows.forEach((r) => {
      const k = (r[0] || '').toString().trim();
      const v = (r[1] || '').toString().trim();
      if (k) map[k] = isNaN(Number(v)) ? v : Number(v);
    });
    return map;
  } catch (e) {
    return { ...DEFAULTS };
  }
}

async function set(key, value) {
  await ensureHeader();
  const rows = await sheets.readRange(SHEET, 'A2:C');
  const idx = rows.findIndex((r) => (r[0] || '').toString().trim() === key);
  const updatedAt = new Date().toISOString();
  const valueStr = String(value);
  if (idx >= 0) {
    const rowIndex = idx + 2;
    await sheets.updateRange(SHEET, `B${rowIndex}:C${rowIndex}`, [[valueStr, updatedAt]]);
  } else {
    await sheets.appendRows(SHEET, [[key, valueStr, updatedAt]]);
  }
  return { key, value: isNaN(Number(value)) ? value : Number(value), updatedAt };
}

module.exports = { getAll, set, ensureHeader, DEFAULTS };
