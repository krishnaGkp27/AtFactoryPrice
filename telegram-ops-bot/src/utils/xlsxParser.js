/**
 * XLSX parser used by Bulk Receive Goods (P2.5).
 *
 * Thin wrapper around SheetJS (`xlsx` npm package) that converts the first
 * sheet of a workbook into the same `{ ok, headers, rows }` shape as
 * `csvParser`. Downstream code stays parser-agnostic.
 *
 * Why first-sheet-only:
 *   - Abdul will paste packaging slips into a single tab. Supporting tab
 *     selection adds UI surface (sheet picker) without business value for
 *     v1; we can add it in v1.1 if a real need turns up.
 *
 * Numeric cells (e.g. Yards = 50) are normalised to strings here so the
 * validator's `parseFloat` path runs uniformly regardless of upstream type.
 */

'use strict';

let XLSX = null;
try { XLSX = require('xlsx'); } catch (_) { /* dependency probed at parse time */ }

/**
 * Parse an XLSX buffer.
 * @param {Buffer} buffer
 * @returns {{ ok: true, headers: string[], rows: Array<object> } | { ok: false, error: string }}
 */
function parseXlsx(buffer) {
  if (!XLSX) {
    return { ok: false, error: 'XLSX support not installed — install the `xlsx` package.' };
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { ok: false, error: 'Empty file.' };
  }

  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch (e) {
    return { ok: false, error: `Could not parse XLSX: ${e.message}` };
  }

  const firstName = wb.SheetNames && wb.SheetNames[0];
  if (!firstName) return { ok: false, error: 'Workbook has no sheets.' };

  const sheet = wb.Sheets[firstName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (!aoa.length) return { ok: false, error: `Sheet "${firstName}" is empty.` };
  if (aoa.length < 2) return { ok: false, error: `Sheet "${firstName}" has a header but no data rows.` };

  const headers = (aoa[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  if (!headers.some((h) => h.length)) {
    return { ok: false, error: `No headers found in sheet "${firstName}".` };
  }

  const rows = [];
  for (let i = 1; i < aoa.length; i += 1) {
    const cells = aoa[i] || [];
    const allEmpty = cells.every((c) => c == null || String(c).trim() === '');
    if (allEmpty) continue;
    const row = { _rowNum: i + 1 };
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c];
      if (!key) continue;
      row[key] = (cells[c] != null ? cells[c] : '').toString().trim();
    }
    rows.push(row);
  }
  return { ok: true, headers, rows, sheetName: firstName };
}

/** True when the `xlsx` package was found at require time. */
function isAvailable() { return !!XLSX; }

module.exports = { parseXlsx, isAvailable };
