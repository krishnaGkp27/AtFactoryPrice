'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatCartLines } = require('../../../src/utils/cartFormat');

const row = (design, shadeRef, quantity, name = '', icon = '🧵') => ({ icon, design, name, shadeRef, quantity });

test('single-shade design keeps the classic one-line form', () => {
  const lines = formatCartLines([row('9037', '3 - White', 2, 'Chinos')], 'bls');
  assert.deepEqual(lines, ['🧵 9037 [Chinos] │ Shade: 3 - White │ ×2 bls']);
});

test('many shades ×1 of one design fold into a single Shades line', () => {
  const lines = formatCartLines(
    [1, 2, 3, 4, 6, 7, 8].map((s) => row('77019', String(s), 1)), 'bls');
  assert.deepEqual(lines, ['🧵 77019 │ Shades: 1, 2, 3, 4, 6, 7, 8 │ ×7 bls']);
});

test('mixed quantities annotate each shade and total correctly', () => {
  const lines = formatCartLines([row('201', '1', 2), row('201', '3', 1), row('201', '4', 3)], 'bls');
  assert.deepEqual(lines, ['🧵 201 │ Shades: 1×2, 3×1, 4×3 │ ×6 bls']);
});

test('multiple designs keep first-appearance order, one line each', () => {
  const lines = formatCartLines(
    [row('77019', '1', 1), row('9037', '2', 1), row('77019', '3', 1)], 'bls');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^🧵 77019 │ Shades: 1, 3 │ ×2 bls$/);
  assert.match(lines[1], /^🧵 9037 │ Shade: 2 │ ×1 bls$/);
});

test('empty cart → no lines', () => {
  assert.deepEqual(formatCartLines([], 'bls'), []);
});
