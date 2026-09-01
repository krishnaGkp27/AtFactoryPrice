'use strict';

/**
 * APR-1 — the Approver column (H) on ApprovalQueue.
 *
 * Two failure modes these pin, both silent in production:
 *  • the header heal: the live sheet already had 7 columns, so a hardcoded
 *    `< 7` guard would leave column H permanently unlabelled;
 *  • CreatedAt (F) must not be touched by a resolution write.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');

// createFakeSheets copies its seed into an internal Map, so the tests drive
// that Map directly rather than a detached literal.
const fake = createFakeSheets({ ApprovalQueue: [] });
installFakeSheets(fake);
const setRows = (rows) => fake._store.set('ApprovalQueue', rows.map((r) => [...r]));
const rowsNow = () => fake._store.get('ApprovalQueue');

const repo = require(path.join(SRC, 'repositories/approvalQueueRepository'));

test('the header heals to eight columns, naming Approver', async () => {
  setRows([['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt']]);
  await repo.ensureHeader();
  assert.equal(rowsNow()[0].length, 8, 'a 7-column sheet must be widened, not judged complete');
  assert.equal(rowsNow()[0][7], 'Approver');
});

test('resolving a request stamps the approver and leaves CreatedAt alone', async () => {
  setRows([
    ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'],
    ['R-1', '555', '{"action":"sale_bundle"}', 'gate', 'pending', '2026-09-01T08:00:00.000Z', '', ''],
  ]);
  const ok = await repo.updateStatus('R-1', 'approved', '2026-09-01T09:00:00.000Z', 'Emin + Boss');
  assert.equal(ok, true);
  const row = rowsNow()[1];
  assert.equal(row[4], 'approved');
  assert.equal(row[5], '2026-09-01T08:00:00.000Z', 'CreatedAt is never rewritten by a resolution');
  assert.equal(row[6], '2026-09-01T09:00:00.000Z');
  assert.equal(row[7], 'Emin + Boss', 'both signatures land in one readable cell');
});

test('an omitted approver never blanks a cell that already holds one', async () => {
  setRows([
    ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'],
    ['R-2', '555', '{}', 'gate', 'pending', '2026-09-01T08:00:00.000Z', '', 'Emin'],
  ]);
  await repo.updateStatus('R-2', 'approved', '2026-09-01T09:00:00.000Z');
  assert.equal(rowsNow()[1][7], 'Emin', 'silence is not an instruction to erase');
});

test('readers carry the approver through, and legacy 7-column rows read as empty', async () => {
  setRows([
    ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'],
    ['R-3', '555', '{}', 'gate', 'approved', 'c', 'r', 'Emin'],
    ['R-4', '555', '{}', 'gate', 'approved', 'c', 'r'],
  ]);
  const resolved = await repo.getResolved();
  assert.equal(resolved.find((r) => r.requestId === 'R-3').approver, 'Emin');
  assert.equal(resolved.find((r) => r.requestId === 'R-4').approver, '',
    'a pre-APR-1 row is blank, not undefined');
  const one = await repo.getByRequestId('R-3');
  assert.equal(one.approver, 'Emin');
});
