'use strict';

/**
 * TV-8 — the one quantity grammar (owner, 02-Aug-2026).
 *
 * "Only the customer taking the goods from an allowed store (Kano office,
 *  Lagos office) will be showing thans. Remaining will be showing bales
 *  with suffix B, or bales plus thans ..B + ..t."
 *
 * Two independent reasons a quantity is thans, folded into one label:
 *   (a) the goods left a than-visibility warehouse;
 *   (b) the customer took only PART of a bale (a bale-only store that
 *       starts breaking bales — "moving the warehouse into small store").
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const svc = require(path.join(__dirname, '..', '..', '..', 'src', 'services', 'unitDisplayService'));

const THAN_WH = new Set(['kano office']);

function row(pkg, wh = 'IDUMOTA', batch = 'Jul26', design = 'D1') {
  return { packageNo: String(pkg), design, warehouse: wh, arrivalBatch: batch };
}

/** Bale 1 has 4 thans, bale 2 has 1, bale 3 (Kano) has 3. */
const WORLD = [
  row(1), row(1), row(1), row(1),
  row(2),
  row(3, 'Kano office'), row(3, 'Kano office'), row(3, 'Kano office'),
];
const roster = svc.buildBaleRoster(WORLD);
const fmt = (rows) => svc.formatQty(rows, { thanWarehouses: THAN_WH, roster });

test('a whole bale from a bale-only store is one B', () => {
  assert.equal(fmt([row(2)]), '1B');
});

test('goods from a than-visible store count in thans', () => {
  assert.equal(fmt([row(3, 'Kano office'), row(3, 'Kano office')]), '2t');
});

test('a part-taken bale from a bale-only store reads as loose thans', () => {
  // 2 of bale 1's 4 thans — the store broke the bale.
  assert.equal(fmt([row(1), row(1)]), '2t');
});

test('all of a bale\'s thans, taken together, is a whole bale', () => {
  assert.equal(fmt([row(1), row(1), row(1), row(1)]), '1B');
});

test('whole bales and loose thans combine as "..B + ..t"', () => {
  assert.equal(fmt([row(2), row(1), row(1)]), '1B + 2t');
});

test('cross-store mixing folds into the same label', () => {
  // 1 whole bale (IDUMOTA) + 1 loose than (broken IDUMOTA bale) + 2 Kano thans
  assert.equal(fmt([row(2), row(1), row(3, 'Kano office'), row(3, 'Kano office')]), '1B + 3t');
});

test('several whole bales stay bales', () => {
  const world = [row(10), row(11), row(12)];
  const r = svc.buildBaleRoster(world);
  assert.equal(svc.formatQty(world, { thanWarehouses: THAN_WH, roster: r }), '3B');
});

test('without a roster it degrades to whole-bale counting (pre-TV-8)', () => {
  assert.equal(svc.formatQty([row(1), row(1)], { thanWarehouses: THAN_WH }), '1B');
});

test('than-visibility matching is case- and space-insensitive', () => {
  assert.equal(fmt([row(3, '  KANO OFFICE ')]), '1t');
});

test('an empty row set renders the empty marker', () => {
  assert.equal(fmt([]), '0B');
  assert.equal(svc.formatQty([], { empty: '—' }), '—');
});

test('the roster key separates containers, so a re-used number stays whole', () => {
  // Same printed number 5 in two containers: each is its own physical bale.
  const world = [row(5, 'IDUMOTA', 'Jul26'), row(5, 'IDUMOTA', 'Mar26')];
  const r = svc.buildBaleRoster(world);
  assert.equal(svc.formatQty([row(5, 'IDUMOTA', 'Jul26')], { thanWarehouses: THAN_WH, roster: r }), '1B',
    'the Jul26 bale is whole even though Mar26 shares its number');
});

/* ── CARD-5: formatCounts — already-decided counts, same grammar ────── */

test('formatCounts renders decided counts in the one grammar', () => {
  assert.equal(svc.formatCounts({ bales: 7, thans: 0 }), '7B');
  assert.equal(svc.formatCounts({ bales: 0, thans: 28 }), '28t');
  assert.equal(svc.formatCounts({ bales: 4, thans: 8 }), '4B + 8t');
  assert.equal(svc.formatCounts({}), '', 'both zero → empty by default');
  assert.equal(svc.formatCounts({ bales: 0, thans: 0, empty: '0B' }), '0B');
  assert.equal(svc.formatCounts({ bales: 'x', thans: NaN }), '', 'junk counts as 0');
});

test('createQtyLabeller resolves the than-set once and returns a sync labeller', async () => {
  const orig = svc.getThanVisibilityWarehouses;
  svc.getThanVisibilityWarehouses = async () => THAN_WH;
  try {
    const label = await svc.createQtyLabeller(WORLD);
    assert.equal(typeof label, 'function');
    assert.equal(label([row(2)]), '1B');
    assert.equal(label([row(1), row(1)]), '2t');
  } finally { svc.getThanVisibilityWarehouses = orig; }
});
