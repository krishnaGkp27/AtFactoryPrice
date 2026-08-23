'use strict';

/**
 * MYP-2 — a linked person's tap raises a REAL supply request in the srf_
 * pipeline's exact record shape: stage dispatch_review, cart quantities =
 * remaining allocation, requester = their telegram id, provenance stamped.
 * One open request per (person, design, shade) — a second tap is refused.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const approvalEvents = require('../../../src/events/approvalEvents');
const myProductsService = require('../../../src/services/myProductsService');

let PENDING = [];
let appended = [];
let patched = [];
approvalQueueRepository.getAllPending = async () => PENDING;
approvalQueueRepository.appendOnce = async (rec) => { appended.push(rec); return { created: true }; };
approvalQueueRepository.updateActionJSON = async (id, patch) => { patched.push({ id, patch }); };
auditLogRepository.append = async () => {};
let dispatchNotified = 0; let adminsNotified = 0;
approvalEvents.notifyDispatchManagers = async () => { dispatchNotified += 1; return false; }; // no dispatch dept
approvalEvents.notifyAdminsApprovalRequest = async () => { adminsNotified += 1; };
myProductsService.sourceWarehouseFor = async () => 'Kano office';

const linkedSupplyService = require('../../../src/services/linkedSupplyService');
const fakeBot = { sendMessage: async () => ({}) };
const info = { telegramId: '900', type: 'marketer', linkId: 'MK-1', linkName: 'Owaibula' };

test('raise: srf-shaped record, dispatch-first with admin fallback, provenance stamped', async () => {
  PENDING = []; appended = []; patched = []; dispatchNotified = 0; adminsNotified = 0;
  const r = await linkedSupplyService.raise(fakeBot, info, [{ design: '9037', shade: '1', quantity: 11 }]);
  assert.equal(r.ok, true);
  assert.equal(appended.length, 1);
  const aj = appended[0].actionJSON;
  assert.equal(aj.action, 'supply_request');
  assert.equal(aj.stage, 'dispatch_review');
  assert.equal(aj.warehouse, 'Kano office', 'routed by their source warehouse, never shown to them');
  assert.deepEqual(aj.cart, [{ design: '9037', shade: '1', shadeName: '1', quantity: 11 }]);
  assert.equal(aj.customer, 'Owaibula');
  assert.equal(aj.raisedByLinked.telegramId, '900');
  assert.equal(appended[0].user, '900', 'the requester is the linked person');
  assert.equal(dispatchNotified, 1);
  // No dispatch users → the srf self-heal path: admin_review + admins told.
  assert.deepEqual(patched[0].patch, { stage: 'admin_review', dispatchSkipped: true });
  assert.equal(adminsNotified, 1);
});

test('an open request for the same design+shade refuses a second tap', async () => {
  appended = [];
  PENDING = [{
    user: '900', status: 'pending',
    actionJSON: { action: 'supply_request', cart: [{ design: '9037', shade: '1', quantity: 5 }] },
  }];
  const r = await linkedSupplyService.raise(fakeBot, info, [{ design: '9037', shade: '1', quantity: 6 }]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_requested');
  assert.equal(appended.length, 0, 'no second row');
});

test('zero-remaining lines are dropped; all-zero raises nothing', async () => {
  PENDING = []; appended = [];
  const r = await linkedSupplyService.raise(fakeBot, info, [{ design: '9037', shade: '3', quantity: 0 }]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'nothing_remaining');
  assert.equal(appended.length, 0);
});
