'use strict';

/**
 * CRM-R1 — customers by region. The split from the Locations register and
 * the stores cell; buyers before prospects; the buckets; the viewer scope
 * (admin = all, employee = the regions of their own stores); paging with the
 * A–Al range; the card line; the Back memory.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const locationService = require(path.join(SRC, 'services/locationService'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const region = require(path.join(SRC, 'services/customerRegion'));

locationService.allPlaces = async () => [
  { name: 'Lagos', location: 'Lagos', kind: 'warehouse', status: 'active', registered: true },
  { name: 'IDUMOTA', location: 'Lagos', kind: 'store', status: 'active', registered: true },
  { name: 'Kano office', location: 'Kano', kind: 'store', status: 'active', registered: true },
  { name: 'Ketu', location: '', kind: 'warehouse', status: 'active', registered: false },
];
const USERS = {
  4242: { user_id: '4242', name: 'Muhammad', warehouses: ['Kano office'] },
  4343: { user_id: '4343', name: 'Kafaya', warehouses: ['IDUMOTA', 'Kano office'] },
  4444: { user_id: '4444', name: 'Nobody', warehouses: [] },
};
usersRepository.findByUserId = async (id) => USERS[id] || null;

const c = (name, stores, first, status = 'Active') => ({ customer_id: `c-${name}`, name, stores, first_sale_at: first, status });
const CUSTOMERS = [
  c('Kafaya Ltd', ['Lagos', 'IDUMOTA'], '2026-08-01'),
  c('ABBA', ['Kano office'], '2026-07-03'),
  c('Abdul Gayinu', ['Kano office'], ''),          // prospect, placed
  c('Musa Textiles', ['Ketu'], '2026-06-01'),      // store not in any city
  c('Unplaced Ltd', [], '2026-05-01'),             // buyer, no store
  c('Zara', [], ''),                               // prospect, no store
  c('Both Cities', ['IDUMOTA', 'Kano office'], '2026-09-09'),
  c('Gone Ltd', ['Kano office'], '2026-01-01', 'inactive'),
];

test('regionMap: cities from the register; an unregistered place is in no region', async () => {
  const m = await region.regionMap();
  assert.deepEqual(m.regions.map((r) => r.name), ['Kano', 'Lagos']);
  assert.deepEqual(m.regions.find((r) => r.name === 'Lagos').places, ['IDUMOTA', 'Lagos']);
  assert.equal(m.placeRegion.get('KANO OFFICE'), 'Kano');
  assert.equal(m.placeRegion.get('KETU'), undefined);
});

test('classify: regions largest first, buyers before prospects, both-city customers in both, inactive out', async () => {
  const m = await region.regionMap();
  const k = region.classify(CUSTOMERS, m);
  assert.deepEqual(k.regions.map((r) => `${r.name} ${r.count}`), ['Kano 3', 'Lagos 2']);
  assert.deepEqual(k.byRegion.get('Kano').map((x) => x.name), ['ABBA', 'Both Cities', 'Abdul Gayinu']);
  assert.deepEqual(k.byRegion.get('Lagos').map((x) => x.name), ['Both Cities', 'Kafaya Ltd']);
  assert.deepEqual(k.prospects.map((x) => x.name), ['Abdul Gayinu', 'Zara']);
  assert.deepEqual(k.notPlaced.map((x) => x.name), ['Unplaced Ltd', 'Zara']);
  assert.equal(k.all.length, 7);
  assert.ok(!k.all.some((x) => x.name === 'Gone Ltd'));
});

test('viewer scope: admin = all; employee = the regions of their stores; none = []', async () => {
  const m = await region.regionMap();
  assert.equal(await region.viewerRegions('777', m.placeRegion), null);
  assert.deepEqual(await region.viewerRegions('4242', m.placeRegion), ['Kano']);
  assert.deepEqual((await region.viewerRegions('4343', m.placeRegion)).sort(), ['Kano', 'Lagos']);
  assert.deepEqual(await region.viewerRegions('4444', m.placeRegion), []);
  assert.deepEqual(await region.viewerRegions('9999', m.placeRegion), []);
  assert.equal(region.mayTouch(null, CUSTOMERS[0], m.placeRegion), true);
  assert.equal(region.mayTouch(['Kano'], CUSTOMERS[0], m.placeRegion), false, 'a Lagos buyer is not Kano staff\'s to touch');
  assert.equal(region.mayTouch(['Kano'], CUSTOMERS[2], m.placeRegion), true);
  assert.equal(region.mayTouch(['Kano'], CUSTOMERS[5], m.placeRegion), true, 'not placed → anyone\'s to place');
});

test('page: eight a page, the A–Al range, clamped', () => {
  const list = ['A G Y L', 'A.U NAMA', 'ABBA', 'Ahmad', 'Alabi', 'Alabi johnson', 'Alhaja Ochidi', 'Alhaja oshodi', 'Amina', 'Bello', 'Zara']
    .map((name) => ({ name, first_sale_at: '2026-01-01' }));
  const p1 = region.page(list, 0);
  assert.deepEqual([p1.page, p1.pages, p1.total, p1.items.length, p1.range], [0, 2, 11, 8, 'A–Al']);
  const p2 = region.page(list, 1);
  assert.deepEqual([p2.page, p2.items.map((x) => x.name), p2.range], [1, ['Amina', 'Bello', 'Zara'], 'Am–Za']);
  assert.equal(region.page(list, 9).page, 1, 'clamped to the last page');
  assert.equal(region.page([], 0).pages, 1);
});

test('the card line and the Back memory', () => {
  assert.equal(region.storesLine(CUSTOMERS[0]), '🏙 Lagos · IDUMOTA');
  assert.equal(region.storesLine(CUSTOMERS[2]), '🏙 Kano office · provisional');
  assert.equal(region.storesLine(CUSTOMERS[4]), '🏙 Not placed yet');
  region._resetForTests();
  assert.equal(region.navOf('777'), null);
  region.rememberNav('777', { key: 'Kano', page: 2 });
  assert.deepEqual(region.navOf('777'), { key: 'Kano', page: 2 });
});
