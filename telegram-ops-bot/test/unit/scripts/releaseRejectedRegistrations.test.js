'use strict';

/**
 * PAY-1 — the one-off that releases the account registrations REJECTED
 * before the fix of 11-Nov-2026 (`scripts/release-rejected-registrations.js`).
 *
 * Pinned: a pending PaymentAccounts row is released only when its request
 * is on the ApprovalQueue and reads rejected; an active row, a row whose
 * request is still pending or was approved, a row with no request id and a
 * row whose request is not on the queue are never touched; a dry run
 * writes nothing; --commit writes the status cell of the selected rows and
 * nothing else.
 */

process.env.ADMIN_IDS = '777,888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

const fake = createFakeSheets({});
installFakeSheets(fake);

const sheetsClient = require(path.join(SRC, 'repositories/sheetsClient'));
const accountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
const { planRelease, renderPlan, run } = require('../../../scripts/release-rejected-registrations');

const acct = (account_id, status, approval_request_id, over = {}) => ({
  rowIndex: 2, account_id, owner_name: 'Abdul', owner_type: 'employee', owner_telegram_id: '7430648262',
  account_number: '0123456789', bank: 'GTBank', status, registered_by: '7430648262',
  approval_request_id, approved_by: '', created_at: '2026-11-01T09:00:00.000Z', notes: '', ...over,
});
const req = (requestId, status, over = {}) => ({
  rowIndex: 2, requestId, user: '7430648262', actionJSON: { action: 'register_payment_account' },
  riskReason: 'dual_admin_required', status, createdAt: '2026-11-01T09:00:00.000Z',
  resolvedAt: status === 'pending' ? '' : '2026-11-02T10:00:00.000Z', approver: status === 'pending' ? '' : 'Ajeet', ...over,
});
const ids = (list) => list.map((x) => x.account.account_id);

/* ── the selection ────────────────────────────────────────────────────── */

test('a pending row whose request was rejected is released — and only that', () => {
  const plan = planRelease({
    accounts: [
      acct('PAC-REJ', 'pending', 'REQ-REJ'),
      acct('PAC-OPEN', 'pending', 'REQ-OPEN'),
      acct('PAC-APPR', 'pending', 'REQ-APPR'),
      acct('PAC-NOID', 'pending', ''),
      acct('PAC-GONE', 'pending', 'REQ-GONE'),
      acct('PAC-LIVE', 'active', 'REQ-REJ2'),
      acct('PAC-DONE', 'inactive', 'REQ-REJ3'),
    ],
    queue: [
      req('REQ-REJ', 'rejected'), req('REQ-OPEN', 'pending'), req('REQ-APPR', 'approved'),
      req('REQ-REJ2', 'rejected'), req('REQ-REJ3', 'rejected'),
    ],
  });
  assert.deepEqual(ids(plan.release), ['PAC-REJ']);
  assert.equal(plan.release[0].request.requestId, 'REQ-REJ');
  assert.deepEqual(plan.kept.map((k) => [k.account.account_id, k.why]), [
    ['PAC-OPEN', 'request REQ-OPEN is still pending'],
    ['PAC-APPR', 'request REQ-APPR was approved'],
    ['PAC-NOID', 'no request id on the row'],
    ['PAC-GONE', 'request REQ-GONE is not on the ApprovalQueue — look at it by hand'],
  ]);
  // An active or already inactive row is in neither list: never touched, never reported.
  const all = [...ids(plan.release), ...ids(plan.kept)];
  assert.ok(!all.includes('PAC-LIVE') && !all.includes('PAC-DONE'));
});

test('the status cells are read as people type them; two rows of one rejected request are both released', () => {
  const plan = planRelease({
    accounts: [acct('PAC-A', ' Pending ', ' REQ-X '), acct('PAC-B', 'PENDING', 'REQ-X'), acct('PAC-C', 'Active', 'REQ-X')],
    queue: [req('REQ-X', ' Rejected ')],
  });
  assert.deepEqual(ids(plan.release), ['PAC-A', 'PAC-B']);
  assert.deepEqual(plan.kept, []);
});

test('never on a guess: a request id the queue holds twice with mixed statuses, another kind of request, a blank status', () => {
  const plan = planRelease({
    accounts: [
      acct('PAC-TWICE', 'pending', 'REQ-TWICE'),
      acct('PAC-BOTH', 'pending', 'REQ-BOTH'),
      acct('PAC-OTHER', 'pending', 'REQ-OTHER'),
      acct('PAC-BLANK', 'pending', 'REQ-BLANK'),
      acct('PAC-NOJSON', 'pending', 'REQ-NOJSON'),
    ],
    queue: [
      req('REQ-TWICE', 'rejected'), req('REQ-TWICE', 'pending'),
      req('REQ-BOTH', 'rejected'), req('REQ-BOTH', 'rejected'),
      req('REQ-OTHER', 'rejected', { actionJSON: { action: 'request_payment' } }),
      req('REQ-BLANK', ''),
      req('REQ-NOJSON', 'rejected', { actionJSON: null }),
    ],
  });
  assert.deepEqual(ids(plan.release), ['PAC-BOTH'], 'every copy rejected → released');
  assert.deepEqual(plan.kept.map((k) => [k.account.account_id, k.why]), [
    ['PAC-TWICE', 'request REQ-TWICE is on the ApprovalQueue 2 times (rejected / pending)'],
    ['PAC-OTHER', 'request REQ-OTHER is not an account registration'],
    ['PAC-BLANK', 'request REQ-BLANK reads "(blank)"'],
    ['PAC-NOJSON', 'request REQ-NOJSON is not an account registration'],
  ]);
});

test('nothing to read → nothing to release', () => {
  assert.deepEqual(planRelease({ accounts: [], queue: [] }), { release: [], kept: [] });
  assert.deepEqual(planRelease({}), { release: [], kept: [] });
  // An empty queue (a wrong workbook, a header-only sheet) releases nothing.
  const plan = planRelease({ accounts: [acct('PAC-A', 'pending', 'REQ-A')], queue: [] });
  assert.deepEqual(plan.release, []);
  assert.equal(plan.kept.length, 1);
});

test('the listing: what would change, what is left alone, and that a dry run wrote nothing', () => {
  const plan = planRelease({
    accounts: [acct('PAC-REJ', 'pending', 'REQ-REJ', { rowIndex: 14 }), acct('PAC-OPEN', 'pending', 'REQ-OPEN', { rowIndex: 15, owner_name: 'Musa', bank: 'Zenith', account_number: '0987654321' })],
    queue: [req('REQ-REJ', 'rejected'), req('REQ-OPEN', 'pending')],
  });
  assert.deepEqual(renderPlan(plan), [
    'DRY RUN — would release 1 rejected registration(s) (status pending → inactive):',
    '  PAC-REJ  row 14  Abdul · GTBank 0123456789  ← REQ-REJ rejected 2026-11-02 by Ajeet',
    '',
    'Left exactly as they are — 1 other pending row(s):',
    '  PAC-OPEN  row 15  Musa · Zenith 0987654321  — request REQ-OPEN is still pending',
    '',
    'Nothing was written. Re-run with --commit to set those rows to inactive.',
  ]);
  const committed = renderPlan(plan, { commit: true });
  assert.equal(committed[0], 'RELEASING 1 rejected registration(s) (status pending → inactive):');
  assert.ok(!committed.some((l) => /Nothing was written/.test(l)));
  assert.deepEqual(renderPlan({ release: [], kept: [] }),
    ['No pending registration belongs to a rejected request. Nothing to release.']);
});

/* ── the run, on the in-memory sheets ─────────────────────────────────── */

const QUEUE_HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'];
const STATUS = accountsRepo.HEADERS.indexOf('status');
const accountRow = (id, status, requestId) => [id, 'Abdul', 'employee', '7430648262', "'0123456789", 'GTBank', status, '7430648262', requestId, '', '2026-11-01T09:00:00.000Z', ''];
const queueRow = (id, status) => [id, '7430648262', JSON.stringify({ action: 'register_payment_account' }), 'dual_admin_required', status, '2026-11-01T09:00:00.000Z', status === 'pending' ? '' : '2026-11-02T10:00:00.000Z', status === 'pending' ? '' : 'Ajeet'];

function seed() {
  fake._store.set(accountsRepo.SHEET, [
    [...accountsRepo.HEADERS],
    accountRow('PAC-REJ', 'pending', 'REQ-REJ'),
    accountRow('PAC-OPEN', 'pending', 'REQ-OPEN'),
    accountRow('PAC-LIVE', 'active', 'REQ-OLD'),
    accountRow('PAC-REJ2', 'pending', 'REQ-REJ2'),
    accountRow('PAC-NOID', 'pending', ''),
  ]);
  fake._store.set('ApprovalQueue', [
    [...QUEUE_HEADERS],
    queueRow('REQ-REJ', 'rejected'), queueRow('REQ-OPEN', 'pending'),
    queueRow('REQ-OLD', 'rejected'), queueRow('REQ-REJ2', 'rejected'),
  ]);
  accountsRepo.invalidateCache();
}
const snapshot = () => JSON.stringify([fake._store.get(accountsRepo.SHEET), fake._store.get('ApprovalQueue')]);

/** Run with every sheet WRITE counted. */
async function counted(opts) {
  const writers = ['appendRows', 'updateRange', 'batchUpdateRanges'];
  const orig = {}; let writes = 0;
  for (const w of writers) { orig[w] = sheetsClient[w]; sheetsClient[w] = async (...a) => { writes += 1; return orig[w](...a); }; }
  const out = [];
  try { return { result: await run({ ...opts, log: (l) => out.push(String(l)) }), writes, out }; } finally { Object.assign(sheetsClient, orig); }
}

test('a dry run (no flag) lists the rows and writes NOTHING to either sheet', async () => {
  seed();
  const before = snapshot();
  const { result, writes, out } = await counted({});
  assert.equal(writes, 0);
  assert.equal(snapshot(), before);
  assert.deepEqual(result.plan.release.map((r) => r.account.account_id), ['PAC-REJ', 'PAC-REJ2']);
  assert.equal(result.released, 0);
  assert.match(out[0], /^DRY RUN — would release 2 rejected registration\(s\)/);
  assert.ok(out.some((l) => /PAC-OPEN .* request REQ-OPEN is still pending/.test(l)));
  assert.ok(out.some((l) => /Nothing was written\. Re-run with --commit/.test(l)));
});

test('--commit sets the status cell of the rejected rows to inactive and changes no other cell or row', async () => {
  seed();
  const before = JSON.parse(snapshot());
  const { result, out } = await counted({ commit: true });
  assert.equal(result.released, 2);
  assert.equal(result.failed, 0);

  const [accountsAfter, queueAfter] = JSON.parse(snapshot());
  const expected = before[0].map((r) => [...r]);
  expected[1][STATUS] = 'inactive';   // PAC-REJ
  expected[4][STATUS] = 'inactive';   // PAC-REJ2
  assert.deepEqual(accountsAfter, expected, 'two status cells, nothing else; the active row and the open one are as they were');
  assert.deepEqual(queueAfter, before[1], 'the queue is only read');
  assert.ok(out.some((l) => l === '  ✅ PAC-REJ → inactive'));
  assert.ok(out.some((l) => /^Released 2\/2\.$/.test(l)));

  // Run again: nothing left to do, nothing written.
  const again = await counted({ commit: true });
  assert.equal(again.writes, 0);
  assert.equal(again.out[0], 'No pending registration belongs to a rejected request. Nothing to release.');
});

test('a sheet that cannot be read stops the run — nothing is assumed, nothing written', async () => {
  seed();
  const before = snapshot();
  const origRead = sheetsClient.readRange;
  sheetsClient.readRange = async (sheet, range) => {
    if (sheet === 'ApprovalQueue') throw new Error('Read quota exceeded');
    return origRead(sheet, range);
  };
  try {
    await assert.rejects(() => run({ commit: true, log: () => {} }), /Read quota exceeded/);
  } finally { sheetsClient.readRange = origRead; accountsRepo.invalidateCache(); }
  assert.equal(snapshot(), before);
});

test('one refused write does not strand the rest of the list', async () => {
  seed();
  const origBatch = sheetsClient.batchUpdateRanges;
  let n = 0;
  sheetsClient.batchUpdateRanges = async (...a) => { n += 1; if (n === 1) throw new Error('Quota exceeded'); return origBatch(...a); };
  const out = [];
  let result;
  try { result = await run({ commit: true, log: (l) => out.push(String(l)) }); } finally { sheetsClient.batchUpdateRanges = origBatch; accountsRepo.invalidateCache(); }
  assert.equal(result.released, 1);
  assert.equal(result.failed, 1);
  assert.ok(out.some((l) => l === '  ❌ PAC-REJ — Quota exceeded'));
  assert.ok(out.some((l) => l === '  ✅ PAC-REJ2 → inactive'));
  assert.ok(out.some((l) => /^Released 1\/2 · 1 failed \(run it again\)\.$/.test(l)));
  const rows = fake._store.get(accountsRepo.SHEET);
  assert.equal(rows[1][STATUS], 'pending');
  assert.equal(rows[4][STATUS], 'inactive');
});
