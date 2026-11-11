'use strict';

/**
 * PAY-1 — a REJECTED account registration lets go of its account number.
 *
 * Raising `register_payment_account` writes the PaymentAccounts row as
 * `pending`. A rejection used to leave that row exactly as it was, and the
 * door's own clash check (`findLive`: pending OR active) then refused that
 * number + bank for ever — "Already registered … awaiting approval" — until
 * somebody rewrote the status cell on the sheet by hand.
 *
 * Pinned, over the REAL repositories on the in-memory sheet:
 *  - reject → the request's OWN pending row reads `inactive`; no other cell
 *    of the row moves and the row is never removed;
 *  - the same number + bank can then be registered again, and approving the
 *    new request activates the NEW row exactly as before (the rejected row
 *    stays inactive);
 *  - an account that is already `active` is never touched by a late reject;
 *  - another request's pending row for the same number is never touched;
 *  - a refused sheet write is logged and does not cost the rejection.
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
const queueRepo = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));
const paymentService = require(path.join(SRC, 'services/paymentService'));
const logger = require(path.join(SRC, 'utils/logger'));

auditLogRepository.append = async () => {};

const NUMBER = '0123456789';
const BANK = 'GTBank';
const STATUS = accountsRepo.HEADERS.indexOf('status');
const APPROVED_BY = accountsRepo.HEADERS.indexOf('approved_by');
const QUEUE_HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'];

/** Both sheets back to their header row — the repositories write it only once. */
function reset() {
  fake._store.set(accountsRepo.SHEET, [[...accountsRepo.HEADERS]]);
  fake._store.set('ApprovalQueue', [[...QUEUE_HEADERS]]);
  accountsRepo.invalidateCache();
}

/** What the register door leaves behind: a pending account row + its queue row. */
async function raise(requestId, over = {}) {
  const acct = await accountsRepo.append({
    owner_name: 'Musa Welder', owner_type: 'contractor', owner_telegram_id: '',
    account_number: NUMBER, bank: BANK, status: 'pending',
    registered_by: '777', approval_request_id: requestId, ...over,
  });
  await queueRepo.append({
    requestId, user: '777', status: 'pending', riskReason: 'dual_admin_required',
    actionJSON: {
      action: 'register_payment_account', account_id: acct.account_id,
      owner_name: 'Musa Welder', owner_type: 'contractor', owner_telegram_id: '',
      account_number: NUMBER, bank: BANK,
    },
  });
  return acct;
}

const rawRow = (accountId) => fake._store.get(accountsRepo.SHEET).find((r) => r[0] === accountId);
const queueStatus = async (id) => (await queueRepo.getByRequestId(id)).status;

test('reject → the request\'s own pending row reads inactive; no other cell moves, nothing is deleted', async () => {
  reset();
  const acct = await raise('REQ-A');
  const before = [...rawRow(acct.account_id)];
  assert.equal(before[STATUS], 'pending');
  assert.ok(await accountsRepo.findLive(NUMBER, BANK), 'while it waits, the number is held');

  const res = await inventoryService.rejectApproval('REQ-A', '888');
  assert.equal(res.ok, true);
  assert.equal(await queueStatus('REQ-A'), 'rejected');

  const expected = [...before];
  expected[STATUS] = 'inactive';
  assert.deepEqual([...rawRow(acct.account_id)], expected, 'the status cell alone was rewritten');
  assert.equal(fake._store.get(accountsRepo.SHEET).length, 2, 'header + the one row — the record is kept');
  assert.equal(await accountsRepo.findLive(NUMBER, BANK), null, 'the number is free to register again');
});

test('after the reject the same number registers again; approval activates the NEW row as before', async () => {
  reset();
  const first = await raise('REQ-A');
  await inventoryService.rejectApproval('REQ-A', '888');

  // The door's clash check no longer finds a live row, so a second raise goes through.
  assert.equal(await accountsRepo.findLive(NUMBER, BANK), null);
  const second = await raise('REQ-B');
  assert.notEqual(second.account_id, first.account_id);
  assert.equal((await accountsRepo.findLive(NUMBER, BANK)).account_id, second.account_id);

  const res = await inventoryService.executeApprovedAction('REQ-B', '888');
  assert.notEqual(res.ok, false);
  assert.match(res.message || '', /Account registered for \*Musa Welder\*/);
  assert.equal(rawRow(second.account_id)[STATUS], 'active', 'approve path unchanged: pending → active');
  assert.equal(rawRow(second.account_id)[APPROVED_BY], '888', 'and still stamped with who approved');
  assert.equal(rawRow(first.account_id)[STATUS], 'inactive', 'the rejected row stays the rejected row');
  assert.equal(await queueStatus('REQ-B'), 'approved');
});

test('an account that is already ACTIVE is never touched by a late reject', async () => {
  reset();
  const acct = await raise('REQ-C');
  // Activated, but its request still reads pending (the executor's last
  // write — the queue row — was refused): a reject must not un-register it.
  await accountsRepo.setStatus(acct.account_id, 'active', 'Ajeet ‖ John');
  const before = [...rawRow(acct.account_id)];

  const res = await inventoryService.rejectApproval('REQ-C', '888');
  assert.equal(res.ok, true);
  assert.deepEqual([...rawRow(acct.account_id)], before, 'not one cell of an active account changed');
  assert.equal((await accountsRepo.findLive(NUMBER, BANK)).status, 'active');
});

test('another request\'s pending row for the SAME number is never touched', async () => {
  reset();
  const mine = await raise('REQ-D');
  const theirs = await raise('REQ-E');   // same number + bank, a different open request
  const theirsBefore = [...rawRow(theirs.account_id)];

  const res = await inventoryService.rejectApproval('REQ-D', '888');
  assert.equal(res.ok, true);
  assert.equal(rawRow(mine.account_id)[STATUS], 'inactive');
  assert.deepEqual([...rawRow(theirs.account_id)], theirsBefore, 'the other request keeps its row as raised');
  assert.equal(await queueStatus('REQ-E'), 'pending');
  assert.equal((await accountsRepo.findLive(NUMBER, BANK)).account_id, theirs.account_id,
    'the number is still held — by the request that is still open');

  // A rejected registration with NO row of its own releases nobody else's.
  await queueRepo.append({
    requestId: 'REQ-F', user: '777', status: 'pending',
    actionJSON: { action: 'register_payment_account', account_number: NUMBER, bank: BANK },
  });
  const orphan = await inventoryService.rejectApproval('REQ-F', '888');
  assert.equal(orphan.ok, true);
  assert.deepEqual([...rawRow(theirs.account_id)], theirsBefore);
});

test('a refused sheet write is logged and does not cost the rejection', async () => {
  reset();
  const acct = await raise('REQ-G');
  const origBatch = sheetsClient.batchUpdateRanges;
  const origError = logger.error;
  const errors = [];
  sheetsClient.batchUpdateRanges = async (sheet, updates) => {
    if (sheet === accountsRepo.SHEET) throw new Error('Quota exceeded');
    return origBatch(sheet, updates);
  };
  logger.error = (...args) => { errors.push(args.join(' ')); };
  try {
    const res = await inventoryService.rejectApproval('REQ-G', '888');
    assert.equal(res.ok, true, 'the request is rejected all the same');
    assert.equal(await queueStatus('REQ-G'), 'rejected');
    assert.equal(rawRow(acct.account_id)[STATUS], 'pending', 'the write did not land');
    assert.equal(errors.length, 1, 'and the failure is on the log, once');
    assert.match(errors[0], /register_payment_account reject cleanup FAILED for REQ-G: Quota exceeded/);
  } finally {
    sheetsClient.batchUpdateRanges = origBatch;
    logger.error = origError;
  }
});

test('a register that cannot be READ is logged as a failure — never passed off as "no row"', async () => {
  reset();
  const acct = await raise('REQ-I');
  const origRead = sheetsClient.readRange;
  const origError = logger.error;
  const origWarn = logger.warn;
  const errors = [];
  const warnings = [];
  // Cold cache, as after the 10 s TTL: the reject's own read is the one refused.
  accountsRepo.invalidateCache();
  sheetsClient.readRange = async (sheet, range) => {
    if (sheet === accountsRepo.SHEET) throw new Error('Read quota exceeded');
    return origRead(sheet, range);
  };
  logger.error = (...args) => { errors.push(args.join(' ')); };
  logger.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const res = await inventoryService.rejectApproval('REQ-I', '888');
    assert.equal(res.ok, true, 'the request is rejected all the same');
    assert.equal(await queueStatus('REQ-I'), 'rejected');
    assert.equal(errors.length, 1, 'the failure is on the log, once, at error level');
    assert.match(errors[0], /register_payment_account reject cleanup FAILED for REQ-I: Read quota exceeded/);
    assert.equal(warnings.filter((w) => /no PaymentAccounts row/.test(w)).length, 0,
      'and it is not reported as a request that never had a row');
  } finally {
    sheetsClient.readRange = origRead;
    logger.error = origError;
    logger.warn = origWarn;
    accountsRepo.invalidateCache();
  }
  assert.equal(rawRow(acct.account_id)[STATUS], 'pending', 'nothing was written');
});

test('releaseRejectedAccount: only a pending row is released, once; an unknown request is a no-op', async () => {
  reset();
  const acct = await raise('REQ-H');
  assert.equal(await paymentService.releaseRejectedAccount('REQ-NOPE'), null);
  assert.equal(await paymentService.releaseRejectedAccount(''), null);
  assert.equal(rawRow(acct.account_id)[STATUS], 'pending');

  const released = await paymentService.releaseRejectedAccount('REQ-H');
  assert.equal(released.account_id, acct.account_id);
  assert.equal(released.status, 'inactive');
  assert.equal(rawRow(acct.account_id)[STATUS], 'inactive');

  // Idempotent: a second call finds nothing pending and writes nothing.
  let wrote = 0;
  const origBatch = sheetsClient.batchUpdateRanges;
  sheetsClient.batchUpdateRanges = async (...a) => { wrote += 1; return origBatch(...a); };
  try {
    assert.equal(await paymentService.releaseRejectedAccount('REQ-H'), null);
    assert.equal(wrote, 0);
  } finally { sheetsClient.batchUpdateRanges = origBatch; }
});
