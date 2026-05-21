'use strict';

/**
 * forexRatesRepository — sole owner of the ForexRates sheet.
 *
 * Columns: date | base | quote | rate | source | entered_by | entered_at | notes
 *
 * The manual forex provider reads `findOnOrBefore(date)`; admin /
 * finance writes new rows via `append()` (wired into the admin Forex
 * Rates flow in a follow-up commit).
 */

const sheets = require('./sheetsClient');

const SHEET = 'ForexRates';

function _parseRow(r) {
  if (!r || r.length < 4) return null;
  const rate = parseFloat(r[3]);
  if (!isFinite(rate) || rate <= 0) return null;
  return {
    date:        String(r[0] || '').trim(),
    base:        String(r[1] || '').trim().toUpperCase(),
    quote:       String(r[2] || '').trim().toUpperCase(),
    rate,
    source:      String(r[4] || '').trim(),
    entered_by:  String(r[5] || '').trim(),
    entered_at:  String(r[6] || '').trim(),
    notes:       String(r[7] || '').trim(),
  };
}

async function findAll() {
  const rows = await sheets.readRange(SHEET, 'A2:H');
  return (rows || []).map(_parseRow).filter(Boolean);
}

/**
 * Returns rates whose `date` is on or before `cutoff` (YYYY-MM-DD),
 * sorted DESCENDING by date so the FIRST match per (base,quote) is
 * the most recent. Lexical compare works because ISO dates sort
 * correctly as strings.
 */
async function findOnOrBefore(cutoff) {
  const all = await findAll();
  const c = String(cutoff || '').trim();
  return all
    .filter((r) => !c || r.date <= c)
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
}

async function append({ date, base, quote, rate, source, entered_by, notes = '' }) {
  const row = [
    date, String(base).toUpperCase(), String(quote).toUpperCase(),
    String(rate),
    source || 'admin', entered_by || '',
    new Date().toISOString(),
    notes || '',
  ];
  await sheets.appendRows(SHEET, [row]);
  return _parseRow(row);
}

module.exports = { findAll, findOnOrBefore, append, _parseRow };
