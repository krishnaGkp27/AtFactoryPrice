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
