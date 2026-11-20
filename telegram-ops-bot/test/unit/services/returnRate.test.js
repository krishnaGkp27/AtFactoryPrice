'use strict';

/**
 * RET-8 — the pure half of a return's rate step (services/returnRate.js):
 * what a gap is, the canonical print a signature carries, the credit a fill
 * makes, and the executor's rule that a fill never replaces a recorded rate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const rr = require(path.join(SRC, 'services/returnRate'));
const { parseRateNumber } = require(path.join(SRC, 'utils/rateInput'));

const it = (pkg, than, customer, customerId, design, rate) => ({
  packageNo: pkg, thanNo: than, design, yards: 30, pricePerYard: rate, customer, soldTo: customer, customerId,
});
const BUNDLE = {
  action: 'return_bundle',
  items: [
    it('9300', 1, 'solder madam', 'CUS-S', '44200', 0),
    it('9300', 2, 'solder madam', 'CUS-S', '44200', 0),
    it('9301', 1, 'solder madam', 'CUS-S', '9060-A', 1000),
    it('6190', 1, 'ABBA', '', '77015', 0),
  ],
};

test('a gap is one (buyer, design) pair with a than whose stored rate is not above zero', () => {
  const gaps = rr.gapsOf(BUNDLE);
  assert.deepEqual(gaps.map((g) => [g.key, g.customer, g.design, g.thans, g.yards]), [
    ['ABBA|77015', 'ABBA', '77015', 1, 30],
    ['CUS-S|44200', 'solder madam', '44200', 2, 60],
  ]);
  assert.deepEqual(rr.gapsOf({ action: 'sale_bundle', items: BUNDLE.items }), [], 'only returns');
  assert.equal(rr.stepState(BUNDLE), 'ask');
  assert.equal(rr.stepState({ ...BUNDLE, approvals: ['777'] }), 'legacy');
  assert.equal(rr.stepState({ ...BUNDLE, items: [BUNDLE.items[2]] }), 'none');
});

test('return_thans: per-than rates when stored; a row from before RET-8 reads its average', () => {
  const base = { action: 'return_thans', customer: 'ABBA', customerId: 'CUS-A', design: '9037', thanNos: [1, 4], yards: 60 };
  assert.deepEqual(rr.gapsOf({ ...base, thanRates: [{ thanNo: 1, yards: 30, rate: 0 }, { thanNo: 4, yards: 30, rate: 2500 }] })
    .map((g) => [g.key, g.thans, g.yards]), [['CUS-A|9037', 1, 30]]);
  assert.deepEqual(rr.gapsOf({ ...base, pricePerYard: 0 }).map((g) => [g.thans, g.yards]), [[2, 60]]);
  assert.deepEqual(rr.gapsOf({ ...base, pricePerYard: 1250 }), []);
});

test('fills: built only when every gap is answered with a rate above zero or "no credit"', () => {
  const gaps = rr.gapsOf(BUNDLE);
  assert.equal(rr.buildFills(gaps, [{ rate: 900 }]), null);
  assert.equal(rr.buildFills(gaps, [{ rate: 900 }, { rate: 0 }]), null);
  const fills = rr.buildFills(gaps, [{ noCredit: true }, { rate: 1450 }]);
  assert.deepEqual(fills.map((f) => [f.key, f.rate, !!f.noCredit]), [['ABBA|77015', undefined, true], ['CUS-S|44200', 1450, false]]);
  assert.ok(rr.fillsMatchGaps(BUNDLE, fills));
});

test('the print is order-free and changes with any rate; the hash fits a button', () => {
  const a = [{ key: 'B|2', rate: 900 }, { key: 'A|1', noCredit: true }];
  const b = [a[1], a[0]];
  assert.equal(rr.printOf(a), 'A|1=none;B|2=900');
  assert.equal(rr.printOf(a), rr.printOf(b));
  assert.notEqual(rr.printOf(a), rr.printOf([{ key: 'B|2', rate: 901 }, a[1]]));
  assert.match(rr.hashOf(rr.printOf(a)), /^[0-9a-f]{10}$/);
});

test('signedPrintProblem: every signature must carry the row\'s print — fail-closed', () => {
  const rateFill = [{ key: 'CUS-S|44200', rate: 1450 }];
  const print = rr.printOf(rateFill);
  assert.equal(rr.signedPrintProblem({ ...BUNDLE, approvals: ['777'] }), '', 'no fills: nothing to check');
  assert.equal(rr.signedPrintProblem({ ...BUNDLE, rateFill, signoffs: [{ id: '777', name: 'Musa', ratePrint: print }] }), '');
  assert.match(rr.signedPrintProblem({ ...BUNDLE, rateFill, signoffs: [{ id: '777', name: 'Musa' }] }), /Musa names no rate/);
  assert.match(rr.signedPrintProblem({ ...BUNDLE, rateFill, approvals: ['777'] }), /names no rate/, 'a bare approval id');
  assert.match(rr.signedPrintProblem({ ...BUNDLE, rateFill, signoffs: [{ id: '777', name: 'Musa', ratePrint: 'x=1' }] }), /different rate/);
});

test('creditByBuyer: the buyer\'s whole credit = their own rates + the fills', () => {
  const fills = rr.buildFills(rr.gapsOf(BUNDLE), [{ noCredit: true }, { rate: 1450 }]);
  const out = rr.creditByBuyer(BUNDLE, fills);
  assert.deepEqual(out.map((b) => [b.customer, b.rated, b.filled, b.total]), [['ABBA', 0, 0, 0], ['solder madam', 30000, 87000, 117000]]);
});

test('priceRows: a recorded rate is never replaced; a than without one takes its fill; no fill stays at zero', () => {
  const aj = { ...BUNDLE, rateFill: [{ key: 'CUS-S|44200', customer: 'solder madam', design: '44200', rate: 1450 }] };
  const buyer = { customer: 'solder madam', customerId: 'CUS-S', design: '44200' };
  const { rows, used } = rr.priceRows(aj, [
    { design: '44200', yards: 30, pricePerYard: 0 },
    { design: '44200', yards: 30, pricePerYard: 1200 },
  ], buyer);
  assert.deepEqual(rows.map((r) => r.pricePerYard), [1450, 1200]);
  assert.equal(used.length, 1);
  const none = rr.priceRows({ ...BUNDLE }, [{ design: '44200', yards: 30, pricePerYard: 0 }], buyer);
  assert.equal(none.rows[0].pricePerYard, 0);
  const noCredit = rr.priceRows({ ...BUNDLE, rateFill: [{ key: 'CUS-S|44200', noCredit: true }] }, [{ design: '44200', yards: 30, pricePerYard: 0 }], buyer);
  assert.equal(noCredit.rows[0].pricePerYard, 0);
  assert.equal(noCredit.used.length, 1, 'the "no credit" choice is named on the reply');
});

test('the typed rate reader is the sale wizard\'s: decimals kept, words refused', () => {
  assert.equal(parseRateNumber('1450'), 1450);
  assert.equal(parseRateNumber(' 3.20 '), 3.2);
  assert.equal(parseRateNumber('0'), 0);
  assert.equal(parseRateNumber('-5'), null);
  assert.equal(parseRateNumber('1,450'), null);
  assert.equal(parseRateNumber('abc'), null);
});
