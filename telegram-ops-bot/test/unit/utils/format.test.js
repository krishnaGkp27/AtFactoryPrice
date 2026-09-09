'use strict';

/**
 * Unit suite for src/utils/format.js — money / quantity formatting.
 * Env-dependent default currency is read from the module's own export so the
 * suite is robust regardless of CURRENCY config.
 *
 * CUR-1: `currencySymbol` / `fmtMoney` / `fmtMoneyShort` are deprecated
 * SHIMS over src/utils/money.js for the duration of the sweep. The currency
 * assertions below pin the shims to the money module (behaviour-identical),
 * and go with the shims when CUR-1 §8 step 9 deletes them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../../../src/utils/format');
const money = require('../../../src/utils/money');

test('currencySymbol()', async (t) => {
  await t.test('maps known codes to symbols', () => {
    assert.equal(fmt.currencySymbol('NGN'), '₦');
    assert.equal(fmt.currencySymbol('NGN'), money.NAIRA, 'the naira glyph comes from money.js, not a second spelling');
    assert.equal(fmt.currencySymbol('USD'), '$');
    assert.equal(fmt.currencySymbol('GBP'), '£');
  });

  await t.test('falls back to "<CODE> " for unknown codes', () => {
    assert.equal(fmt.currencySymbol('AED'), 'AED ');
  });
});

test('fmtMoney()', async (t) => {
  await t.test('long form is "<CODE> <grouped>"', () => {
    assert.equal(fmt.fmtMoney(1500, 'USD'), 'USD 1,500');
    assert.equal(fmt.fmtMoney(1234567, 'NGN'), 'NGN 1,234,567');
  });

  await t.test('uses the module default currency when omitted', () => {
    assert.equal(fmt.fmtMoney(1500), `${fmt.DEFAULT_CURRENCY} 1,500`);
  });

  await t.test('shim: DEFAULT_CURRENCY is money.code() and the digits are money.sale()', () => {
    assert.equal(fmt.DEFAULT_CURRENCY, money.code());
    assert.equal(fmt.CURRENCY, money.code());
    assert.equal(fmt.fmtMoney(1234567, 'NGN'), `NGN ${money.sale(1234567)}`);
    assert.equal(fmt.fmtMoney(1234.4, 'USD'), `USD ${money.sale(1234.4)}`);
  });

  await t.test('coerces null/undefined to 0', () => {
    assert.equal(fmt.fmtMoney(null, 'USD'), 'USD 0');
    assert.equal(fmt.fmtMoney(undefined, 'USD'), 'USD 0');
  });
});

test('fmtMoneyShort()', async (t) => {
  await t.test('compact form is "<symbol><grouped>" with no gap', () => {
    assert.equal(fmt.fmtMoneyShort(1500, 'NGN'), '₦1,500');
    assert.equal(fmt.fmtMoneyShort(1500, 'USD'), '$1,500');
  });

  await t.test('falls back to "<CODE> <grouped>" for unknown codes', () => {
    assert.equal(fmt.fmtMoneyShort(1500, 'AED'), 'AED 1,500');
  });

  await t.test('shim: the naira form IS money.expense() — same string, same rounding', () => {
    // -0 / -0.4: the old format.js printed '₦0' for -0 (Number(n || 0)); the
    // shim must not regress that to '₦-0' on a live balance line.
    for (const n of [0, 1500, 1234.4, 1234567, null, undefined, -0, -0.4]) {
      assert.equal(fmt.fmtMoneyShort(n, 'NGN'), money.expense(n));
    }
    assert.equal(fmt.fmtMoneyShort(-0, 'NGN'), '₦0');
    assert.equal(fmt.fmtMoney(-0), 'NGN 0');
    assert.equal(fmt.fmtMoneyShort(1500, 'USD'), `$${money.sale(1500)}`);
  });
});

test('fmtQty()', async (t) => {
  await t.test('integer by default', () => {
    assert.equal(fmt.fmtQty(1234.4), '1,234');
  });

  await t.test('honors maxFraction', () => {
    assert.equal(fmt.fmtQty(1234.56, { maxFraction: 2 }), '1,234.56');
  });

  await t.test('coerces null to 0', () => {
    assert.equal(fmt.fmtQty(null), '0');
  });
});
