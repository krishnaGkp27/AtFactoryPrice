'use strict';

/**
 * TV-2 — unitDisplayService.computeWarehouseCsv / setWarehouseMode and the
 * executeApprovedAction('set_unit_display') branch. Repos are stubbed; no
 * sheets are touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const unitDisplayService = require('../../../src/services/unitDisplayService');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');

auditLogRepository.append = async () => {};   // success-tail audit write

// ---- computeWarehouseCsv (pure) ----

test('computeWarehouseCsv: thans adds the warehouse once (idempotent)', () => {
  assert.equal(unitDisplayService.computeWarehouseCsv('', 'Kano office', 'thans'), 'Kano office');
  assert.equal(unitDisplayService.computeWarehouseCsv('Kano office', 'Kano office', 'thans'), 'Kano office');
  assert.equal(unitDisplayService.computeWarehouseCsv('KANO OFFICE', 'Kano office', 'thans'), 'Kano office');
});

test('computeWarehouseCsv: bales removes the warehouse case-insensitively', () => {
  assert.equal(unitDisplayService.computeWarehouseCsv('Kano office', 'KANO office', 'bales'), '');
  assert.equal(unitDisplayService.computeWarehouseCsv('Lagos, Kano office', 'Kano office', 'bales'), 'Lagos');
});

test('computeWarehouseCsv: preserves other entries and their casing', () => {
  assert.equal(
    unitDisplayService.computeWarehouseCsv('Idumota Store, Kano office', 'Chinos Store', 'thans'),
    'Idumota Store, Kano office, Chinos Store');
  assert.equal(
    unitDisplayService.computeWarehouseCsv('Idumota Store, Kano office', 'Idumota store', 'bales'),
    'Kano office');
});

test('computeWarehouseCsv: non-string csv treated as empty', () => {
  assert.equal(unitDisplayService.computeWarehouseCsv(0, 'Kano office', 'thans'), 'Kano office');
  assert.equal(unitDisplayService.computeWarehouseCsv(undefined, 'Kano office', 'bales'), '');
});

// ---- setWarehouseMode ----

function stubSettings(current) {
  const writes = [];
  settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: current });
  settingsRepository.set = async (key, value) => { writes.push({ key, value }); return { key, value }; };
  unitDisplayService.invalidateCache();
  return writes;
}

test('setWarehouseMode: writes the new CSV and takes effect immediately', async () => {
  const writes = stubSettings('Kano office');
  await unitDisplayService.setWarehouseMode('Kano office', 'bales');
  assert.deepEqual(writes, [{ key: 'THAN_VISIBILITY_WAREHOUSES', value: '' }]);
  // Cache invalidated → next read sees the (stubbed) current value again;
  // just assert no throw and the write happened.
});

test('setWarehouseMode: validates inputs', async () => {
  stubSettings('');
  await assert.rejects(() => unitDisplayService.setWarehouseMode('', 'thans'), /warehouse required/);
  await assert.rejects(() => unitDisplayService.setWarehouseMode('Kano office', 'yards'), /mode must be/);
});

// ---- executeApprovedAction branch ----

test('executeApprovedAction(set_unit_display): applies requested end-state', async () => {
  const writes = stubSettings('');
  approvalQueueRepository.getAllPending = async () => [{
    requestId: 'R-TV2', user: 'manager-1',
    actionJSON: { action: 'set_unit_display', warehouse: 'Kano office', mode: 'thans' },
  }];
  approvalQueueRepository.updateStatus = async () => {};
  const res = await inventoryService.executeApprovedAction('R-TV2', 'admin-2');
  assert.equal(res.ok, true);
  assert.deepEqual(writes, [{ key: 'THAN_VISIBILITY_WAREHOUSES', value: 'Kano office' }]);
});

test('executeApprovedAction(set_unit_display): invalid mode surfaces as failure', async () => {
  stubSettings('');
  approvalQueueRepository.getAllPending = async () => [{
    requestId: 'R-BAD', user: 'manager-1',
    actionJSON: { action: 'set_unit_display', warehouse: 'Kano office', mode: 'yards' },
  }];
  approvalQueueRepository.updateStatus = async () => {};
  await assert.rejects(() => inventoryService.executeApprovedAction('R-BAD', 'admin-2'), /mode must be/);
});
