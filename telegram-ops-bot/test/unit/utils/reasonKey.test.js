'use strict';

/** PAY-2 — the chip key: one spelling family, one key. Pure. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseReasonKey } = require('../../../src/utils/reasonKey');

test('the spec example: case, edge whitespace, internal runs, trailing punctuation', () => {
  assert.equal(normaliseReasonKey('  Transport   to Idumota!! '), 'transport to idumota');
});

test('the same reason typed three ways is one key', () => {
  const keys = new Set([
    'Transport to Idumota', 'transport  to idumota!!', '  TRANSPORT TO IDUMOTA ', '...transport\tto\nidumota?',
  ].map(normaliseReasonKey));
  assert.deepEqual([...keys], ['transport to idumota']);
});

test('punctuation INSIDE the text stays; only the ends are stripped', () => {
  assert.equal(normaliseReasonKey('Loading, at the warehouse.'), 'loading, at the warehouse');
  assert.equal(normaliseReasonKey('"fuel - generator"'), 'fuel - generator');
});

test('a currency sign is a symbol, not punctuation — it survives', () => {
  assert.equal(normaliseReasonKey('₦4,000 float'), '₦4,000 float');
});

test('empty, null, undefined, numbers and punctuation-only text', () => {
  assert.equal(normaliseReasonKey(''), '');
  assert.equal(normaliseReasonKey(null), '');
  assert.equal(normaliseReasonKey(undefined), '');
  assert.equal(normaliseReasonKey('   '), '');
  assert.equal(normaliseReasonKey('!!!'), '');
  assert.equal(normaliseReasonKey(4000), '4000');
});

test('pure: the same input always yields the same key', () => {
  assert.equal(normaliseReasonKey('Loading at the warehouse'), normaliseReasonKey('Loading at the warehouse'));
});
