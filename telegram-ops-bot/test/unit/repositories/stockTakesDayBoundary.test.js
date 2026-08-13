'use strict';

/**
 * TIME-1 regression — the read/write clock split.
 *
 * Moving `todayStateFor` to the Lagos day was only half the change: the rows
 * it filters carry `audited_at` as a stored UTC instant, and rowsForDay
 * matched them by string PREFIX. Two different clocks either side of one
 * comparison, so for the hour after Lagos midnight the same-day audit state
 * came back EMPTY — the flag lock stopped holding and a design could be
 * re-counted wrong without ever escalating.
 *
 * The rule this pins: whenever a "day" meets a stored instant, both sides go
 * through normDay first.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets } = require('../../helpers/controllerHarness');
const stockTakes = require('../../../src/repositories/stockTakesRepository');
const { normDay } = require('../../../src/utils/dates');

// 23:20Z on the 12th is already 00:20 on the 13th in Lagos.
const AFTER_MIDNIGHT = '2026-08-12T23:20:00.000Z';
const LAGOS_DAY = '2026-08-13';

/** One StockTakes row in sheet order. */
function row(warehouse, design, auditedAt, result = 'ok') {
  return [`ST-${design}`, '', warehouse, design, '1', '0', '30',
    result, 'Musa', auditedAt, '1', '0', ''];
}

function seed(rows) {
  installFakeSheets(createFakeSheets({ StockTakes: [stockTakes.HEADERS, ...rows] }));
  stockTakes.invalidateCache();
}

test('a row stamped after Lagos midnight belongs to the LAGOS day', async () => {
  seed([
    row('Kano office', 'X', AFTER_MIDNIGHT, 'mismatch'),
    row('Kano office', 'Y', '2026-08-13T09:00:00.000Z'),
    row('Kano office', 'Z', '2026-08-12T09:00:00.000Z'),
  ]);
  const rows = await stockTakes.rowsForDay('Kano office', LAGOS_DAY);
  assert.deepEqual(rows.map((r) => r.design).sort(), ['X', 'Y'],
    'the 23:20Z row is the same Lagos day as the 09:00Z one that follows it');
  // The prefix match this replaced could not see X at all.
  assert.ok(!AFTER_MIDNIGHT.startsWith(LAGOS_DAY), 'the old comparison missed it');
});

test('the warehouse filter still scopes, and legacy date cells still match', async () => {
  seed([
    row('Kano office', 'X', AFTER_MIDNIGHT),
    row('IDUMOTA', 'X2', AFTER_MIDNIGHT),
    row('kano OFFICE', 'bare', '2026-08-13'),
    row('Kano office', 'locale', '13/08/2026'),
  ]);
  const rows = await stockTakes.rowsForDay('Kano office', LAGOS_DAY);
  assert.deepEqual(rows.map((r) => r.design).sort(), ['X', 'bare', 'locale'],
    'case-insensitive warehouse; instants, bare days and Sheets locales alike');
  assert.ok(!rows.some((r) => r.warehouse === 'IDUMOTA'), 'another store is never mixed in');
});

test('normDay is the single door both sides of the comparison pass through', () => {
  assert.equal(normDay(AFTER_MIDNIGHT), LAGOS_DAY);
  assert.equal(normDay(LAGOS_DAY), LAGOS_DAY);
  assert.equal(normDay('13/08/2026'), LAGOS_DAY);
});
