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

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const accountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
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
