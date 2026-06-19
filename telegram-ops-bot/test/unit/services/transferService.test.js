'use strict';

/**
 * TRF-1 — transferService: pure bale-selection helpers + lifecycle
 * orchestration (create / dispatch / confirmReceipt / abort). Repos are
 * stubbed; no sheets are touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const transferService = require('../../../src/services/transferService');
const transfersRepo = require('../../../src/repositories/transfersRepository');
const inventoryRepo = require('../../../src/repositories/inventoryRepository');

// A small inventory snapshot. packageNo = bale; one than each unless noted.
const INV = [
  { packageNo: 'P1', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'available' },
  { packageNo: 'P2', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'available' },
  { packageNo: 'P3', design: 'Rose', shade: 'Red', warehouse: 'Lagos', status: 'sold' },
  { packageNo: 'P4', design: 'Rose', shade: 'Red', warehouse: 'Kano', status: 'available' },
  { packageNo: 'P5', design: 'Lily', shade: 'Blue', warehouse: 'Lagos', status: 'available' },
  // P6 has two thans — must still count as a single bale.
  { packageNo: 'P6', design: 'Lily', shade: 'Blue', warehouse: 'Lagos', status: 'available' },
  { packageNo: 'P6', design: 'Lily', shade: 'Blue', warehouse: 'Lagos', status: 'available' },
];

// ---- pure helpers --------------------------------------------------------

test('availableBales: distinct, status+warehouse+design+shade filtered', () => {
  const bales = transferService.availableBales(INV, 'Lagos', 'Rose', 'Red');
  assert.deepEqual(bales, ['P1', 'P2']); // P3 sold, P4 in Kano
  const lily = transferService.availableBales(INV, 'Lagos', 'Lily', 'Blue');
  assert.deepEqual(lily, ['P5', 'P6']); // P6 collapsed to one
});

test('selectByQuantity: picks the first N bales per request', () => {
  const res = transferService.selectByQuantity(INV, 'Lagos', [
    { design: 'Rose', shade: 'Red', qty: 2 },
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.shortfalls, []);
  assert.deepEqual(res.items, [{ design: 'Rose', shade: 'Red', qty: 2, bales: ['P1', 'P2'] }]);
});

test('selectByQuantity: reports shortfall when not enough bales', () => {
  const res = transferService.selectByQuantity(INV, 'Lagos', [
    { design: 'Rose', shade: 'Red', qty: 5 },
  ]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.shortfalls, [{ design: 'Rose', shade: 'Red', requested: 5, available: 2 }]);
  // still returns the bales it could find
  assert.deepEqual(res.items[0].bales, ['P1', 'P2']);
});

test('selectByBaleNumbers: groups by design+shade, ignores invalid', () => {
  const res = transferService.selectByBaleNumbers(INV, 'Lagos', ['P1', 'P5', 'P3', 'P4', 'PX']);
  assert.equal(res.ok, false);            // P3 (sold), P4 (Kano), PX (missing)
  assert.deepEqual(res.missing.sort(), ['P3', 'P4', 'PX']);
  const rose = res.items.find((i) => i.design === 'Rose');
  const lily = res.items.find((i) => i.design === 'Lily');
  assert.deepEqual(rose.bales, ['P1']);
  assert.deepEqual(lily.bales, ['P5']);
});

test('selectByBaleNumbers: all valid → ok', () => {
  const res = transferService.selectByBaleNumbers(INV, 'Lagos', ['P1', 'P2']);
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.items[0].bales, ['P1', 'P2']);
});

// ---- lifecycle orchestration --------------------------------------------

/** Install repo stubs; returns a calls recorder + lets the test seed transfers. */
function stub(initialTransfer) {
  const calls = { transitions: [], updates: [], appended: null };
  let current = initialTransfer ? { ...initialTransfer } : null;

  inventoryRepo.transitionBales = async (pkgs, from, to, wh) => {
    calls.transitions.push({ pkgs, from, to, wh });
    return [];
  };
  transfersRepo.append = async (t) => { calls.appended = t; current = { ...t }; return t; };
  transfersRepo.findById = async () => (current ? { ...current } : null);
  transfersRepo.update = async (id, patch) => {
    calls.updates.push({ id, patch });
    current = { ...current, ...patch };
    return { ...current };
  };
  return calls;
}

test('createTransfer: moves bales available→in_transit @ dest, appends requested row', async () => {
  const calls = stub();
  const t = await transferService.createTransfer({
    fromWarehouse: 'Lagos',
    toWarehouse: 'Kano',
    items: [{ design: 'Rose', shade: 'Red', qty: 2, bales: ['P1', 'P2'] }],
    requestedBy: 'admin1',
    sourcePerson: 'abdul',
    destPerson: 'kano1',
  });
  assert.match(t.transfer_id, /^TR-/);
  assert.equal(t.status, 'requested');
  assert.equal(calls.transitions.length, 1);
  assert.deepEqual(calls.transitions[0], {
    pkgs: ['P1', 'P2'], from: 'available', to: 'in_transit', wh: 'Kano',
  });
  assert.equal(calls.appended.source_person, 'abdul');
  assert.equal(calls.appended.dest_person, 'kano1');
});

test('dispatch: requested → in_transit, stamps dispatched_at', async () => {
  const calls = stub({ transfer_id: 'TR-1', status: 'requested' });
  const res = await transferService.dispatch('TR-1');
  assert.equal(res.ok, true);
  assert.equal(res.transfer.status, 'in_transit');
  assert.ok(calls.updates[0].patch.dispatched_at);
});

test('dispatch: rejects a non-requested transfer', async () => {
  stub({ transfer_id: 'TR-1', status: 'in_transit' });
  const res = await transferService.dispatch('TR-1');
  assert.equal(res.ok, false);
  assert.match(res.message, /cannot dispatch/);
});

test('confirmReceipt: in_transit → received, unlocks bales (no wh change)', async () => {
  const calls = stub({
    transfer_id: 'TR-1', status: 'in_transit', to_warehouse: 'Kano',
    items: [{ design: 'Rose', shade: 'Red', qty: 2, bales: ['P1', 'P2'] }],
  });
  const res = await transferService.confirmReceipt('TR-1');
  assert.equal(res.ok, true);
  assert.equal(res.transfer.status, 'received');
  assert.deepEqual(calls.transitions[0], {
    pkgs: ['P1', 'P2'], from: 'in_transit', to: 'available', wh: null,
  });
});

test('confirmReceipt: rejects when not in_transit', async () => {
  stub({ transfer_id: 'TR-1', status: 'requested' });
  const res = await transferService.confirmReceipt('TR-1');
  assert.equal(res.ok, false);
});

test('abort (decline): reverts bales to source, status cancelled', async () => {
  const calls = stub({
    transfer_id: 'TR-1', status: 'requested', from_warehouse: 'Lagos',
    items: [{ design: 'Rose', shade: 'Red', qty: 1, bales: ['P1'] }],
  });
  const res = await transferService.abort('TR-1', { reason: 'no stock', cancelled: true });
  assert.equal(res.ok, true);
  assert.equal(res.transfer.status, 'cancelled');
  assert.equal(res.transfer.note, 'no stock');
  assert.deepEqual(calls.transitions[0], {
    pkgs: ['P1'], from: 'in_transit', to: 'available', wh: 'Lagos',
  });
});

test('abort (reject): status declined when not cancelled', async () => {
  stub({
    transfer_id: 'TR-1', status: 'in_transit', from_warehouse: 'Lagos',
    items: [{ design: 'Rose', shade: 'Red', qty: 1, bales: ['P1'] }],
  });
  const res = await transferService.abort('TR-1', { reason: 'damaged' });
  assert.equal(res.ok, true);
  assert.equal(res.transfer.status, 'declined');
});

test('abort: refuses an already-terminal transfer', async () => {
  stub({ transfer_id: 'TR-1', status: 'received', items: [] });
  const res = await transferService.abort('TR-1', {});
  assert.equal(res.ok, false);
  assert.match(res.message, /already received/);
});
