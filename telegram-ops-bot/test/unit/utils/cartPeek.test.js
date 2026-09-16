'use strict';

/**
 * CART-PEEK — the basket block that rides the picker cards.
 *
 * Owner, 16-Sep-2026: "When I am selecting the design → shade → quantity
 * from the supply request, I am not able to see what I have selected in the
 * cart already." The peek is the cart card's own lines under a header that
 * carries the tally, capped for photo captions, never cut silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { formatCartPeek, formatCart } = require(path.join(__dirname, '..', '..', '..', 'src', 'utils', 'cartFormat'));

const ROWS = [
  { icon: '🧵', design: '202/201', name: 'Cashmere', shadeRef: '3 - Navy Blue', quantity: 2 },
  { icon: '🧵', design: '202/201', name: 'Cashmere', shadeRef: '1 - White', quantity: 1 },
  { icon: '🧵', design: '9037', shadeRef: '3', quantity: 1 },
];

test('CART-PEEK: header carries the tally, lines are the cart card\'s own', () => {
  const peek = formatCartPeek(ROWS);
  const lines = peek.split('\n');
  assert.equal(lines[0], '🛒 In cart · Σ 4B', 'the total is on the header, first thing read');
  // The body is exactly what the cart card prints (no category on the
  // requester's own screens) — one formatter, so the two can never differ.
  const cardBody = formatCart(ROWS, { showCategory: false }).split('\n\n')[0];
  assert.equal(lines.slice(1).join('\n'), cardBody);
  assert.doesNotMatch(peek, /Cashmere/, 'no category on the requester\'s picker');
});

test('CART-PEEK: an empty cart is an empty string, not an empty header', () => {
  assert.equal(formatCartPeek([]), '');
  assert.equal(formatCartPeek(null), '');
});

test('CART-PEEK: the cap is never silent — the cut line says where the rest is', () => {
  const peek = formatCartPeek(ROWS, { maxLines: 2 });
  const lines = peek.split('\n');
  assert.equal(lines.length, 4, 'header + 2 kept + the pointer');
  assert.equal(lines[0], '🛒 In cart · Σ 4B', 'the tally survives the cut');
  assert.match(lines[3], /…and more in the cart/, 'wording true on every card — not every card has a cart button');
});

test('CART-PEEK: under the cap nothing is cut and no pointer appears', () => {
  const peek = formatCartPeek(ROWS, { maxLines: 8 });
  assert.doesNotMatch(peek, /more in/);
  assert.equal(peek.split('\n').length, 6, 'header + 2 design headers + 3 shade bullets');
});

test('CART-PEEK: the DEFAULT cap is 8 block lines — no opts, big cart', () => {
  const big = [];
  for (let d = 1; d <= 5; d += 1) for (const sh of ['1', '2']) big.push({ design: `D${d}`, shadeRef: sh, quantity: 1 });
  const lines = formatCartPeek(big).split('\n');      // 15 block lines → header + 8 + pointer
  assert.equal(lines.length, 10, `got ${lines.length}:\n${lines.join('\n')}`);
  assert.match(lines[9], /…and more in the cart/);
});

test('CART-PEEK: the cut never leaves a design header with nothing under it', () => {
  // Shade counts [2,3,1,…] → block lines hdr,b,b,hdr,b,b,b,hdr,b,… — the 8th
  // kept line would be a bare header; the cut moves back to the boundary.
  const rows = [
    { design: 'A', shadeRef: '1', quantity: 1 }, { design: 'A', shadeRef: '2', quantity: 1 },
    { design: 'B', shadeRef: '1', quantity: 1 }, { design: 'B', shadeRef: '2', quantity: 1 }, { design: 'B', shadeRef: '3', quantity: 1 },
    { design: 'C', shadeRef: '1', quantity: 1 }, { design: 'D', shadeRef: '1', quantity: 1 },
  ];
  const lines = formatCartPeek(rows).split('\n');
  const beforePointer = lines[lines.length - 2];
  assert.match(lines[lines.length - 1], /…and more in the cart/);
  assert.match(beforePointer, /^ {2}• /, `the line before the pointer is a shade, never a bare header: ${beforePointer}`);
  assert.ok(!lines.includes('C'), 'design C, cut at its header, is not shown headless');
});

test('CART-PEEK: a maxLines that is not a whole number ≥ 1 means the default', () => {
  const big = [];
  for (let d = 1; d <= 5; d += 1) for (const sh of ['1', '2']) big.push({ design: `D${d}`, shadeRef: sh, quantity: 1 });
  for (const bad of [0, -1, 'x', NaN, 2.5]) {
    assert.equal(formatCartPeek(big, { maxLines: bad }).split('\n').length, 10, `maxLines=${bad} → default 8`);
  }
});

test('CART-PEEK: maxLines 1 leaves the header and the pointer — never a headless design', () => {
  const rows = [{ design: 'A', shadeRef: '1', quantity: 1 }, { design: 'B', shadeRef: '1', quantity: 1 }];
  const lines = formatCartPeek(rows, { maxLines: 1 }).split('\n');
  assert.deepEqual(lines, ['🛒 In cart · Σ 2B', '  • …and more in the cart']);
});
