'use strict';
// NAV-3 (owner, 23-Nov-2026) — 🛒 Sales & Marketing is a DOOR onto the Supply
// Request, and its other tiles moved to their second most relevant homes by
// changing hub / parent fields only (codes, labels, icons, callbacks kept).
const test = require('node:test');
const assert = require('node:assert/strict');
const reg = require('../../../src/services/activityRegistry');

test('the sales module is a door onto supply_request, and supply_request lives there', () => {
  assert.equal(reg.getHub('sales').opens, 'supply_request');
  assert.equal(reg.doorOf('sales').code, 'supply_request');
  assert.equal(reg.getActivity('supply_request').hub, 'sales');
  assert.equal(reg.doorOf('inventory'), null, 'an ordinary module is not a door');
  assert.equal(reg.doorOf('nope'), null);
});

test('every door is a top-level module holding exactly its one activity, with no groups under it', () => {
  for (const h of reg.getHubs().filter((x) => x.opens)) {
    assert.equal(h.parent, undefined, `${h.id} is top level`);
    assert.ok(reg.getActivity(h.opens), `${h.id} opens a real activity`);
    assert.deepEqual(reg.getChildHubs(h.id), [], `${h.id} has no sub-hubs`);
    assert.deepEqual(reg.getAll().filter((a) => a.hub === h.id).map((a) => a.code), [h.opens], `${h.id} holds only ${h.opens}`);
  }
});

test('the three groups moved whole: same ids, same tiles, new parents; Inventory lists its groups as Add · Move · Warehouses · Designs', () => {
  assert.equal(reg.getHub('orders').parent, 'planning');
  assert.equal(reg.getHub('marketers').parent, 'crm');
  assert.equal(reg.getHub('designs').parent, 'inventory');
  const tilesOf = (hub) => reg.getAll().filter((a) => a.hub === hub).map((a) => a.code);
  assert.deepEqual(tilesOf('orders'), ['create_order', 'my_orders', 'mark_order_delivered']);
  assert.deepEqual(tilesOf('marketers'), ['register_marketer', 'supply_catalog', 'loan_catalog', 'return_catalog', 'catalog_tracker', 'manage_catalog_stock', 'allocate_marketer']);
  assert.deepEqual(tilesOf('designs'), ['upload_design_photo', 'manage_design_photos', 'shade_photos', 'browse_catalog', 'search_design_photo', 'catalog_stats', 'set_design_category']);
  assert.deepEqual(reg.getChildHubs('inventory').map((h) => h.id), ['stock_add', 'stock_move', 'warehouses', 'designs']);
  assert.deepEqual(reg.getChildHubs('crm').map((h) => h.id), ['marketers']);
  assert.deepEqual(reg.getChildHubs('planning').map((h) => h.id), ['orders']);
  assert.deepEqual(reg.getChildHubs('sales').map((h) => h.id), []);
});

test('the two selling tiles lead Inventory\'s own tiles, callbacks unchanged', () => {
  assert.deepEqual(reg.getAll().filter((a) => a.hub === 'inventory').map((a) => a.code).slice(0, 3), ['bundle_sale', 'sell_bale', 'check_stock']);
  assert.equal(reg.getActivity('bundle_sale').callback, 'act:bundle_sale');
  assert.equal(reg.getActivity('sell_bale').callback, 'act:sell_bale');
  assert.equal(reg.getByCallback('act:mark_delivered').code, 'mark_order_delivered');
});

test('groupByHub surfaces a door only for someone allowed its activity, and only that activity', () => {
  const pick = (...codes) => reg.filterByCodes(codes);
  const sales = (g) => g.hubs.find((x) => x.hub.id === 'sales');
  assert.deepEqual(sales(reg.groupByHub(pick('supply_request', 'my_orders'))).activities.map((a) => a.code), ['supply_request']);
  assert.equal(sales(reg.groupByHub(pick('my_orders', 'mark_order_delivered'))), undefined, 'no supply_request → no door');
  const planning = reg.groupByHub(pick('my_orders', 'mark_order_delivered')).hubs.find((x) => x.hub.id === 'planning');
  assert.deepEqual(planning.activities.map((a) => a.code), ['my_orders', 'mark_order_delivered'], 'Orders rolls up to Tasks & Planning');
  const inv = reg.groupByHub(pick('sell_bale')).hubs.find((x) => x.hub.id === 'inventory');
  assert.deepEqual(inv.activities.map((a) => a.code), ['sell_bale']);
});
