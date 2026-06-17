'use strict';

/**
 * Unit suite for src/utils/formatDate.js — DD-MMM-YYYY display formatter.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fmtDate = require('../../../src/utils/formatDate');

test('fmtDate()', async (t) => {
  await t.test('formats ISO YYYY-MM-DD as DD-MMM-YYYY', () => {
    assert.equal(fmtDate('2026-03-26'), '26-Mar-2026');
  });

  await t.test('formats DMY input', () => {
    assert.equal(fmtDate('26-03-2026'), '26-Mar-2026');
  });

  await t.test('zero-pads the day', () => {
    assert.equal(fmtDate('2026-03-05'), '05-Mar-2026');
  });

  await t.test('returns an em dash for empty input', () => {
    assert.equal(fmtDate(''), '—');
    assert.equal(fmtDate(null), '—');
  });

  await t.test('returns the original string when unparseable', () => {
    assert.equal(fmtDate('not a date'), 'not a date');
  });
});
