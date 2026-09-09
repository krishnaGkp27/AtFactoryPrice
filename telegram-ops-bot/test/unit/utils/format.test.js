'use strict';

/**
 * Unit suite for src/utils/format.js — money / quantity formatting.
 * Env-dependent default currency is read from the module's own export so the
 * suite is robust regardless of CURRENCY config.
 *
 * CUR-1 step 9: `currencySymbol` / `fmtMoneyShort` are deleted; `fmtMoney` survives
 * SHIMS over src/utils/money.js for the duration of the sweep. The currency
 * assertions below pin the shims to the money module (behaviour-identical),
 * and go with the shims when CUR-1 §8 step 9 deletes them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../../../src/utils/format');
const money = require('../../../src/utils/money');

test('fmtMoney() — kept for the R5a daybook / trial balance only', async (t) => {
  await t.test('long form is "<CODE> <grouped>"', () => {
    assert.equal(fmt.fmtMoney(1500, 'NGN'), 'NGN 1,500');
    assert.equal(fmt.fmtMoney(1234567.4, 'USD'), 'USD 1,234,567');
  });
  await t.test('uses the accounting code from money.code() when omitted', () => {
    assert.equal(fmt.fmtMoney(1500), `${money.code()} 1,500`);
    assert.equal(fmt.fmtMoney(1500).split(' ')[1], money.sale(1500));
  });
  await t.test('coerces null/undefined to 0', () => {
    assert.equal(fmt.fmtMoney(null, 'NGN'), 'NGN 0');
    assert.equal(fmt.fmtMoney(undefined, 'NGN'), 'NGN 0');
  });
});

test('the currency shims are gone (CUR-1 step 9)', () => {
  assert.equal(fmt.fmtMoneyShort, undefined);
  assert.equal(fmt.currencySymbol, undefined);
  assert.equal(fmt.DEFAULT_CURRENCY, undefined);
  assert.equal(fmt.CURRENCY, undefined);
  assert.deepEqual(Object.keys(fmt).sort(), ['fmtMoney', 'fmtQty']);
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
