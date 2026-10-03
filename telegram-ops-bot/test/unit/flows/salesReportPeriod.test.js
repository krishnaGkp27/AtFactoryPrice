'use strict';
// SRP-1 — the Sales Report period: Weekly or a picked date range.
const test = require('node:test');
const assert = require('node:assert');
const flow = require('../../../src/flows/salesReportFlow');
const { rangeKey, parseKey, gridRows } = flow._internals;

test('a range key is 8 chars, round-trips both ends and keeps the show-all callback under 64 bytes', () => {
  const key = rangeKey('2026-09-12', '2026-10-03');
  assert.equal(key.length, 8);
  assert.deepEqual(parseKey(key), { from: '2026-09-12', to: '2026-10-03' });
  assert.deepEqual(parseKey('7'), { days: 7 });
  assert.deepEqual(parseKey('garbage'), { days: 30 }, 'an unreadable key falls back as the old code did');
  assert.ok(Buffer.byteLength(`rxw:sales_c:${key}|${'x'.repeat(40)}`) <= 64);
});

test('labels: Weekly / Last 7 Days for the chip, the range as people read it for a pick', () => {
  assert.equal(flow.titleLabel('7'), 'Weekly');
  assert.equal(flow.periodLabel('7'), 'Last 7 Days');
  const key = rangeKey('2026-09-12', '2026-10-03');
  assert.equal(flow.periodLabel(key), '12 Sep – 03 Oct 2026');
  assert.equal(flow.titleLabel(key), '12 Sep – 03 Oct 2026');
  assert.equal(flow.periodLabel(rangeKey('2025-12-20', '2026-01-05')), '20 Dec 2025 – 05 Jan 2026');
  assert.equal(flow.periodLabel(rangeKey('2026-10-03', '2026-10-03')), '03 Oct – 03 Oct 2026', 'a one-day report');
});

test('filterByPeriod: a range is inclusive at both ends; a day count counts back from today', () => {
  const sold = ['2026-09-11', '2026-09-12', '2026-09-20', '2026-10-03', '2026-10-04'].map((soldDate) => ({ soldDate }));
  const inRange = flow.filterByPeriod(sold, rangeKey('2026-09-12', '2026-10-03')).map((r) => r.soldDate);
  assert.deepEqual(inRange, ['2026-09-12', '2026-09-20', '2026-10-03']);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  assert.deepEqual(flow.filterByPeriod([{ soldDate: today }, { soldDate: '2000-01-01' }], '7').map((r) => r.soldDate), [today]);
});

test('the end-date grid marks the start day and makes every earlier day inert; no quick-chip row, Back + Menu last', () => {
  const rows = gridRows('2026-09', '2026-09-12');
  const cells = rows.slice(2, -1).flat();
  assert.ok(cells.some((c) => c.text === '[12]' && c.callback_data === 'srd:dd:2026-09-12'), 'the start day is marked and still pickable (a one-day report)');
  assert.ok(cells.filter((c) => /^\d+$/.test(c.text)).every((c) => c.callback_data.slice(7) > '2026-09-12'), 'every pickable day is after the start');
  assert.ok(!cells.some((c) => c.text === '11'), 'the day before the start is an inert dot');
  assert.deepEqual(rows[rows.length - 1].map((b) => b.text), ['⬅ Back', '🏠 Menu']);
  assert.ok(!rows.flat().some((b) => /Quick dates/.test(b.text)));
  assert.deepEqual(flow.periodCard().opts.reply_markup.inline_keyboard.flat().map((b) => b.text), ['📅 Weekly (7 days)', '📆 Pick dates', '⬅ Back to menu']);
});
