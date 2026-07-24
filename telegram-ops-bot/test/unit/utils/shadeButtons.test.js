'use strict';

/**
 * shadeButtons.buildShadeLabel — numeric-qty unit suffix (existing) and the
 * TV-3 preformatted-string branch ("2B = 5t" inserted verbatim, no unit word).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildShadeLabel } = require('../../../src/utils/shadeButtons');

test('buildShadeLabel: numeric qty keeps unit-word behavior', () => {
  assert.equal(buildShadeLabel('1', new Map([['1', 'Cream']]), 2), '1 - Cream (2 bales)');
  assert.equal(buildShadeLabel('1', null, 1), '1 (1 bale)');
  assert.equal(buildShadeLabel('1', null, 3, { singular: 'box', plural: 'boxes' }), '1 (3 boxes)');
  assert.equal(buildShadeLabel('1', null, 0), '1', 'zero qty → no parens');
});

test('buildShadeLabel: TV-3 preformatted string qty is inserted verbatim', () => {
  assert.equal(buildShadeLabel('1', new Map([['1', 'Cream']]), '2B = 5t'), '1 - Cream (2B = 5t)');
  assert.equal(buildShadeLabel('ash', null, '1B = 4t'), 'ash (1B = 4t)');
  // Unit override is ignored for string quantities — no unit word appended.
  assert.equal(buildShadeLabel('1', null, '2B = 5t', { singular: 'bale', plural: 'bales' }), '1 (2B = 5t)');
  assert.equal(buildShadeLabel('1', null, '   '), '1', 'blank string → no parens');
});
