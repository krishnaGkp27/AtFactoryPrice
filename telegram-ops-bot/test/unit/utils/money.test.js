'use strict';

/**
 * CUR-1 — src/utils/money.js, the one money module (BUSINESS_RULES §17).
 *
 * Side A (`expense`) prints a literal ₦ regardless of the env; side B
 * (`sale`, `saleRate`) prints a bare number and never a unit — the owner's
 * 09-Sep-2026 multiplier ruling superseded the once-printed label, so
 * `saleHeader` returns the bare word and `saleLegend` returns ''. `code()`
 * is the accounting code only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const money = require(path.join(SRC, 'utils/money'));
const config = require(path.join(SRC, 'config'));

test('expense(): literal ₦, en-NG grouping, fixed decimals', async (t) => {
  await t.test('integer by default', () => {
    assert.equal(money.expense(12345), '₦12,345');
    assert.equal(money.expense(1234567), '₦1,234,567');
    assert.equal(money.expense(1512.5), '₦1,513', 'rounds, never truncates');
  });

  await t.test('fraction: 2 prints exactly two decimals', () => {
    assert.equal(money.expense(1512.5, { fraction: 2 }), '₦1,512.50');
    assert.equal(money.expense(1512, { fraction: 2 }), '₦1,512.00');
  });

  await t.test('garbage and empties render as ₦0', () => {
    assert.equal(money.expense(null), '₦0');
    assert.equal(money.expense(undefined), '₦0');
    assert.equal(money.expense('abc'), '₦0');
    assert.equal(money.expense(NaN), '₦0');
  });

  await t.test('numeric strings are accepted (sheet cells)', () => {
    assert.equal(money.expense('50000'), '₦50,000');
  });

  await t.test('the symbol never depends on the env', () => {
    const orig = config.currency;
    try {
      config.currency = 'USD';
      assert.equal(money.expense(1500), '₦1,500');
      config.currency = '';
      assert.equal(money.expense(1500), '₦1,500');
    } finally {
      config.currency = orig;
    }
  });
});

test('sale(): bare number, en-NG grouping, no symbol, no unit', async (t) => {
  await t.test('integer by default', () => {
    assert.equal(money.sale(12345), '12,345');
    assert.equal(money.sale(1680000), '1,680,000');
    assert.equal(money.sale(1234.4), '1,234');
  });

  await t.test('fraction: 2 prints exactly two decimals', () => {
    assert.equal(money.sale(4000, { fraction: 2 }), '4,000.00');
    assert.equal(money.sale(3.2, { fraction: 2 }), '3.20');
  });

  await t.test('never prints ₦, NGN or any letter', () => {
    for (const n of [0, 1, 1500, 2500000, 3.2]) {
      const s = money.sale(n);
      assert.doesNotMatch(s, /₦|NGN|[A-Za-z]/, s);
    }
  });

  await t.test('garbage and empties render as 0', () => {
    assert.equal(money.sale(null), '0');
    assert.equal(money.sale(undefined), '0');
    assert.equal(money.sale('x'), '0');
  });

  await t.test('a change to CURRENCY cannot move a sale figure', () => {
    const orig = config.currency;
    try {
      config.currency = 'USD';
      assert.equal(money.sale(1500), '1,500');
    } finally {
      config.currency = orig;
    }
  });
});

test('saleRate(): bare rate with the divisor named', async (t) => {
  await t.test('integer rate', () => {
    assert.equal(money.saleRate(1450), '1,450/yd');
    assert.equal(money.saleRate(2500), '2,500/yd');
  });

  await t.test('fraction: 2 — the CUR-2 customer-copy rate shape', () => {
    assert.equal(money.saleRate(4000, { fraction: 2 }), '4,000.00/yd');
    assert.equal(money.saleRate(3.2, { fraction: 2 }), '3.20/yd');
  });

  await t.test('a different divisor can be named', () => {
    assert.equal(money.saleRate(120, { per: 'm' }), '120/m');
  });

  await t.test('no symbol anywhere', () => {
    assert.doesNotMatch(money.saleRate(1450), /₦|NGN/);
  });
});

test('saleHeader() / saleLegend(): the seam prints no unit', async (t) => {
  await t.test('saleHeader returns the bare word', () => {
    assert.equal(money.saleHeader('COST'), 'COST');
    assert.equal(money.saleHeader('PAYMENTS'), 'PAYMENTS');
    assert.equal(money.saleHeader(' Rate '), 'Rate');
    assert.equal(money.saleHeader(undefined), '');
  });

  await t.test('saleLegend is empty', () => {
    assert.equal(money.saleLegend(), '');
  });

  await t.test('neither depends on the env', () => {
    const orig = config.currency;
    try {
      config.currency = 'USD';
      assert.equal(money.saleHeader('COST'), 'COST');
      assert.equal(money.saleLegend(), '');
    } finally {
      config.currency = orig;
    }
  });
});

test('code(): the accounting code, NGN when unset or blank', async (t) => {
  await t.test('reads config.currency', () => {
    const orig = config.currency;
    try {
      config.currency = 'USD';
      assert.equal(money.code(), 'USD');
      config.currency = '  GBP ';
      assert.equal(money.code(), 'GBP');
    } finally {
      config.currency = orig;
    }
  });

  await t.test('blank / null → NGN', () => {
    const orig = config.currency;
    try {
      config.currency = '';
      assert.equal(money.code(), 'NGN');
      config.currency = null;
      assert.equal(money.code(), 'NGN');
      config.currency = '   ';
      assert.equal(money.code(), 'NGN');
    } finally {
      config.currency = orig;
    }
  });

  await t.test('is never a symbol', () => {
    assert.doesNotMatch(money.code(), /₦/);
  });
});

test('a figure that rounds to zero prints unsigned — never "-0"', async (t) => {
  await t.test('negative zero itself (Math.round of a small negative balance)', () => {
    assert.equal(money.sale(-0), '0');
    assert.equal(money.expense(-0), '₦0');
    assert.equal(money.saleRate(-0), '0/yd');
  });
  await t.test('a small negative that rounds to zero at the printed precision', () => {
    assert.equal(money.sale(-0.4), '0');
    assert.equal(money.expense(-0.4), '₦0');
    assert.equal(money.sale(-0.004, { fraction: 2 }), '0.00');
  });
  await t.test('a real negative keeps its sign', () => {
    assert.equal(money.sale(-1), '-1');
    assert.equal(money.sale(-0.5), '-1');
    assert.equal(money.expense(-1234.5, { fraction: 2 }), '₦-1,234.50');
  });
});

test('NAIRA is the one exported spelling of the symbol', () => {
  assert.equal(money.NAIRA, '₦');
  assert.equal(money.expense(1), `${money.NAIRA}1`);
});

test('the exported API is exactly the CUR-1 contract', () => {
  assert.deepEqual(
    Object.keys(money).sort(),
    ['NAIRA', 'code', 'expense', 'sale', 'saleHeader', 'saleLegend', 'saleRate'],
  );
});
