'use strict';
// SRF-6 — who may supply, and the two admin-card lines (supplier + waiting).
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const SRC = path.join(__dirname, '..', '..', '..', 'src');
const sa = require(path.join(SRC, 'services/supplyAssign'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));

const U = [
  { user_id: '1', name: 'Musa', status: 'active', departments: ['Dispatch'], warehouses: ['Lagos', 'IDUMOTA'] },
  { user_id: '2', name: 'Bello', status: 'active', departments: ['Warehouse'], warehouses: ['Kano office'] },
  { user_id: '3', name: 'Aisha', status: 'active', departments: ['Sales'], warehouses: ['Lagos'] },
  { user_id: '4', name: 'Gone', status: 'inactive', departments: ['Dispatch'], warehouses: ['Lagos'] },
  { user_id: '5', name: 'Umar', status: 'active', department: 'Logistics', warehouses: [] },
];

test('eligibleFor: dispatch departments, active, attached to the store; dispatchStaff ignores the store', () => {
  assert.deepEqual(sa.eligibleFor(U, 'lagos').map((u) => u.name), ['Musa']);
  assert.deepEqual(sa.eligibleFor(U, 'Kano office').map((u) => u.name), ['Bello']);
  assert.deepEqual(sa.eligibleFor(U, 'Abuja').map((u) => u.name), []);
  assert.deepEqual(sa.eligibleFor(U, '').map((u) => u.name), ['Musa', 'Bello', 'Umar'], 'no store = every dispatch person');
  assert.deepEqual(sa.dispatchStaff(U).map((u) => u.name), ['Musa', 'Bello', 'Umar']);
  assert.equal(sa.chipLabel(U[0]), '🧑 Musa');
});

test('supplierLine and waitingLine follow the stage', () => {
  assert.equal(sa.supplierLine({}), '🚚 Supplier: an admin will choose');
  assert.equal(sa.supplierLine({ requestedAssignee: { user_id: '1', name: 'Musa' } }), "🚚 To be supplied by Musa · requester's choice");
  assert.equal(sa.supplierLine({ requestedAssignee: { user_id: '2', name: 'Bello', byAdmin: '777' } }), '🚚 To be supplied by Bello · changed by an admin');
  assert.equal(sa.supplierLine({ requestedAssignee: { name: 'Musa' }, assignedDispatch: { name: 'Bello' } }), '🚚 Assigned to Bello');
  assert.equal(sa.waitingLine({}), '⏳ Waiting on Dispatch to confirm');
  assert.equal(sa.waitingLine({ stage: 'admin_review', dispatchSkipped: true }), '🛂 Waiting on an admin to approve · Dispatch stage skipped');
  const old = new Date(Date.now() - 2 * 86400000).toISOString();
  assert.equal(sa.waitingLine({ stage: 'admin_review', confirmedByDispatch: { name: 'Abdul', ts: old } }), '🛂 Waiting on an admin to approve · confirmed by Abdul 2d ago');
  assert.equal(sa.waitingLine({ stage: 'dispatch_acceptance', assignedDispatch: { name: 'Musa', ts: new Date().toISOString() } }), '🚚 Waiting on Musa to accept · assigned today');
  assert.equal(sa.waitingLine({ stage: 'admin_repick', dispatchDecline: { name: 'Musa' } }), '↩️ Declined by Musa — an admin must assign someone else');
  assert.equal(sa.waitingLine({ stage: 'completed', assignedDispatch: { name: 'Musa' } }), '✅ Accepted by Musa');
  assert.equal(sa.waitingLine({ stage: 'rejected_by_dispatch', dispatchRejection: { name: 'Abdul' } }), '❌ Rejected by Abdul');
});

test('the admin supply card carries the 🚚 line under the salesperson and the waiting line last', () => {
  const card = approvalCards.buildSupplyRequestCard({
    action: 'supply_request', warehouse: 'IDUMOTA', customer: 'Ketu madam', salesperson: 'Office',
    paymentMode: 'Zenith', salesDate: '2026-09-11', stage: 'admin_review',
    requestedAssignee: { user_id: '1', name: 'Musa' }, confirmedByDispatch: { name: 'Abdul', ts: new Date().toISOString() },
    cart: [{ design: '44200', shade: 'BLACK', quantity: 11 }],
  });
  assert.match(card, /^Supply Request · 🏭 IDUMOTA\n👤 Ketu madam\n🧑 Office\n🚚 To be supplied by Musa · requester's choice\n💳 Zenith\n📅 11-Sep-2026\n\n/);
  assert.match(card, /\n\n🛂 Waiting on an admin to approve · confirmed by Abdul today$/);
});
