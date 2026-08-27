'use strict';

/**
 * IDR-4 — approve = record created AND Telegram account bound.
 *
 * Drives the REAL executor by request id (the way approvalEvents does) and
 * pins the promises the queue's ➕ shortcuts make:
 *   - register_marketer with a pending account → marketer active + linked
 *   - add_contact (customer) with a pending account → CRM entity + linked
 *   - a link failure NEVER un-approves the record, but is said out loud
 *   - the same actions WITHOUT a pending account never touch the register
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_IDS = '777,888';

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const marketersRepo = require(path.join(SRC, 'repositories/marketersRepository'));
const contactsRepository = require(path.join(SRC, 'repositories/contactsRepository'));
const crmService = require(path.join(SRC, 'services/crmService'));
const identityService = require(path.join(SRC, 'services/identityService'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));

auditLogRepository.append = async () => {};
approvalQueueRepository.updateStatus = async () => true;
approvalQueueRepository.setStatus = async () => true;

marketersRepo.findByApprovalRequestId = async () => ({ rowIndex: 2, marketer_id: 'MKR-7', name: 'Goku' });
marketersRepo.updateStatus = async () => true;
contactsRepository.append = async (c) => ({ ...c, contact_id: 'CNT-4' });
crmService.addCustomer = async () => ({ status: 'created', customer: { customer_id: 'CUST-9' } });

let LINKS = [];
let LINK_RESULT = { ok: true };
identityService.link = async (tgId, spec, by) => { LINKS.push({ tgId, spec, by }); return LINK_RESULT; };

async function execute(requestId, aj) {
  approvalQueueRepository.getAllPending = async () => ([{
    requestId, user: '900', status: 'pending', actionJSON: aj,
  }]);
  return inventoryService.executeApprovedAction(requestId, '777');
}

test('register_marketer + pending account: active AND linked as marketer', async () => {
  LINKS = []; LINK_RESULT = { ok: true };
  const res = await execute('R1', {
    action: 'register_marketer', name: 'Goku', pendingTelegramId: '7034987385',
  });
  assert.equal(res.ok, true);
  assert.equal(LINKS.length, 1, 'exactly one register write');
  assert.deepEqual(LINKS[0], {
    tgId: '7034987385',
    spec: { type: 'marketer', id: 'MKR-7', name: 'Goku' },
    by: '777',
  });
  assert.match(res.message, /linked/i, 'the approving admin is told it linked');
});

test('add_contact raised as customer + pending account: entity AND linked as customer', async () => {
  LINKS = []; LINK_RESULT = { ok: true };
  const res = await execute('R2', {
    action: 'add_contact', type: 'customer', name: 'Goku', phone: '080',
    pendingTelegramId: '7034987385',
  });
  assert.equal(res.ok, true);
  assert.equal(LINKS.length, 1);
  assert.deepEqual(LINKS[0].spec, { type: 'customer', id: 'CUST-9', name: 'Goku' });
  assert.match(res.message, /CUSTOMER/, 'CON-1 result text intact');
  assert.match(res.message, /linked/i);
});

test('a register hiccup never un-approves — it is reported, not thrown', async () => {
  LINKS = []; LINK_RESULT = { ok: false, reason: 'no register row for that account' };
  const res = await execute('R3', {
    action: 'register_marketer', name: 'Goku', pendingTelegramId: '7034987385',
  });
  assert.equal(res.ok, true, 'the marketer is still approved');
  assert.match(res.message, /link failed/i, 'and the failure is said out loud');
});

test('the same approvals WITHOUT a pending account never touch the register', async () => {
  LINKS = [];
  const r1 = await execute('R4', { action: 'register_marketer', name: 'Solo' });
  const r2 = await execute('R5', { action: 'add_contact', type: 'customer', name: 'Walk-in' });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(LINKS.length, 0, 'no phantom identity writes');
});
