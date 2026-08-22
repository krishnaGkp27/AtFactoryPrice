'use strict';

/**
 * SUPQ-1 — the supply-request half of the 🚚 Pending Supply queue.
 *
 * supplyPipeline() reduces pending ApprovalQueue rows to render-ready
 * items: only supply_request rows count, the stage reads in human words,
 * the holder is a person once one is assigned and a pool before that,
 * bales sum across the cart, and the oldest promise sorts first.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../../../src/flows/salesWorkflowView');
const { supplyPipeline } = _internals;

const row = (over = {}) => ({
  requestId: over.requestId || 'SR-1',
  user: '555',
  createdAt: over.createdAt || '2026-08-20T10:00:00Z',
  actionJSON: {
    action: 'supply_request',
    customer: 'Owaibula',
    warehouse: 'Kano office',
    salesperson: 'Musa',
    cart: [{ design: '9043', shade: 'A', quantity: 3 }, { design: '9006', shade: 'B', quantity: 2 }],
    ...over.aj,
  },
});

test('only supply_request rows enter the pipeline', () => {
  const items = supplyPipeline([
    row(),
    { requestId: 'X', user: '1', createdAt: '', actionJSON: { action: 'sell_package' } },
    { requestId: 'Y', user: '1', createdAt: '', actionJSON: null },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].requestId, 'SR-1');
});

test('stage reads in human words with the right holder', () => {
  const [a] = supplyPipeline([row({ aj: { stage: 'dispatch_review' } })]);
  assert.equal(a.stageLabel, 'awaiting dispatch check');
  assert.equal(a.holder, 'Dispatch pool');

  const [b] = supplyPipeline([row({ aj: { stage: 'admin_review' } })]);
  assert.equal(b.stageLabel, 'awaiting admin approval');
  assert.equal(b.holder, 'Admins');

  const [c] = supplyPipeline([row({
    aj: { stage: 'dispatch_acceptance', assignedDispatch: { user_id: '9', name: 'Abdul', ts: 't' } },
  })]);
  assert.equal(c.stageLabel, 'awaiting Abdul');
  assert.equal(c.holder, 'Abdul');
});

test('a missing or unknown stage sits at admin approval (dispatchSkipped path)', () => {
  const [a] = supplyPipeline([row({ aj: { stage: undefined } })]);
  assert.equal(a.stage, 'admin_review');
  const [b] = supplyPipeline([row({ aj: { stage: 'weird_future_stage' } })]);
  assert.equal(b.stage, 'admin_review');
});

test('bales sum across the cart; junk quantities count zero', () => {
  const [a] = supplyPipeline([row()]);
  assert.equal(a.bales, 5);
  const [b] = supplyPipeline([row({ aj: { cart: [{ design: 'x', quantity: 'not-a-number' }] } })]);
  assert.equal(b.bales, 0);
  const [c] = supplyPipeline([row({ aj: { cart: undefined } })]);
  assert.equal(c.bales, 0);
});

test('oldest promise first', () => {
  const items = supplyPipeline([
    row({ requestId: 'SR-new', createdAt: '2026-08-21T09:00:00Z' }),
    row({ requestId: 'SR-old', createdAt: '2026-08-10T09:00:00Z' }),
  ]);
  assert.deepEqual(items.map((i) => i.requestId), ['SR-old', 'SR-new']);
});

test('stage trail stamps ride the item for the detail card', () => {
  const [a] = supplyPipeline([row({
    aj: {
      stage: 'dispatch_acceptance',
      confirmedByDispatch: { user_id: '7', name: 'Sani', ts: 't1' },
      approvedByAdmin: { user_id: '777', ts: 't2' },
      assignedDispatch: { user_id: '9', name: 'Abdul', ts: 't3' },
    },
  })]);
  assert.equal(a.stamps.confirmedByDispatch.name, 'Sani');
  assert.ok(a.stamps.approvedByAdmin);
  assert.equal(a.stamps.assignedDispatch.name, 'Abdul');
});
