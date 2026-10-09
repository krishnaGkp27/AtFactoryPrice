'use strict';
// SRP-2 — Design Wise: one line per design, the bracket in rule-6c grammar.
const test = require('node:test');
const assert = require('node:assert/strict');
const flow = require('../../../src/flows/salesReportFlow');
const unit = require('../../../src/services/unitDisplayService');

const row = (design, pkg, than, warehouse, status = 'sold', yards = 30) => ({
  design, packageNo: pkg, thanNo: than, warehouse, status, yards, shade: than % 2 ? '2' : '9', arrival_batch: 'Jul26',
});
// 44200: bale 100 whole (5 of 5 sold) + bale 101 broken (2 of 5 sold) at IDUMOTA.
// 9032: 3 thans of bale 300 sold from Kano office (than-visible) — reads in thans.
// 77008: bale 500 whole, more yards than 44200's 7 thans? 5 × 30 = 150 < 210 — ranks second.
const ALL = [
  ...[1, 2, 3, 4, 5].map((t) => row('44200', '100', t, 'IDUMOTA')),
  ...[1, 2].map((t) => row('44200', '101', t, 'IDUMOTA')),
  ...[3, 4, 5].map((t) => row('44200', '101', t, 'IDUMOTA', 'available')),
  ...[1, 2, 3].map((t) => row('9032', '300', t, 'Kano office')),
  ...[4, 5].map((t) => row('9032', '300', t, 'Kano office', 'available')),
  ...[1, 2, 3, 4, 5].map((t) => row('77008', '500', t, 'Lagos')),
];
const SOLD = ALL.filter((r) => r.status === 'sold');
const qty = (rows) => unit.formatQty(rows, { thanWarehouses: new Set(['kano office']), roster: unit.buildBaleRoster(ALL) });

test('one line per design, every place summed, whole + loose in the bracket, ranked by yards, grand total in the same grammar', () => {
  const { text, keyboard } = flow.designReport(SOLD, 'Last 7 Days', qty);
  assert.equal(text, [
    '📊 *Sales Report — Last 7 Days — Design Wise*',
    '_B = whole bales · t = loose thans · yds_',
    '',
    '1. *44200* (1B + 2t) · 210 yds',
    '2. *77008* (1B) · 150 yds',
    '3. *9032* (3t) · 90 yds',
    '',
    '🧮 *Grand Total: 2B + 5t · 450 yds*',
  ].join('\n'));
  assert.equal(keyboard, null, 'every design is listed — nothing to expand');
  assert.ok(!/Shade|Bales|\d thans|value|₦|Show all/.test(text));
});

test('a design appears once even when its shades would rank apart; ties rank by design name; an empty period says so', () => {
  const sold = [row('B', '1', 1, 'Lagos'), row('A', '2', 1, 'Lagos'), row('B', '3', 1, 'Lagos', 'sold', 30)];
  const q = (rows) => unit.formatQty(rows, { thanWarehouses: new Set(), roster: unit.buildBaleRoster(sold) });
  const { text } = flow.designReport(sold, 'P', q);
  assert.match(text, /1\. \*B\* \(2B\) · 60 yds\n2\. \*A\* \(1B\) · 30 yds\n/);
  assert.equal((text.match(/\*B\*/g) || []).length, 1);
  assert.match(flow.designReport([], 'P', q).text, /Design Wise\*\n_B = whole bales · t = loose thans · yds_\n\nNo sales in this period\.$/);
});
