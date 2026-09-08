'use strict';

/**
 * Unit suite for src/utils/dates.js — Lagos-day helpers + sales-date
 * normalisation. Deterministic: relative checks use the module's own
 * todayInLagos() rather than hard-coding a calendar day.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const dates = require('../../../src/utils/dates');

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

test('todayInLagos()', () => {
  assert.match(dates.todayInLagos(), ISO_RE);
});

test('compareWithToday()', async (t) => {
  await t.test('0 for today', () => {
    assert.equal(dates.compareWithToday(dates.todayInLagos()), 0);
  });

  await t.test('-1 for a past date', () => {
    assert.equal(dates.compareWithToday('2000-01-01'), -1);
  });

  await t.test('+1 for a future date', () => {
    assert.equal(dates.compareWithToday('2999-01-01'), 1);
  });

  await t.test('NaN for invalid input', () => {
    assert.ok(Number.isNaN(dates.compareWithToday('not-a-date')));
    assert.ok(Number.isNaN(dates.compareWithToday(null)));
  });
});

test('daysBeforeToday()', async (t) => {
  await t.test('positive for a past date', () => {
    assert.ok(dates.daysBeforeToday('2000-01-01') > 0);
  });

  await t.test('0 for a future date', () => {
    assert.equal(dates.daysBeforeToday('2999-01-01'), 0);
  });

  await t.test('0 for invalid input', () => {
    assert.equal(dates.daysBeforeToday('garbage'), 0);
  });
});

test('normalizeSalesDate()', async (t) => {
  await t.test('passes through ISO YYYY-MM-DD', () => {
    assert.equal(dates.normalizeSalesDate('2026-04-07'), '2026-04-07');
    assert.equal(dates.normalizeSalesDate('2026/04/07'), '2026-04-07');
  });

  await t.test('interprets DMY numeric (never MDY)', () => {
    assert.equal(dates.normalizeSalesDate('07-04-2026'), '2026-04-07');
    assert.equal(dates.normalizeSalesDate('7/4/2026'), '2026-04-07');
    assert.equal(dates.normalizeSalesDate('07.04.2026'), '2026-04-07');
  });

  await t.test('parses DMY with month name', () => {
    assert.equal(dates.normalizeSalesDate('7 April 2026'), '2026-04-07');
    assert.equal(dates.normalizeSalesDate('07-Apr-2026'), '2026-04-07');
  });

  await t.test('parses MonthName-D-YYYY', () => {
    assert.equal(dates.normalizeSalesDate('April 7, 2026'), '2026-04-07');
  });

  await t.test('resolves "today" to todayInLagos()', () => {
    assert.equal(dates.normalizeSalesDate('today'), dates.todayInLagos());
  });

  await t.test('"yesterday" is an ISO day strictly before today', () => {
    const y = dates.normalizeSalesDate('yesterday');
    assert.match(y, ISO_RE);
    assert.ok(y < dates.todayInLagos());
  });

  await t.test('rejects impossible calendar dates (31-Feb)', () => {
    assert.equal(dates.normalizeSalesDate('31-02-2026'), null);
  });

  await t.test('returns null for empty / unparseable input', () => {
    assert.equal(dates.normalizeSalesDate(''), null);
    assert.equal(dates.normalizeSalesDate(null), null);
    assert.equal(dates.normalizeSalesDate('sometime soon'), null);
  });
});

test('salvageSalesDate() — ISC-1 §2a word-prefixed sale dates', async (t) => {
  await t.test('strips a leading product word (the 75 madam oshodi rows)', () => {
    assert.deepEqual(dates.salvageSalesDate('cashmere 12-February-2026'),
      { iso: '2026-02-12', stripped: '12-February-2026' });
  });

  await t.test('strips a leading word off an ISO tail (the 30 Madam motunrayo rows)', () => {
    assert.deepEqual(dates.salvageSalesDate('cashmere 2026-07-27'),
      { iso: '2026-07-27', stripped: '2026-07-27' });
  });

  await t.test('plain ISO passes through untouched', () => {
    assert.deepEqual(dates.salvageSalesDate('2026-04-07'), { iso: '2026-04-07', stripped: '2026-04-07' });
  });

  await t.test('garbage → iso null, nothing invented', () => {
    assert.equal(dates.salvageSalesDate('sometime soon').iso, null);
    assert.equal(dates.salvageSalesDate('cashmere').iso, null);
    assert.deepEqual(dates.salvageSalesDate(''), { iso: null, stripped: '' });
    assert.deepEqual(dates.salvageSalesDate(null), { iso: null, stripped: '' });
  });

  await t.test('a month word is never stripped', () => {
    assert.deepEqual(dates.salvageSalesDate('12 February 2026'),
      { iso: '2026-02-12', stripped: '12 February 2026' });
    assert.deepEqual(dates.salvageSalesDate('April 7, 2026'),
      { iso: '2026-04-07', stripped: 'April 7, 2026' });
  });

  await t.test('a trailing word is stripped', () => {
    assert.deepEqual(dates.salvageSalesDate('12-February-2026 cashmere'),
      { iso: '2026-02-12', stripped: '12-February-2026' });
  });

  await t.test('tokens are never reordered and digits never touched', () => {
    assert.deepEqual(dates.salvageSalesDate('cashmere 12 February 2026 sale'),
      { iso: '2026-02-12', stripped: '12 February 2026' });
    // A word in the MIDDLE is not an end token: left alone, so still unparseable.
    assert.equal(dates.salvageSalesDate('12 cashmere February 2026').iso, null);
    // A token carrying a digit is not a stray word.
    assert.equal(dates.salvageSalesDate('lot2 12-February-2026').iso, null);
  });

  await t.test('whitespace is trimmed and collapsed', () => {
    assert.deepEqual(dates.salvageSalesDate('  cashmere   12-February-2026  '),
      { iso: '2026-02-12', stripped: '12-February-2026' });
  });

  await t.test('the relative words the normaliser accepts are kept', () => {
    assert.equal(dates.salvageSalesDate('today').iso, dates.todayInLagos());
    assert.equal(dates.salvageSalesDate('cashmere today').stripped, 'today');
  });
});
