'use strict';
// CUS-3 — a store's pickers offer that store's customers (Customers column N),
// buyers first, the never-bought last as 🆕; an approved sale stamps the cell.
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const SRC = path.join(__dirname, '..', '..', '..', 'src');
const scope = require(path.join(SRC, 'services/customerScope'));
const repo = require(path.join(SRC, 'repositories/customersRepository'));

const C = [
  { customer_id: 'c1', name: 'Kafaya', status: 'Active', stores: ['Lagos', 'IDUMOTA'], first_sale_at: '2026-08-01' },
  { customer_id: 'c2', name: 'ABBA', status: 'Active', stores: ['Kano office'], first_sale_at: '2026-07-03' },
  { customer_id: 'c3', name: 'CJE', status: 'Active', stores: ['Lagos'], first_sale_at: '2026-06-01' },
  { customer_id: 'c4', name: 'Musa Textiles', status: 'Active', stores: ['Kano office'], first_sale_at: '' },
  { customer_id: 'c5', name: 'Unplaced Ltd', status: 'Active', stores: [], first_sale_at: '' },
  { customer_id: 'c6', name: 'Gone', status: 'inactive', stores: ['Kano office'], first_sale_at: '2026-01-01' },
];

test('forStore: the store\'s buyers first, its never-bought last as 🆕, an unplaced customer everywhere, no inactive', () => {
  const kano = scope.forStore(C, 'kano office');
  assert.deepEqual(kano.buyers.map((c) => c.name), ['ABBA']);
  assert.deepEqual(kano.fresh.map((c) => c.name), ['Musa Textiles', 'Unplaced Ltd']);
  assert.deepEqual(kano.all.map(scope.chipLabel), ['👤 ABBA', '🆕 Musa Textiles', '🆕 Unplaced Ltd']);
  const lagos = scope.forStore(C, 'Lagos');
  assert.deepEqual(lagos.all.map((c) => c.name), ['CJE', 'Kafaya', 'Unplaced Ltd'], 'Kafaya at Lagos, not at Kano');
  assert.deepEqual(scope.forStore(C, 'IDUMOTA').buyers.map((c) => c.name), ['Kafaya']);
  assert.deepEqual(scope.forStore(C, '').all.map((c) => c.name), ['ABBA', 'CJE', 'Kafaya', 'Musa Textiles', 'Unplaced Ltd'], 'no store → everyone, buyers first');
  assert.equal(scope.chipLabel(C[1], '⭐'), '⭐ ABBA');
});

test('noteSale: the store joins the cell once, the first sale is stamped once, never on an unknown name', async () => {
  const rows = C.map((c) => ({ ...c, stores: c.stores.slice() }));
  repo.getAll = async () => rows.map((r) => ({ ...r }));
  const writes = [];
  repo.setStores = async (id, stores) => { writes.push(['stores', id, stores.join(', ')]); rows.find((r) => r.customer_id === id).stores = stores; return true; };
  repo.noteFirstSale = async (id, d) => { writes.push(['first', id, d.slice(0, 10)]); rows.find((r) => r.customer_id === id).first_sale_at = d; return true; };
  // Kafaya buys at Kano for the first time: Kano joins her cell; her first sale stays as it was.
  assert.equal(await scope.noteSale({ name: 'kafaya', stores: ['Kano office', 'Lagos'], soldDate: '2026-10-19' }), true);
  // Musa Textiles' first ever sale, at the store already on file: only the stamp.
  await scope.noteSale({ name: 'Musa Textiles', stores: ['Kano office'], soldDate: '2026-10-19' });
  // Nothing new → no write.
  await scope.noteSale({ name: 'ABBA', stores: ['Kano office'], soldDate: '2026-10-19' });
  assert.equal(await scope.noteSale({ name: 'Nobody', stores: ['Lagos'] }), false);
  assert.deepEqual(writes, [
    ['stores', 'c1', 'Lagos, IDUMOTA, Kano office'],
    ['first', 'c4', '2026-10-19'],
  ]);
});
