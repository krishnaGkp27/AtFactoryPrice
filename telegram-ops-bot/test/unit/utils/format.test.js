'use strict';

/**
 * Unit suite for src/utils/format.js — money / quantity formatting.
 * Env-dependent default currency is read from the module's own export so the
 * suite is robust regardless of CURRENCY config.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fmt = require('../../../src/utils/format');

test('currencySymbol()', async (t) => {
  await t.test('maps known codes to symbols', () => {
    assert.equal(fmt.currencySymbol('NGN'), '₦');
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
