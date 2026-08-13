'use strict';

/**
 * TIME-1 (owner, 12-Aug-2026) — "make the time in human readable format",
 * then "go through the other places where the display of time has this
 * issue".
 *
 * The server runs UTC (Railway); the business runs Africa/Lagos, UTC+1 with
 * no DST. That produced two defect shapes, both pinned here:
 *
 *   1. a clock rendered without the zone is one hour early ALL DAY;
 *   2. a calendar day taken off the server clock is YESTERDAY between
 *      00:00 and 01:00 Lagos — harmless on a screen, permanent once it is
 *      stamped on a ledger row.
 *
 * The boundary instant used throughout is 2026-08-12T23:30:00Z, which is
 * already 13-Aug 00:30 in Lagos.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fmtDate = require('../../../src/utils/formatDate');
const { todayInLagos, lagosDayPlus, normDay, LAGOS_TZ } = require('../../../src/utils/dates');

const MIDDAY = '2026-08-12T15:58:34.018Z';     // 16:58 Lagos, same day
const AFTER_MIDNIGHT = '2026-08-12T23:30:00.000Z'; // 00:30 Lagos, NEXT day

/* ── fmtDate.withTime — the human-readable instant ── */

test('withTime renders the Lagos wall-clock, 24-hour, house date format', () => {
  assert.equal(fmtDate.withTime(MIDDAY), '12-Aug-2026, 16:58');
  assert.equal(fmtDate.withTime(new Date(MIDDAY)), '12-Aug-2026, 16:58',
    'a Date object works as well as a string');
});

test('withTime keeps date and time on the SAME side of midnight', () => {
  // The whole reason both halves come from one formatter: formatting the
  // date with fmtDate and the clock separately would print 12-Aug, 00:30.
  assert.equal(fmtDate.withTime(AFTER_MIDNIGHT), '13-Aug-2026, 00:30');
  assert.equal(fmtDate.withTime(AFTER_MIDNIGHT, { dateOnly: true }), '13-Aug-2026');
});

test('withTime never invents a clock for a date-only value', () => {
  // UTC midnight would read as 01:00 in Lagos — an hour nobody recorded.
  assert.equal(fmtDate.withTime('2026-08-12'), '12-Aug-2026');
});

test('withTime degrades instead of throwing', () => {
  assert.equal(fmtDate.withTime(''), '—');
  assert.equal(fmtDate.withTime(null), '—');
  assert.equal(fmtDate.withTime('not a date'), 'not a date');
});

test('withTime never lets the LOCALE name the month', () => {
  // Regression: Intl en-GB `month: 'short'` abbreviates September as "Sept"
  // under CLDR 42+, so one month of the year silently broke the locked
  // DD-MMM-YYYY house format. The month now comes from our own table.
  assert.equal(fmtDate.withTime('2026-09-15T15:58:34.018Z'), '15-Sep-2026, 16:58');
  for (let m = 1; m <= 12; m += 1) {
    const iso = `2026-${String(m).padStart(2, '0')}-15T12:00:00.000Z`;
    assert.equal(fmtDate.withTime(iso).split(', ')[0], fmtDate(iso),
      `month ${m}: withTime's date half must equal fmtDate exactly`);
    assert.match(fmtDate.withTime(iso, { dateOnly: true }), /^\d{2}-[A-Z][a-z]{2}-\d{4}$/,
      `month ${m}: house format DD-MMM-YYYY`);
  }
});

/* ── fmtDate itself — an instant resolves to its Lagos day ── */

test('fmtDate reads a zone-bearing timestamp as an instant, not a UTC prefix', () => {
  assert.equal(fmtDate(AFTER_MIDNIGHT), '13-Aug-2026',
    'was 12-Aug: the ISO prefix is the UTC day, not the Lagos one');
  assert.equal(fmtDate(MIDDAY), '12-Aug-2026');
  // 10:00+05:30 is 04:30 UTC, 05:30 Lagos — an explicit offset is honoured.
  assert.equal(fmtDate('2026-08-12T10:00:00+05:30'), '12-Aug-2026');
  assert.equal(fmtDate.short(AFTER_MIDNIGHT), '13-Aug-26');
});

test('fmtDate leaves every non-instant input byte-identical', () => {
  // Date-only and locale strings carry no zone, so nothing may shift.
  assert.equal(fmtDate('2026-08-12'), '12-Aug-2026');
  assert.equal(fmtDate('12/08/2026'), '12-Aug-2026');
  assert.equal(fmtDate('2026-08-12T10:00:00'), '12-Aug-2026', 'naive timestamp: no zone to convert');
  assert.equal(fmtDate(''), '—');
  assert.equal(fmtDate('rubbish'), 'rubbish');
});

/* ── the day helpers ── */

test('lagosDay gives the Lagos calendar day of a stored instant', () => {
  assert.equal(fmtDate.lagosDay(AFTER_MIDNIGHT), '2026-08-13');
  assert.equal(fmtDate.lagosDay(MIDDAY), '2026-08-12');
  assert.equal(fmtDate.lagosDay('rubbish'), '');
});

test('lagosDayPlus walks whole days from the Lagos day, both directions', () => {
  const t = todayInLagos();
  assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(lagosDayPlus(0), t);
  const step = (iso, n) => new Date(`${iso}T12:00:00Z`).getTime() + n * 86400000;
  assert.equal(lagosDayPlus(1), new Date(step(t, 1)).toLocaleDateString('en-CA', { timeZone: LAGOS_TZ }));
  assert.equal(lagosDayPlus(-30), new Date(step(t, -30)).toLocaleDateString('en-CA', { timeZone: LAGOS_TZ }));
});

test('normDay resolves an instant to the Lagos day, sheets locales unchanged', () => {
  assert.equal(normDay(AFTER_MIDNIGHT), '2026-08-13', 'the consistency sentinel compares this day');
  assert.equal(normDay(MIDDAY), '2026-08-12');
  assert.equal(normDay('2026-08-12'), '2026-08-12');
  assert.equal(normDay('27/07/2026'), '2026-07-27', 'the Sheets-locale path still works');
  assert.equal(normDay(''), '');
});

/* ── the shape of the bug, stated once ── */

test('a Lagos day is never derived from the raw UTC prefix again', () => {
  // This is the assertion the whole audit reduces to: for any instant in
  // the 23:00–24:00 UTC hour, the naive slice and the truth disagree.
  const naive = AFTER_MIDNIGHT.slice(0, 10);
  assert.equal(naive, '2026-08-12');
  assert.notEqual(fmtDate.lagosDay(AFTER_MIDNIGHT), naive);
  assert.equal(fmtDate.lagosDay(AFTER_MIDNIGHT), '2026-08-13');
});
