'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatCartBlock, formatCartTally, formatCart } = require('../../../src/utils/cartFormat');

const row = (design, shadeRef, quantity, name = '', icon = '🧵') => ({ icon, design, name, shadeRef, quantity });

test('one design: header line + one bullet per shade in rule-6c counts', () => {
  assert.deepEqual(formatCartBlock([row('202/201', '1 - White', 1, 'Cashmere'), row('202/201', '3 - Navy Blue', 2, 'Cashmere')]),
    ['🧵 202/201 · Cashmere', '  • 1 - White · 1B', '  • 3 - Navy Blue · 2B']);
});

test('showCategory:false drops the category on the requester\'s own card', () => {
  assert.deepEqual(formatCartBlock([row('9037', '3 - White', 2, 'Chinos')], { showCategory: false }),
    ['🧵 9037', '  • 3 - White · 2B']);
});

test('several designs keep first-appearance order; bullets stay under their design', () => {
  const lines = formatCartBlock([row('77019', '1', 1), row('9037', '2', 1), row('77019', '3', 3)]);
  assert.deepEqual(lines, ['🧵 77019', '  • 1 · 1B', '  • 3 · 3B', '🧵 9037', '  • 2 · 1B']);
});

test('tally is Σ in the rule-6c grammar; never "bales" / "bls"', () => {
  assert.equal(formatCartTally([row('201', '1', 2), row('201', '3', 1), row('201', '4', 3)]), 'Σ 6B');
  assert.equal(formatCartTally([]), 'Σ 0B');
});

test('formatCart joins block, blank line, tally — and no pseudo-columns anywhere', () => {
  const text = formatCart([row('202/201', '1 - White', 1), row('202/201', '3 - Navy Blue', 1)], { showCategory: false });
  assert.equal(text, '🧵 202/201\n  • 1 - White · 1B\n  • 3 - Navy Blue · 1B\n\nΣ 2B');
  assert.ok(!/[│━]|bls|bales/.test(text));
});

test('empty cart → no lines, empty text', () => {
  assert.deepEqual(formatCartBlock([]), []);
  assert.equal(formatCart([]), '');
});
