'use strict';

/**
 * PAY-2 (owner ruling 10-Sep-2026) — the trailing `reason` column (S) on
 * PaymentRequests.
 *
 * "All the approved request / fulfilled resides in the Google Sheet. But
 * during the phase it is in process it can buffer itself in the SQL
 * database in Postgres on Railway." The sheet row is the complete record
 * of an approved / paid request, so the one fact it lacked — the reason —
 * gains a trailing column. Pins: the header is LAST; a live 18-column
 * sheet is widened by exactly one header cell with no data row touched;
 * append writes the reason; parse reads it; a legacy 18-cell row reads ''.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');

const fake = createFakeSheets({ PaymentRequests: [] });
installFakeSheets(fake);
const setRows = (rows) => fake._store.set('PaymentRequests', rows.map((r) => [...r]));
const rowsNow = () => fake._store.get('PaymentRequests');

const sheetsClient = require(path.join(SRC, 'repositories/sheetsClient'));
const repo = require(path.join(SRC, 'repositories/paymentRequestsRepository'));

/**
 * Record every header write the repository makes. The store snapshot alone
 * cannot tell a one-cell widen from a full `A1:S1` rewrite (both leave the
 * same 19 cells), so the house pattern — write ONLY the missing cells — is
 * pinned on the write itself. Wraps `sheetsClient` (not `fake`): the
 * harness binds the fake's methods onto the client at install time.
 */
async function recordWrites(fn) {
  const writes = [];
  const orig = sheetsClient.updateRange;
  sheetsClient.updateRange = async (sheet, range, values) => {
    writes.push({ sheet, range, values: values.map((r) => [...r]) });
    return orig(sheet, range, values);
  };
  try { await fn(); } finally { sheetsClient.updateRange = orig; }
  return writes;
}

const OLD_HEADERS = [
  'payment_id', 'payee_name', 'payee_type',
  'account_id', 'account_number', 'bank',
  'amount_ngn', 'above_threshold',
  'raised_by', 'raised_at',
  'approval_request_id', 'approved_by', 'status',
  'bill_file_id', 'proof_file_id',
  'done_by', 'done_at', 'decline_reason',
];

function legacyRow(id = 'PAY-1') {
  return [
    id, 'Abdul', 'employee', 'PAC-1', "'7048940378", 'OPAY',
    '4000', '', '7430648262', '2026-09-01T10:00:00.000Z',
    'REQ-1', 'Ajeet ‖ John', 'approved', '', '', '', '', '',
  ];
}

test('HEADERS: reason is the LAST column and nothing before it moved', () => {
  assert.equal(repo.HEADERS.length, OLD_HEADERS.length + 1);
  assert.deepEqual(repo.HEADERS.slice(0, OLD_HEADERS.length), OLD_HEADERS, 'rule 4: no rename, no reorder');
  assert.equal(repo.HEADERS[repo.HEADERS.length - 1], 'reason');
  assert.equal(repo.HEADERS.indexOf('reason'), 18, 'column S');
});

test('ensureHeader widens an 18-column live sheet by ONE cell and touches nothing else', async () => {
  repo._resetHeaderGuard();
  const dataRow = legacyRow();
  setRows([OLD_HEADERS, dataRow]);
  const writes = await recordWrites(() => repo.ensureHeader());
  // The write itself: exactly one, the single missing cell — never A1:S1.
  assert.equal(writes.length, 1, 'one write for one missing header cell');
  assert.equal(writes[0].sheet, 'PaymentRequests');
  assert.equal(writes[0].range, 'S1:S1', 'only the missing cell, not the whole header row');
  assert.deepEqual(writes[0].values, [['reason']]);
  const head = rowsNow()[0];
  assert.equal(head.length, 19, 'an 18-column sheet must be widened, not judged complete');
  assert.equal(head[18], 'reason');
  assert.deepEqual(head.slice(0, 18), OLD_HEADERS, 'existing header cells untouched');
  assert.deepEqual(rowsNow()[1], dataRow, 'data rows untouched');
  assert.equal(rowsNow().length, 2, 'no row appended by the heal');
});

test('ensureHeader writes the full header on an empty sheet and is a no-op on a complete one', async () => {
  repo._resetHeaderGuard();
  setRows([]);
  const fresh = await recordWrites(() => repo.ensureHeader());
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].range, 'A1:S1', 'an empty sheet gets the whole header in one write');
  assert.deepEqual(fresh[0].values, [repo.HEADERS]);
  assert.deepEqual(rowsNow()[0], repo.HEADERS);

  repo._resetHeaderGuard();
  const again = await recordWrites(() => repo.ensureHeader());
  assert.equal(again.length, 0, 'complete header → no write at all');

  // The guard is per-process: a second call in the same process reads and writes nothing.
  const guarded = await recordWrites(() => repo.ensureHeader());
  assert.equal(guarded.length, 0);
});

test('append writes the reason in S; parse reads it back', async () => {
  repo._resetHeaderGuard();
  repo.invalidateCache();
  setRows([repo.HEADERS]);
  const saved = await repo.append({
    payment_id: 'PAY-2', payee_name: 'Abdul', payee_type: 'employee',
    account_id: 'PAC-1', account_number: '7048940378', bank: 'OPAY',
    amount_ngn: 4000, raised_by: '7430648262', approval_request_id: 'REQ-2',
    status: 'pending_approval', reason: '  Transport to Idumota  ',
  });
  assert.equal(saved.payment_id, 'PAY-2');
  const row = rowsNow()[1];
  assert.equal(row.length, 19, 'one cell per header');
  assert.equal(row[18], 'Transport to Idumota', 'trimmed, in column S');
  assert.equal(row[17], '', 'decline_reason (R) untouched');

  const parsed = await repo.findById('PAY-2');
  assert.equal(parsed.reason, 'Transport to Idumota');
  assert.equal(parsed.status, 'pending_approval');
});

test('parse: a legacy 18-cell row reads reason as "" — never undefined', async () => {
  repo.invalidateCache();
  setRows([OLD_HEADERS, legacyRow('PAY-3')]);
  const parsed = await repo.findById('PAY-3');
  assert.equal(parsed.reason, '');
  assert.equal(parsed.approved_by, 'Ajeet ‖ John');
  assert.equal(parsed.decline_reason, '');
});

test('update: reason is written only when the patch names it, in its own S cell', async () => {
  repo.invalidateCache();
  setRows([OLD_HEADERS, legacyRow('PAY-4')]);
  // A lifecycle patch that does not name `reason` leaves S alone.
  await repo.update('PAY-4', { status: 'done', done_by: '8896799323', done_at: '10-Sep-2026, 15:10' });
  assert.equal(rowsNow()[1][18], undefined, 'no S write without a reason in the patch');
  assert.equal(rowsNow()[1][12], 'done');

  // The approval-time backfill names it.
  await repo.update('PAY-4', { reason: 'Fuel for the van' });
  assert.equal(rowsNow()[1][18], 'Fuel for the van');
  assert.deepEqual(rowsNow()[1].slice(0, 12), legacyRow('PAY-4').slice(0, 12), 'the raise snapshot A–L is never rewritten');
  const parsed = await repo.findById('PAY-4');
  assert.equal(parsed.reason, 'Fuel for the van');
});
