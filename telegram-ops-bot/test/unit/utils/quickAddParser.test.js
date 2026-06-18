'use strict';

/**
 * Unit suite for src/utils/quickAddParser.js — one-line Quick Add Customer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseQuickAddCustomerLine } = require('../../../src/utils/quickAddParser');

test('parseQuickAddCustomerLine() success', async (t) => {
  await t.test('name only', () => {
    const r = parseQuickAddCustomerLine('Mariam Salisu');
    assert.deepEqual(r, { ok: true, name: 'Mariam Salisu', phone: '', address: '' });
  });

  await t.test('name + phone', () => {
    const r = parseQuickAddCustomerLine('Mariam Salisu, +234-803-555-7777');
    assert.equal(r.ok, true);
    assert.equal(r.phone, '+234-803-555-7777');
    assert.equal(r.address, '');
  });

  await t.test('name + phone + address', () => {
    const r = parseQuickAddCustomerLine('Wang Tex, +234-1-555-1234, Lagos');
    assert.equal(r.address, 'Lagos');
  });

  await t.test('rejoins a comma-containing address', () => {
    const r = parseQuickAddCustomerLine('Wang Tex, +234-1-555-1234, Lagos, Apapa');
    assert.equal(r.address, 'Lagos, Apapa');
  });
});

test('parseQuickAddCustomerLine() rejections', async (t) => {
  await t.test('empty / non-string input', () => {
    assert.equal(parseQuickAddCustomerLine('').ok, false);
    assert.equal(parseQuickAddCustomerLine(null).ok, false);
  });

  await t.test('name too short', () => {
    const r = parseQuickAddCustomerLine('A');
    assert.equal(r.ok, false);
    assert.match(r.error, /too short/i);
  });

  await t.test('name too long', () => {
    const r = parseQuickAddCustomerLine('x'.repeat(81));
    assert.equal(r.ok, false);
    assert.match(r.error, /too long/i);
  });

  await t.test('malformed phone', () => {
    const r = parseQuickAddCustomerLine('Wang Tex, abc123!!');
    assert.equal(r.ok, false);
    assert.match(r.error, /malformed/i);
  });
});
