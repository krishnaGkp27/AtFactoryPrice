/**
 * CSV parser used by Bulk Receive Goods (P2.5).
 *
 * Returns the parsed rows as objects keyed by lowercased header names so
 * downstream code can read `row.packageno` regardless of whether Abdul
 * typed "PackageNo", "packageno" or "Package No" in the header.
 *
 * Quoted fields with embedded commas (`"Lagos, Apapa"`), escaped quotes
 * (`""`) and CRLF/LF line endings are supported. A leading UTF-8 BOM is
 * stripped (Excel inserts one when saving as CSV from a Windows machine).
 *
 * Zero npm dependencies — keeps the smoke harness pure and the parser
 * deployable to any Node runtime without an extra build step.
 */

'use strict';

/**
 * Parse a CSV string.
 * @param {string} text
 * @returns {{ ok: true, headers: string[], rows: Array<object> } | { ok: false, error: string }}
 */
function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'Empty file.' };
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const lines = splitCsvLines(text);
  if (!lines.length) return { ok: false, error: 'No rows found.' };
  if (lines.length < 2) return { ok: false, error: 'File has a header but no data rows.' };

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  if (!headers.some((h) => h.length)) {
    return { ok: false, error: 'No headers found.' };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const row = { _rowNum: i + 1 };
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c];
      if (!key) continue;
      row[key] = (cells[c] != null ? cells[c] : '').toString().trim();
    }
    rows.push(row);
  }
  return { ok: true, headers, rows };
}

/**
 * Split CSV text into logical lines, respecting multi-line quoted cells.
 * Most real-world inventory CSVs won't have newlines inside cells, but a
 * single "Notes" cell with a line break shouldn't break the whole import.
 */
function splitCsvLines(text) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuote && text[i + 1] === '"') { cur += '""'; i += 1; continue; }
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (!inQuote && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; continue; }
        inQuote = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === ',') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

module.exports = { parseCsv };
