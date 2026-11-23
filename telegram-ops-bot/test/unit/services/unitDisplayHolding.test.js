'use strict';

/**
 * TV-9 (owner, 23-Nov-2026) — the HOLDING mode of the quantity engine:
 * what a store holds now, closed bale = B, opened bale = its thans as t, in
 * every store, than-selling ones included. Without `holding` the engine
 * prints exactly what it printed before (a than-store row is +1t).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const uds = require('../../../src/services/unitDisplayService');

const KANO = new Set(['kano office']);

function than(pkg, n, warehouse, status = 'available', batch = 'Jul26') {
  return { design: '9006', shade: 'BLACK', packageNo: pkg, thanNo: n, warehouse, status, arrivalBatch: batch };
}
const bale = (pkg, wh, count, statusOf = () => 'available') =>
  Array.from({ length: count }, (_, i) => than(pkg, i + 1, wh, statusOf(i + 1)));

const ALL = [
  ...bale('801', 'Kano office', 5),                                  // closed
  ...bale('802', 'Kano office', 5, (t) => (t <= 2 ? 'sold' : 'available')), // opened, 3 left
  ...bale('803', 'Kano office', 5, () => 'sold'),                    // sold out
  ...bale('901', 'IDUMOTA', 5),
  ...bale('902', 'IDUMOTA', 5, (t) => (t === 1 ? 'sold' : 'available')),
];
const roster = uds.buildBaleRoster(ALL);
const avail = (wh) => ALL.filter((r) => r.status === 'available' && r.warehouse === wh);
const opts = (extra = {}) => ({ thanWarehouses: KANO, roster, ...extra });

test('holding: a closed bale in a than-selling store is 1B', () => {
  assert.equal(uds.formatQty(avail('Kano office').filter((r) => r.packageNo === '801'), opts({ holding: true })), '1B');
});

test('holding: an opened bale counts its remaining thans', () => {
  assert.equal(uds.formatQty(avail('Kano office').filter((r) => r.packageNo === '802'), opts({ holding: true })), '3t');
});

test('holding: a sold-out bale prints nothing for it (no available rows)', () => {
  assert.equal(uds.formatQty(avail('Kano office'), opts({ holding: true })), '1B + 3t', '803 adds nothing');
  assert.deepEqual(uds.countQty(avail('Kano office'), opts({ holding: true })), { bales: 1, thans: 3 });
});

test('the MOST important: the same Kano rows WITHOUT holding still print thans only', () => {
  assert.equal(uds.formatQty(avail('Kano office'), opts()), '8t');
  assert.deepEqual(uds.countQty(avail('Kano office'), opts()), { bales: 0, thans: 8 });
});

test('a store that is NOT than-selling prints the same text with and without holding', () => {
  assert.equal(uds.formatQty(avail('IDUMOTA'), opts()), '1B + 4t');
  assert.equal(uds.formatQty(avail('IDUMOTA'), opts({ holding: true })), '1B + 4t');
});

test('holding: a bale whose thans sit in two stores reads as loose thans in each', () => {
  const rows = [...bale('951', 'Lagos', 3), ...bale('951', 'IDUMOTA', 5).slice(3)];
  const r = uds.buildBaleRoster(rows);
  const o = { thanWarehouses: KANO, roster: r, holding: true };
  assert.equal(uds.formatQty(rows.filter((x) => x.warehouse === 'Lagos'), o), '3t');
  assert.equal(uds.formatQty(rows.filter((x) => x.warehouse === 'IDUMOTA'), o), '2t');
});

test('TV-9 review: rows of SEVERAL stores add up to each store\'s own holding — a split bale is never 1B', () => {
  const rows = [...bale('805', 'Kano office', 3), ...bale('805', 'IDUMOTA', 5).slice(3)];
  const o = { thanWarehouses: KANO, roster: uds.buildBaleRoster(rows), holding: true };
  assert.equal(uds.formatQty(rows, o), '5t', 'both stores at once: 3t + 2t, not 1B');
  assert.equal(uds.formatQty(rows, { ...o, holding: false }), '5t', 'without holding: unchanged');
  const held = (wh) => uds.countQty(rows.filter((r) => r.warehouse === wh), o);
  assert.deepEqual(uds.countQty(rows, o), { bales: 0, thans: held('Kano office').thans + held('IDUMOTA').thans });
});

test('TV-9 review: a row with no printed bale number is a loose than in holding mode, never a bale', () => {
  const noUid = [1, 2, 3].map((n) => ({ ...than('', n, 'Kano office'), baleUid: '' }));
  const withUid = [1, 2].map((n) => ({ ...than('', n, 'Kano office'), baleUid: `U${n}` }));
  const rows = [...noUid, ...withUid];
  const o = { thanWarehouses: KANO, roster: uds.buildBaleRoster(rows), holding: true };
  assert.equal(uds.formatQty(noUid, o), '3t');
  assert.equal(uds.formatQty(withUid, o), '2t');
  assert.equal(uds.formatQty(rows, { ...o, holding: false }), '5t', 'Kano without holding: unchanged');
});

test('holding: a one-than bale is 1B', () => {
  const rows = bale('700', 'Kano office', 1);
  const o = { thanWarehouses: KANO, roster: uds.buildBaleRoster(rows), holding: true };
  assert.equal(uds.formatQty(rows, o), '1B');
  assert.equal(uds.formatQty(rows, { ...o, holding: false }), '1t', 'without holding it is a than');
});

test('an empty set prints the `empty` option (default 0B), in both modes', () => {
  assert.equal(uds.formatQty([], opts({ holding: true })), '0B');
  assert.equal(uds.formatQty([], opts({ holding: true, empty: '—' })), '—');
  assert.deepEqual(uds.countQty([], opts({ holding: true })), { bales: 0, thans: 0 });
});

test('no roster: every bale\'s rows count as the whole bale (the pre-TV-8 degradation)', () => {
  // Without a roster the engine cannot know a bale was opened, so 802's
  // three remaining thans read as one bale.
  assert.equal(uds.formatQty(avail('Kano office'), { thanWarehouses: KANO, holding: true }), '2B');
  assert.equal(uds.formatQty(avail('Kano office'), { thanWarehouses: KANO }), '8t', 'unchanged without holding');
});

test('createQtyLabeller: label(rows, {holding}) and label.count agree with formatQty / countQty', async () => {
  const prev = uds.getThanVisibilityWarehouses;
  // The labeller resolves the set through the module's own cache; stub the
  // Settings read it rides on.
  const settingsRepository = require('../../../src/repositories/settingsRepository');
  const prevAll = settingsRepository.getAll;
  settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
  uds.invalidateCache();
  try {
    const label = await uds.createQtyLabeller(ALL);
    assert.equal(label(avail('Kano office')), '8t');
    assert.equal(label(avail('Kano office'), { holding: true }), '1B + 3t');
    assert.deepEqual(label.count(avail('Kano office'), { holding: true }), { bales: 1, thans: 3 });
    assert.deepEqual(label.count(avail('Kano office')), { bales: 0, thans: 8 });
  } finally {
    settingsRepository.getAll = prevAll;
    uds.getThanVisibilityWarehouses = prev;
    uds.invalidateCache();
  }
});
