/**
 * WAU-3 — pure string parsers for blind stock-count entry.
 *
 * House pattern (see quickAddParser): pure functions in src/utils/,
 * `{ok:true, ...fields}` / `{ok:false, error}` results, never throw, no
 * controller imports — the smoke harness exercises them standalone.
 */

'use strict';

/**
 * Parse a count like `12` (bales only) or `12+5` (bales + loose bundles).
 * Zero is allowed on either side (`0+3`, `12+0`, `0`).
 *
 * @param {string} raw
 * @returns {{ok:true, bales:number, bundles:number} | {ok:false, error:string}}
 */
function parseCount(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!s) return { ok: false, error: 'Empty count.' };
  const m = s.match(/^(\d{1,4})(?:\+(\d{1,4}))?$/);
  if (!m) return { ok: false, error: `"${raw}" is not a count — use 12 or 12+5 (bales+bundles).` };
  return { ok: true, bales: Number(m[1]), bundles: m[2] === undefined ? 0 : Number(m[2]) };
}

/**
 * Parse an offline AUDIT batch message:
 *
 *   AUDIT Kano Office
 *   9032 = 12+5
 *   77016 = 8
 *   44200 =            ← blank value = not counted, skipped
 *
 * Lines tolerate a missing '=' (`9032 12+5`). The warehouse is matched
 * case-insensitively against knownWarehouses.
 *
 * @param {string} text
 * @param {string[]} knownWarehouses
 * @returns {{ok:true, warehouse:string, entries:Array<{design:string,bales:number,bundles:number}>, skipped:string[], errors:string[]}
 *         | {ok:false, error:string}}
 */
function parseAuditBatch(text, knownWarehouses) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: 'Empty message.' };
  const head = lines[0].match(/^AUDIT\s+(.+)$/i);
  if (!head) return { ok: false, error: 'First line must be: AUDIT <warehouse>' };
  const wanted = head[1].trim().toLowerCase();
  const warehouse = (knownWarehouses || []).find((w) => String(w).trim().toLowerCase() === wanted);
  if (!warehouse) {
    return { ok: false, error: `Unknown warehouse "${head[1].trim()}". Keep the first line exactly as it was in the count sheet.` };
  }
  const entries = [];
  const skipped = [];
  const errors = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^(\S+)\s*=?\s*(.*)$/);
    if (!m) { errors.push(`Unreadable line: "${line}"`); continue; }
    const design = m[1];
    const value = m[2].trim();
    if (!value) { skipped.push(design); continue; }
    const count = parseCount(value);
    if (!count.ok) { errors.push(`${design}: ${count.error}`); continue; }
    entries.push({ design, bales: count.bales, bundles: count.bundles });
  }
  return { ok: true, warehouse, entries, skipped, errors };
}

module.exports = { parseCount, parseAuditBatch };
