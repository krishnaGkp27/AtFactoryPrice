'use strict';

/**
 * APR-1 — who gets named as the approver.
 *
 * The whole point of this module is that the person who flips a request's
 * Status cell is often NOT the person who approved it. These tests pin the
 * two cases where naming the caller would manufacture a false audit trail,
 * and the dual-admin case where the pair used to be recorded by halves.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { approverIds } = require('../../../src/services/approverStamp');

test('a transfer credits the approving admin, never the receiver who flips the row', () => {
  const aj = { action: 'transfer_stock', approvedBy: 'admin-9', submittedBy: 'dispatcher-3' };
  assert.deepEqual(approverIds(aj, 'receiver-7'), ['admin-9'],
    'the destination receiver confirming arrival is not a signing authority');
});

test('a supply request credits the approving admin, never the dispatch hand who accepts', () => {
  const aj = {
    action: 'supply_request',
    approvedByAdmin: { user_id: 'admin-4' },
    assignedDispatch: { user_id: 'hand-2' },
  };
  assert.deepEqual(approverIds(aj, 'hand-2'), ['admin-4']);
});

test('a dual-admin approval names BOTH signatures, first and final', () => {
  // The first tap is parked in ActionJSON while the row stays pending; the
  // final tap never used to be recorded anywhere on the row at all.
  assert.deepEqual(approverIds({ approvals: ['admin-1'] }, 'admin-2'), ['admin-1', 'admin-2']);
});

test('the same admin tapping twice is named once', () => {
  assert.deepEqual(approverIds({ approvals: ['admin-1'] }, 'admin-1'), ['admin-1']);
});

test('a single-admin action names the deciding admin', () => {
  assert.deepEqual(approverIds({ action: 'sale_bundle' }, 'admin-5'), ['admin-5']);
});

test('system actors are never named as approvers', () => {
  assert.deepEqual(approverIds({}, 'system'), []);
  assert.deepEqual(approverIds({}, ''), []);
  assert.deepEqual(approverIds({}, null), []);
});

test('a transfer with no recorded admin yields nothing rather than guessing', () => {
  // Better an empty cell than the receiver's name in an Approver column.
  assert.deepEqual(approverIds({ action: 'transfer_stock' }, 'receiver-7'), []);
});
