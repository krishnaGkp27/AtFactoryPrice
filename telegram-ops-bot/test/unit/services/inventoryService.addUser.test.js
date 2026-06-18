'use strict';

/**
 * MKT-1 — executeApprovedAction('add_user') must accept the new field roles
 * (marketer / salesman) and persist them with their warehouses, while still
 * rejecting unknown roles. Repos are stubbed; no sheets are touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const usersRepository = require('../../../src/repositories/usersRepository');
const departmentsRepository = require('../../../src/repositories/departmentsRepository');
const pendingUserService = require('../../../src/services/pendingUserService');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const auth = require('../../../src/middlewares/auth');

/** Install stubs and return the captured Users.append row (if any). */
function stub(actionJSON) {
  const captured = {};
  approvalQueueRepository.getAllPending = async () => [
    { requestId: 'R1', user: 'admin1', actionJSON },
  ];
  approvalQueueRepository.updateStatus = async () => {};     // success-tail marks resolved
  usersRepository.findByUserId = async () => null;           // no dup by default
  usersRepository.append = async (row) => { captured.row = row; };
  usersRepository.reactivate = async (id, fields) => { captured.reactivated = { id, fields }; return true; };
  departmentsRepository.findByName = async () => ({ dept_name: actionJSON.department });
  departmentsRepository.append = async () => {};
  pendingUserService.markOnboarded = async () => {};
  auditLogRepository.append = async () => {};
  auth.invalidate = async () => {};
  return captured;
}

const baseAj = (role) => ({
  action: 'add_user',
  telegram_id: '12345678',
  name: 'Field Person',
  department: 'Sales',
  role,
  warehouses: ['Lagos', 'Kano'],
});

test('approves a marketer and persists role + warehouses', async () => {
  const captured = stub(baseAj('marketer'));
  const res = await inventoryService.executeApprovedAction('R1', 'admin2', {});
  assert.equal(res.ok, true);
  assert.equal(captured.row.role, 'marketer');
  assert.deepEqual(captured.row.warehouses, ['Lagos', 'Kano']);
  assert.equal(captured.row.status, 'active');
});

test('re-onboarding an inactive user REACTIVATES the row (no duplicate append)', async () => {
  const captured = stub(baseAj('marketer'));
  // Existing INACTIVE row for this id → must reactivate in place, not append.
  usersRepository.findByUserId = async () => ({ user_id: '12345678', status: 'inactive', name: 'Old' });
  const res = await inventoryService.executeApprovedAction('R1', 'admin2', {});
  assert.equal(res.ok, true);
  assert.equal(captured.row, undefined, 'must NOT append a duplicate row');
  assert.equal(captured.reactivated.id, '12345678');
  assert.equal(captured.reactivated.fields.role, 'marketer');
  assert.deepEqual(captured.reactivated.fields.warehouses, ['Lagos', 'Kano']);
});

test('still rejects re-onboarding an already-ACTIVE user', async () => {
  const captured = stub(baseAj('marketer'));
  usersRepository.findByUserId = async () => ({ user_id: '12345678', status: 'active', name: 'Live' });
  const res = await inventoryService.executeApprovedAction('R1', 'admin2', {});
  assert.equal(res.ok, false);
  assert.match(res.message, /already an active user/i);
  assert.equal(captured.row, undefined);
  assert.equal(captured.reactivated, undefined);
});

test('approves a salesman', async () => {
  const captured = stub(baseAj('salesman'));
  const res = await inventoryService.executeApprovedAction('R1', 'admin2', {});
  assert.equal(res.ok, true);
  assert.equal(captured.row.role, 'salesman');
});

test('still rejects an unknown role', async () => {
  const captured = stub(baseAj('wizard'));
  const res = await inventoryService.executeApprovedAction('R1', 'admin2', {});
  assert.equal(res.ok, false);
  assert.match(res.message, /not allowed/i);
  assert.equal(captured.row, undefined); // never appended
});
