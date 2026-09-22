'use strict';
/** TRF-20 (3/8) — the one transfer row: date · dot · route · quantity (owner, 22-Sep-2026). */
const test = require('node:test');
const assert = require('node:assert/strict');
const row = require('../../../src/services/transferRow');

const mk = (requestId, status, aj) => ({ requestId, status, actionJSON: { action: 'transfer_stock', from: 'Lagos', to: 'Kano office', ...aj } });
const ten = [{ design: '9031-D', shade: '1', qty: 4 }, { design: '9031-D', shade: '2', qty: 6 }];

test('label: the owner\'s shape, one per state', () => {
  assert.equal(row.label(mk('TR-20260918-002', 'pending', { stage: 'requested', lines: ten })), '18Sep·02 · 🔴 LAG▸KAN · 10B');
  assert.equal(row.label(mk('TR-20260918-003', 'pending', { stage: 'in_transit', bales: ['a', 'b', 'c'], lines: ten })), '18Sep·03 · 🟡 LAG▸KAN · 3B', 'in transit counts the bales actually logged');
  assert.equal(row.label(mk('TR-20260810-001', 'pending', { stage: 'admin_review', from: 'IDUMOTA', lines: [{ design: '202/201', shade: '1', qty: 5 }] })), '10Aug·01 · 🛂 IDU▸KAN · 5B');
  assert.equal(row.label(mk('TR-20260917-001', 'approved', { stage: 'in_transit', from: 'IDUMOTA', bales: ['1', '2', '3', '4'] })), '17Sep·01 · 🟢 IDU▸KAN · 4B');
  assert.equal(row.label(mk('TR-20260810-002', 'rejected', { stage: 'requested', lines: ten })), '10Aug·02 · ❌ LAG▸KAN · 10B');
});

test('label: a knowing duplicate is marked; a multi-design load stays one short row', () => {
  const dup = mk('TR-20260918-004', 'pending', { stage: 'requested', lines: ten, duplicateOf: 'TR-20260918-002' });
  assert.equal(row.label(dup), '18Sep·04 · ⧉🔴 LAG▸KAN · 10B');
  const many = mk('TR-20260802-002', 'pending', { stage: 'requested', from: 'IDUMOTA', lines: [
    { design: '202/201', shade: '1', qty: 1 }, { design: '77008', shade: '2', qty: 1 }, { design: '77019', shade: '3', qty: 1 }, { design: '9037-D', shade: '', qty: 5 }] });
  assert.equal(row.label(many), '02Aug·02 · 🔴 IDU▸KAN · 8B', 'no design on the row — it would crowd the chip');
});

test('label: loose thans print as T; a legacy row with no route drops that segment', () => {
  const legacy = { requestId: 'abc1d2e3-0000-4000-8000-000000000000', status: 'pending', actionJSON: { action: 'transfer_than', packageNo: '5801', thanNo: 3, warehouse: 'Kano office' } };
  assert.equal(row.label(legacy), 'R-ABC1 · 🔴 ?▸KAN · 1T');
  const none = { requestId: 'abc1d2e3-0000-4000-8000-000000000000', status: 'pending', actionJSON: { action: 'transfer_than', packageNo: '5801', thanNo: 3 } };
  assert.equal(row.label(none), 'R-ABC1 · 🔴 · 1T');
});

test('duty: the verb follows the STAGE — a parked transfer is an approval, not a dispatch', () => {
  assert.deepEqual(row.duty(mk('TR-20260810-001', 'pending', { stage: 'admin_review' })).verb, 'Approve');
  assert.deepEqual(row.duty(mk('TR-20260918-002', 'pending', { stage: 'requested' })).verb, 'Dispatch');
  assert.deepEqual(row.duty(mk('TR-20260918-003', 'pending', { stage: 'in_transit' })).verb, 'Receive');
  assert.equal(row.dutyLabel(mk('TR-20260810-001', 'pending', { stage: 'admin_review', from: 'IDUMOTA', lines: [{ design: '202/201', shade: '1', qty: 5 }] })), '🛂 Approve · 10Aug·01 · IDU▸KAN · 5B');
});
