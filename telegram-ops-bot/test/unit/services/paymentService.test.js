'use strict';

/**
 * PAY-1 — the rules that decide who may do what with money.
 *
 * Owner rulings, 14-Aug-2026:
 *   "Only one finance telegram ID will make payment at any moment in
 *    time. That is a business rule."
 *   "Abdul can raise for himself. Yerima can raise for himself."
 *   "The threshold value is ₦50,000."
 *   "No add by yourself. Instead I will make it in sheet change."
 *
 * Pinned here: the finance head is READ from the Users sheet and never
 * written; a sheet that does not name exactly one finance person degrades
 * to admins-with-a-warning rather than stranding approved money; an
 * employee can only ever see their own account; and the two typed fields
 * that carry real money are validated hard.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_IDS = '777,888';
delete process.env.FINANCE_IDS;

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const accountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const reasonsRepo = require(path.join(SRC, 'repositories/paymentReasonsRepository'));
const paymentService = require(path.join(SRC, 'services/paymentService'));

const OFFICE = '8896799323';
const user = (id, name, depts, status = 'active') => ({
  user_id: id, name, departments: depts, department: depts[0] || '', status,
});

function seedUsers(rows) { usersRepository.getAll = async () => rows; }

/* ── the one finance hand ── */

test('PAY-1: the finance head is the single active member of Finance', async () => {
  seedUsers([
    user('7430648262', 'Abdul', ['Sales', 'Dispatch']),
    user(OFFICE, 'Office', ['Finance']),
  ]);
  const head = await paymentService.financeHead();
  assert.equal(head.ok, true);
  assert.equal(head.telegramId, OFFICE);
  assert.equal(head.name, 'Office');
});

test('PAY-1: the ROLE label is irrelevant — the owner keeps it as he likes', async () => {
  // "It can be marked as marketer or something else." The department is
  // the fact; nothing here reads the role.
  seedUsers([{ ...user(OFFICE, 'Office', ['Finance']), role: 'marketer' }]);
  assert.equal((await paymentService.financeHead()).telegramId, OFFICE);
});

test('PAY-1: an inactive finance member is not the finance head', async () => {
  seedUsers([user(OFFICE, 'Office', ['Finance'], 'inactive')]);
  const head = await paymentService.financeHead();
  assert.equal(head.ok, false);
  assert.equal(head.reason, 'no_finance_member');
});

test('PAY-1: two finance members is a misconfiguration, not a choice', async () => {
  seedUsers([user(OFFICE, 'Office', ['Finance']), user('999', 'Someone', ['Finance'])]);
  const head = await paymentService.financeHead();
  assert.equal(head.ok, false);
  assert.equal(head.reason, 'multiple_finance_members');
  assert.match(paymentService.financeWarning(head), /2 people.*One finance ID/);
});

/* ── who may execute ── */

test('PAY-1: only the finance id may Mark Done when the sheet is correct', async () => {
  seedUsers([user(OFFICE, 'Office', ['Finance']), user('777', 'Ajeet', ['Sales'])]);
  assert.equal((await paymentService.canExecute(OFFICE)).ok, true);
  assert.equal((await paymentService.canExecute('777')).ok, false,
    'an ADMIN cannot pay while a finance head exists — one hand, business rule');
  assert.equal((await paymentService.canExecute('7430648262')).ok, false);
  assert.equal((await paymentService.canExecute('')).ok, false);
});

test('PAY-1: with no finance member, admins can act — approved money is never stranded', async () => {
  seedUsers([user('777', 'Ajeet', ['Sales'])]);
  const gate = await paymentService.canExecute('777');
  assert.equal(gate.ok, true);
  assert.equal(gate.viaAdminFallback, true);
  assert.equal((await paymentService.canExecute('7430648262')).ok, false,
    'the fallback is to ADMINS, not to everyone');
});

test('PAY-1: cards go to the finance head, or to every admin with a warning', async () => {
  seedUsers([user(OFFICE, 'Office', ['Finance'])]);
  assert.deepEqual((await paymentService.paymentRecipients()).ids, [OFFICE]);

  seedUsers([]);
  const fallback = await paymentService.paymentRecipients();
  assert.deepEqual(fallback.ids, ['777', '888'], 'nobody in Finance → all admins see it');
  assert.match(paymentService.financeWarning(fallback.head), /No one is in the Finance department/);
});

/* ── PAY-2 §2 B: the finance seat, three tiers ── */

async function withFinanceIds(value, fn) {
  const prev = process.env.FINANCE_IDS;
  if (value === undefined) delete process.env.FINANCE_IDS; else process.env.FINANCE_IDS = value;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.FINANCE_IDS; else process.env.FINANCE_IDS = prev;
  }
}

test('PAY-2: Railway FINANCE_IDS is the first source of the finance seat — every id, in env order', async () => {
  seedUsers([user(OFFICE, 'Office', ['Finance'])]);   // the sheet names someone else entirely
  await withFinanceIds(' 555, 666 ,555', async () => {
    assert.deepEqual(paymentService.financeSeatIds(), ['555', '666'], 'trimmed, de-duplicated');
    const r = await paymentService.paymentRecipients();
    assert.deepEqual(r.ids, ['555', '666'], 'the Railway ids, not the Users row');
    assert.equal(r.source, 'finance_ids');
    assert.equal(r.head.ok, true, 'no warning line when the seat is set');
    assert.equal(paymentService.financeWarning(r.head), '');
  });
});

test('PAY-2: FINANCE_IDS blank → the single Users Finance row, exactly as before', async () => {
  seedUsers([user(OFFICE, 'Office', ['Finance'])]);
  await withFinanceIds(undefined, async () => {
    assert.deepEqual(paymentService.financeSeatIds(), []);
    const r = await paymentService.paymentRecipients();
    assert.deepEqual(r.ids, [OFFICE]);
    assert.equal(r.source, 'users_finance');
    assert.equal(paymentService.financeWarning(r.head), '');
  });
  await withFinanceIds('  ', async () => {
    assert.deepEqual(paymentService.financeSeatIds(), [], 'whitespace is blank');
    assert.equal((await paymentService.paymentRecipients()).source, 'users_finance');
  });
});

test('PAY-2: neither → every env admin, and ONLY then the warning line', async () => {
  seedUsers([]);
  await withFinanceIds(undefined, async () => {
    const r = await paymentService.paymentRecipients();
    assert.deepEqual(r.ids, ['777', '888']);
    assert.equal(r.source, 'admins');
    assert.match(paymentService.financeWarning(r.head), /No one is in the Finance department/);
  });
});

test('PAY-2: canExecute honours any id from the same resolution — and no other', async () => {
  seedUsers([user(OFFICE, 'Office', ['Finance']), user('777', 'Ajeet', ['Sales'])]);
  await withFinanceIds('555,666', async () => {
    assert.equal((await paymentService.canExecute('555')).ok, true, 'the Railway finance phone can mark done');
    assert.equal((await paymentService.canExecute('666')).ok, true, 'and so can the second id');
    assert.equal((await paymentService.canExecute('555')).viaAdminFallback, undefined);
    assert.equal((await paymentService.canExecute(OFFICE)).ok, false,
      'the Users Finance row is not consulted once Railway names the seat');
    assert.equal((await paymentService.canExecute('777')).ok, false, 'nor is an admin');
  });
  await withFinanceIds(undefined, async () => {
    assert.equal((await paymentService.canExecute(OFFICE)).ok, true, 'blank env → the Users row');
    assert.equal((await paymentService.canExecute('555')).ok, false);
  });
  seedUsers([]);
  await withFinanceIds(undefined, async () => {
    const gate = await paymentService.canExecute('777');
    assert.equal(gate.ok, true);
    assert.equal(gate.viaAdminFallback, true, 'only the last tier is the admin fallback');
    assert.equal(gate.source, 'admins');
  });
});

/* ── PAY-2 §2 A: the reason ── */

test('PAY-2: a reason is 3 to 120 characters, trimmed, inner whitespace collapsed', () => {
  assert.equal(paymentService.validateReason('  Transport to Idumota  ').value, 'Transport to Idumota');
  assert.equal(paymentService.validateReason('Loading   at\tthe warehouse').value, 'Loading at the warehouse');
  assert.equal(paymentService.validateReason('abc').ok, true, 'three is enough');
  assert.equal(paymentService.validateReason('x'.repeat(120)).ok, true, 'one hundred and twenty is the ceiling');
  for (const bad of ['', '  ', 'no', 'x'.repeat(121)]) {
    const v = paymentService.validateReason(bad);
    assert.equal(v.ok, false, JSON.stringify(bad));
    assert.equal(v.reason, 'Give a reason of 3 to 120 characters.');
  }
  assert.equal(paymentService.REASON_MIN, 3);
  assert.equal(paymentService.REASON_MAX, 120);
});

// Owner ruling 10-Sep-2026: the sheet row is the complete record, so the
// row's own `reason` cell (column S) is read first; Postgres is the
// in-flight buffer; the queue payload is the last resort for rows that
// predate both.
test('PAY-2: reasonFor reads the sheet row first, Postgres second, the payload last, and never throws', async () => {
  const origGet = approvalQueueRepository.getByRequestId;
  const origPg = reasonsRepo.forPayment;
  try {
    approvalQueueRepository.getByRequestId = async (id) => (id === 'R1'
      ? { requestId: 'R1', actionJSON: { action: 'request_payment', reason: 'Transport to Idumota' } } : null);
    reasonsRepo.forPayment = async (id) => (id === 'PAY-2' ? { reason_text: 'Fuel' } : null);

    assert.equal(await paymentService.reasonFor({ payment_id: 'PAY-1', approval_request_id: 'R1' }), 'Transport to Idumota', 'the payload when neither the row nor Postgres knows');
    assert.equal(await paymentService.reasonFor({ payment_id: 'PAY-2', approval_request_id: 'R9' }), 'Fuel', 'the Postgres row when the sheet has none');
    assert.equal(await paymentService.reasonFor({ payment_id: 'PAY-2', approval_request_id: 'R1' }), 'Fuel', 'Postgres beats the payload');
    assert.equal(await paymentService.reasonFor({ payment_id: 'PAY-3', approval_request_id: 'R9' }), '', 'unknown is empty, not a crash');
    assert.equal(await paymentService.reasonFor({ payment_id: 'PAY-2', approval_request_id: 'R1', reason: 'Already here' }), 'Already here', 'the row\'s own cell wins over both, with no read at all');
    assert.equal(await paymentService.reasonFor(null), '');

    approvalQueueRepository.getByRequestId = async () => { throw new Error('sheet down'); };
    reasonsRepo.forPayment = async () => { throw new Error('pg down'); };
    assert.equal(await paymentService.reasonFor({ payment_id: 'PAY-1', approval_request_id: 'R1' }), '', 'both down → empty, fail-open');
  } finally {
    approvalQueueRepository.getByRequestId = origGet;
    reasonsRepo.forPayment = origPg;
  }
});

test('PAY-2: reasonsFor maps many rows — sheet cell, then Postgres, then ONE queue read for the leftovers', async () => {
  const origAll = approvalQueueRepository.getAllWithRowIndex;
  const origPg = reasonsRepo.forPayment;
  let reads = 0;
  try {
    approvalQueueRepository.getAllWithRowIndex = async () => {
      reads += 1;
      return [
        { requestId: 'R1', actionJSON: { reason: 'Airtime' } },
        { requestId: 'R2', actionJSON: { reason: '' } },
        { requestId: 'R4', actionJSON: { reason: 'Stale payload copy' } },
        // R6: the payload AND Postgres both know, and disagree — pins the
        // Postgres-before-payload step (the sheet-first step alone would
        // pass under the old payload-first order for every other row).
        { requestId: 'R6', actionJSON: { reason: 'Stale payload copy' } },
      ];
    };
    const PG = { P2: 'Fuel', P6: 'Buffered in Postgres' };
    reasonsRepo.forPayment = async (id) => (PG[id] ? { reason_text: PG[id] } : null);
    const map = await paymentService.reasonsFor([
      { payment_id: 'P1', approval_request_id: 'R1' },
      { payment_id: 'P2', approval_request_id: 'R2' },
      { payment_id: 'P3', approval_request_id: 'R3' },
      { payment_id: 'P4', approval_request_id: 'R4', reason: 'On the row' },
      { payment_id: 'P6', approval_request_id: 'R6' },
    ]);
    assert.equal(reads, 1);
    assert.deepEqual([...map.entries()], [
      ['P1', 'Airtime'], ['P2', 'Fuel'], ['P3', ''], ['P4', 'On the row'],
      ['P6', 'Buffered in Postgres'],
    ]);
    assert.equal((await paymentService.reasonsFor([])).size, 0, 'nothing to read for nothing');
    assert.equal(reads, 1);
    // Every row carrying its own cell → the queue is never opened.
    await paymentService.reasonsFor([{ payment_id: 'P5', approval_request_id: 'R5', reason: 'Diesel' }]);
    assert.equal(reads, 1, 'no queue read when the sheet already answers');
  } finally {
    approvalQueueRepository.getAllWithRowIndex = origAll;
    reasonsRepo.forPayment = origPg;
  }
});

/* ── self-only ── */

const ACCOUNTS = [
  { account_id: 'A1', owner_telegram_id: '7430648262', owner_type: 'employee', status: 'active', owner_name: 'Abdul' },
  { account_id: 'A2', owner_telegram_id: '8700676816', owner_type: 'employee', status: 'active', owner_name: 'Yerima' },
  { account_id: 'A3', owner_telegram_id: '', owner_type: 'contractor', status: 'active', owner_name: 'Mason' },
  { account_id: 'A4', owner_telegram_id: '7430648262', owner_type: 'employee', status: 'pending', owner_name: 'Abdul' },
];
accountsRepo.activeForTelegramId = async (id) => ACCOUNTS.filter(
  (a) => a.status === 'active' && a.owner_telegram_id === String(id));
accountsRepo.activeContractors = async () => ACCOUNTS.filter(
  (a) => a.status === 'active' && a.owner_type === 'contractor');

test('PAY-1: an employee sees ONLY their own approved account', async () => {
  const abdul = await paymentService.payableAccountsFor('7430648262', false);
  assert.deepEqual(abdul.map((a) => a.account_id), ['A1'],
    'not a colleague\'s account, and not his own UNAPPROVED one');
});

test('PAY-1: an admin also sees contractors — never another employee', async () => {
  const admin = await paymentService.payableAccountsFor('777', true);
  assert.deepEqual(admin.map((a) => a.account_id), ['A3'],
    'a contractor may have no Telegram, so somebody must ask for them');
  assert.ok(!admin.some((a) => a.account_id === 'A2'),
    'self-only is not weakened by being an admin');
});

/* ── the threshold badges, it does not gate ── */

test('PAY-1: ₦50,000 is the default line, and the sheet may move it', async () => {
  settingsRepository.getAll = async () => ({});
  assert.equal(await paymentService.threshold(), 50000);
  assert.equal(await paymentService.isAboveThreshold(49999), false);
  assert.equal(await paymentService.isAboveThreshold(50000), true, 'at the line counts as large');

  settingsRepository.getAll = async () => ({ PAYMENT_THRESHOLD_NGN: '250000' });
  assert.equal(await paymentService.threshold(), 250000);
  assert.equal(await paymentService.isAboveThreshold(50000), false);

  settingsRepository.getAll = async () => { throw new Error('sheet down'); };
  assert.equal(await paymentService.threshold(), 50000, 'an outage falls back to the in-code default');
});

/* ── the two fields that carry real money ── */

test('PAY-1: an account number is 10 digits or it is a typo', async () => {
  assert.equal(paymentService.validateAccountNumber('0123456789').value, '0123456789',
    'the leading zero is part of the number');
  assert.equal(paymentService.validateAccountNumber('012-345 6789').value, '0123456789');
  assert.equal(paymentService.validateAccountNumber('').ok, false);
  assert.match(paymentService.validateAccountNumber('12345').reason, /10 digits — that was 5/);
  assert.equal(paymentService.validateAccountNumber('01234567890').ok, false, 'one too many');
});

test('PAY-1: an amount is whole naira, positive, and sane', async () => {
  assert.equal(paymentService.validateAmount('45000').value, 45000);
  assert.equal(paymentService.validateAmount('₦45,000').value, 45000, 'the way a human writes it');
  assert.equal(paymentService.validateAmount('0').ok, false);
  assert.equal(paymentService.validateAmount('-5').ok, false);
  assert.equal(paymentService.validateAmount('abc').ok, false);
  assert.equal(paymentService.validateAmount('999999999').ok, false, 'a slipped digit is caught');
});

test('PAY-1: naira renders the way the owner writes it', () => {
  assert.equal(paymentService.fmtNaira(45000), '₦45,000');
  assert.equal(paymentService.fmtNaira(0), '₦0');
});
