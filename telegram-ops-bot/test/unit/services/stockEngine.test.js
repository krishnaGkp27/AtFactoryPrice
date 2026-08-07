'use strict';

/**
 * STK-E1 — stockEngine: THE one door to stock state. Every mutation must
 * name its event and its authority; the movement kind derives from the
 * event so a correction can never pose as a customer return again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const engine = require(path.join(SRC, 'services/stockEngine'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));

test('a mutation without event or authority is refused before any write', async () => {
  const calls = [];
  const orig = inventoryRepository.markPackageAvailable;
  inventoryRepository.markPackageAvailable = async (...a) => { calls.push(a); return []; };
  try {
    await assert.rejects(() => engine.returnPackage('869', {}, null), /authority required/);
    await assert.rejects(() => engine.returnPackage('869', {}, { event: 'party', adminId: '7' }), /unknown event/);
    await assert.rejects(() => engine.returnPackage('869', {}, { event: 'return' }), /no authority/);
    await assert.rejects(() => engine.returnPackage('869', {}, { event: 'sale', adminId: '7' }), /must be 'return' or 'correction'/);
    assert.equal(calls.length, 0, 'nothing reached the repository');
  } finally {
    inventoryRepository.markPackageAvailable = orig;
  }
});

test('the movement kind derives from the EVENT — RET-2 is structural now', async () => {
  const seen = [];
  const orig = inventoryRepository.markPackageAvailable;
  inventoryRepository.markPackageAvailable = async (pkg, opts) => { seen.push(opts); return []; };
  try {
    await engine.returnPackage('869', { warehouse: 'IDUMOTA' }, { event: 'return', approvalId: 'REQ-1' });
    await engine.returnPackage('869', {}, { event: 'correction', adminId: '777' });
    assert.equal(seen[0].kind, 'return');
    assert.equal(seen[0].warehouse, 'IDUMOTA', 'caller opts ride through');
    assert.equal(seen[0].user, 'approval:REQ-1', 'the authority is the actor on the movement row');
    assert.equal(seen[1].kind, 'correction');
    assert.equal(seen[1].user, '777');
  } finally {
    inventoryRepository.markPackageAvailable = orig;
  }
});

test('transitions accept only transfer events and stamp their kind', async () => {
  const seen = [];
  const orig = inventoryRepository.transitionBales;
  inventoryRepository.transitionBales = async (p, f, t, w, opts) => { seen.push(opts); return []; };
  try {
    await engine.transition(['869'], 'available', 'in_transit', 'Kano office',
      { uids: ['U1'], ref: 'TR-1' }, { event: 'dispatch', adminId: '888' });
    assert.equal(seen[0].kind, 'dispatch');
    assert.equal(seen[0].ref, 'TR-1');
    await engine.transition(['869'], 'in_transit', 'available', null,
      {}, { event: 'repair', system: 'transferRepair' });
    assert.equal(seen[1].kind, 'transfer', 'repair logs as the neutral transfer kind');
    await assert.rejects(
      () => engine.transition(['869'], 'available', 'sold', null, {}, { event: 'sale', adminId: '7' }),
      /transfer event/);
  } finally {
    inventoryRepository.transitionBales = orig;
  }
});

test('births demand the intake event; renames demand rename', async () => {
  const origB = inventoryRepository.appendBale;
  const origR = inventoryRepository.renameWarehouse;
  inventoryRepository.appendBale = async (rows) => rows.length;
  inventoryRepository.renameWarehouse = async () => 3;
  try {
    assert.equal(await engine.intakeBale([{}, {}], { event: 'intake', approvalId: 'R' }), 2);
    await assert.rejects(() => engine.intakeBale([{}], { event: 'sale', adminId: '7' }), /must be 'intake'/);
    assert.equal(await engine.renameWarehouse('Lagos', 'Lagos Main', { event: 'rename', approvalId: 'R' }), 3);
    await assert.rejects(() => engine.renameWarehouse('a', 'b', { event: 'intake', adminId: '7' }), /must be 'rename'/);
  } finally {
    inventoryRepository.appendBale = origB;
    inventoryRepository.renameWarehouse = origR;
  }
});
