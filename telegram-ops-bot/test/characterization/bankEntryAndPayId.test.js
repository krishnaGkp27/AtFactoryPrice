'use strict';

/**
 * BANK-3 + PAY-ID (owner, 23-Aug-2026), from two real approval cards.
 *
 * BANK-3 — "OPAY is a Bank addition, not an account under a bank."
 * Skipping the account step needed the typed word `skip`, so the Office
 * user typed the bank name again and the list gained "OPAY — OPAY".
 *
 * PAY-ID (HARD RULE) — "Any approval which comes for like this has to have
 * linked with telegram ID associated as employee before." The register-
 * account door linked the submitter's Telegram ID without ever checking
 * the Users sheet, and the card showed only a typed name.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242,5555';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../helpers/controllerHarness');
installFakeSheets(createFakeSheets({}));

const bankEntry = require(path.join(SRC, 'utils/bankEntry'));
const employeeIdentity = require(path.join(SRC, 'services/employeeIdentity'));
const paymentCards = require(path.join(SRC, 'services/paymentCards'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const legacyCleanup = require(path.join(SRC, 'services/legacyCleanup'));

/* ── BANK-3 ─────────────────────────────────────────────────────────── */

test('BANK-3: "X — X" IS the plain bank; a real account entry is untouched', () => {
  assert.equal(bankEntry.normalize('OPAY — OPAY'), 'OPAY');
  assert.equal(bankEntry.normalize('opay — OPAY'), 'opay', 'case-insensitive collapse');
  assert.equal(bankEntry.normalize('OPAY -  OPAY'), 'OPAY', 'hyphen form too');
  assert.equal(bankEntry.normalize('ZENITH — AFP LTD'), 'ZENITH — AFP LTD', 'real account kept');
  assert.equal(bankEntry.normalize('  GTB  '), 'GTB');
  assert.equal(bankEntry.normalize(''), '');
  // Dedupe must see through the shape, or the collapsed entry duplicates.
  assert.equal(bankEntry.same('OPAY', 'OPAY — OPAY'), true);
  assert.equal(bankEntry.same('ZENITH — AFP LTD', 'zenith — afp ltd'), true);
  assert.equal(bankEntry.same('ZENITH — AFP LTD', 'ZENITH — MAMA KAFAYA'), false,
    'BANK-2 still keeps two accounts at one bank distinct');
});

test('BANK-3: the boot cleanup repairs an already-approved OPAY — OPAY', async () => {
  let stored = 'ZENITH — AFP LTD,OPAY — OPAY,GTB';
  const savedGet = settingsRepository.getAll;
  const savedSet = settingsRepository.set;
  settingsRepository.getAll = async () => ({ BANK_LIST: stored });
  settingsRepository.set = async (k, v) => { if (k === 'BANK_LIST') stored = v; };
  try {
    const r = await legacyCleanup.normalizeBankList();
    assert.equal(r.changed, true);
    assert.equal(stored, 'ZENITH — AFP LTD,OPAY,GTB');
    // Idempotent: a clean list writes nothing.
    const again = await legacyCleanup.normalizeBankList();
    assert.equal(again.changed, false);
  } finally { settingsRepository.getAll = savedGet; settingsRepository.set = savedSet; }
});

test('BANK-3: collapsing never leaves a duplicate behind', async () => {
  let stored = 'OPAY,OPAY — OPAY';
  const savedGet = settingsRepository.getAll;
  const savedSet = settingsRepository.set;
  settingsRepository.getAll = async () => ({ BANK_LIST: stored });
  settingsRepository.set = async (k, v) => { if (k === 'BANK_LIST') stored = v; };
  try {
    await legacyCleanup.normalizeBankList();
    assert.equal(stored, 'OPAY', 'the two shapes are one destination');
  } finally { settingsRepository.getAll = savedGet; settingsRepository.set = savedSet; }
});

/* ── PAY-ID ─────────────────────────────────────────────────────────── */

test('PAY-ID: only an ACTIVE Users-sheet employee passes; failures fail CLOSED', async () => {
  const saved = usersRepository.findByUserId;
  usersRepository.findByUserId = async (id) => ({
    4242: { user_id: '4242', name: 'Muhammad', status: 'active' },
    5555: { user_id: '5555', name: 'Gone', status: 'inactive' },
  }[String(id)] || null);
  try {
    const ok = await employeeIdentity.verifyEmployee('4242');
    assert.equal(ok.ok, true);
    assert.equal(ok.user.name, 'Muhammad');

    const missing = await employeeIdentity.verifyEmployee('9999');
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing');
    assert.match(missing.message, /not registered as an employee yet/i);
    assert.match(missing.message, /Add User/, 'tells them the exact fix');

    const inactive = await employeeIdentity.verifyEmployee('5555');
    assert.equal(inactive.ok, false);
    assert.equal(inactive.reason, 'inactive');

    const blank = await employeeIdentity.verifyEmployee('');
    assert.equal(blank.ok, false);

    // Sheet unreadable → refuse. "Cannot prove" must never read as approved.
    usersRepository.findByUserId = async () => { throw new Error('Sheets 503'); };
    const down = await employeeIdentity.verifyEmployee('4242');
    assert.equal(down.ok, false);
    assert.equal(down.reason, 'unverifiable');
  } finally { usersRepository.findByUserId = saved; }
});

test('PAY-ID: the approval card states WHO — verified id, or a refusal warning', () => {
  const verified = paymentCards.buildAccountSummary({
    owner_name: 'Muhammad', owner_type: 'employee',
    account_number: '7044196792', bank: 'OPAY', owner_telegram_id: '4242',
  });
  assert.match(verified, /Linked Telegram: Muhammad · 4242 ✓ registered employee/);

  // The shape from the owner's screenshot — a name with NO linked identity.
  const unlinked = paymentCards.buildAccountSummary({
    owner_name: 'Muhammad', owner_type: 'employee',
    account_number: '7044196792', bank: 'OPAY', owner_telegram_id: '',
  });
  assert.match(unlinked, /NO Telegram identity linked — do not approve/);

  const contractor = paymentCards.buildAccountSummary({
    owner_name: 'Musa Welder', owner_type: 'contractor',
    account_number: '0123456789', bank: 'GTB',
  });
  assert.match(contractor, /contractor — no Telegram account; an admin is vouching/);
  assert.ok(!/NO Telegram identity/.test(contractor), 'a contractor is not an error');
});

test('PAY-ID: cardLine renders the verified row', () => {
  assert.equal(
    employeeIdentity.cardLine({ user_id: '4242', name: 'Muhammad' }),
    'Linked Telegram: Muhammad · 4242 ✓ registered employee');
  assert.equal(employeeIdentity.cardLine(null), '');
});

test('PAY-ID: the EXECUTOR refuses a stale approval after the person is gone', async () => {
  const inventoryService = require(path.join(SRC, 'services/inventoryService'));
  const paymentAccountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
  const savedFind = paymentAccountsRepo.findByApprovalRequestId;
  const savedStatus = paymentAccountsRepo.setStatus;
  const savedUser = usersRepository.findByUserId;
  const activated = [];
  paymentAccountsRepo.findByApprovalRequestId = async () => ({
    account_id: 'ACC-1', owner_name: 'Muhammad', owner_type: 'employee',
    owner_telegram_id: '4242', bank: 'OPAY', account_number: '7044196792', status: 'pending',
  });
  paymentAccountsRepo.setStatus = async (id, st) => { activated.push([id, st]); };
  const aj = { action: 'register_payment_account', account_id: 'ACC-1', owner_telegram_id: '4242' };
  // The executor re-reads the queue itself, so present the pending row.
  const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  const savedPending = approvalQueueRepository.getAllPending;
  const savedUpdate = approvalQueueRepository.updateStatus;
  approvalQueueRepository.getAllPending = async () => ([
    { requestId: 'REQ-1', user: '4242', actionJSON: aj, status: 'pending' },
  ]);
  approvalQueueRepository.updateStatus = async () => true;
  try {
    // Deactivated between submit and approval → the account must NOT activate.
    usersRepository.findByUserId = async () => ({ user_id: '4242', name: 'Muhammad', status: 'inactive' });
    const stale = await inventoryService.executeApprovedAction('REQ-1', '777');
    assert.equal(stale.ok, false, 'refused');
    assert.match(stale.message, /no longer an active employee/i);
    assert.equal(activated.length, 0, 'nothing was activated');

    // Still employed → it goes through.
    usersRepository.findByUserId = async () => ({ user_id: '4242', name: 'Muhammad', status: 'active' });
    const good = await inventoryService.executeApprovedAction('REQ-1', '777');
    assert.notEqual(good.ok, false, 'an active employee still registers');
    assert.deepEqual(activated, [['ACC-1', 'active']]);
  } finally {
    paymentAccountsRepo.findByApprovalRequestId = savedFind;
    paymentAccountsRepo.setStatus = savedStatus;
    usersRepository.findByUserId = savedUser;
    approvalQueueRepository.getAllPending = savedPending;
    approvalQueueRepository.updateStatus = savedUpdate;
  }
});
