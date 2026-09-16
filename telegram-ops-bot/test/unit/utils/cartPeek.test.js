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
  assert.match(lines[3], /…more in 🛒 Back to cart/);
});

test('CART-PEEK: under the cap nothing is cut and no pointer appears', () => {
  const peek = formatCartPeek(ROWS, { maxLines: 8 });
  assert.doesNotMatch(peek, /more in/);
  assert.equal(peek.split('\n').length, 6, 'header + 2 design headers + 3 shade bullets');
});
