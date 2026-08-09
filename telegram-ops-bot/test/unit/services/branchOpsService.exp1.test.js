'use strict';

/**
 * EXP-1 — branchOpsService extensions: typed item kinds, the computed
 * running cash balance, the day-report roll-up, and the zero-day guard.
 * Pure logic + stubbed repository; no sheets touched.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');

const branchOpsService = require('../../../src/services/branchOpsService');
const branchOpsLogRepository = require('../../../src/repositories/branchOpsLogRepository');
const usersRepository = require('../../../src/repositories/usersRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');

auditLogRepository.append = async () => {};
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: 'Abdul', warehouses: ['Idumota'] });

const TODAY = branchOpsService.todayInTz();

function row(kind, amount, extra = {}) {
  return {
    branch: 'Idumota', date: TODAY, kind, amount,
    subject: extra.subject || kind, ref_id: extra.ref_id || '',
    status: extra.status || 'logged', manager_id: extra.manager_id || 'abdul',
    ...extra,
  };
}

test('validateExpenseItems: kinds ride through, unknown kinds refuse', () => {
  const out = branchOpsService.validateExpenseItems([
    { title: 'Abdul', amount: 1000, kind: 'person_allowance', ref_id: 'u1' },
    { title: 'Fuel', amount: 5500 },
    { title: 'Sir Pee — 52 bales', amount: 104000, kind: 'commission' },
  ]);
  assert.deepEqual(out.map((i) => i.kind), ['person_allowance', 'expense', 'commission']);
  assert.equal(out[0].ref_id, 'u1');
  assert.throws(() => branchOpsService.validateExpenseItems([{ title: 'X', amount: 1, kind: 'salary' }]),
    /unknown kind/);
});

test('computeCashBalance: cash_in − outflows; pending counts, rejected never', () => {
  const bal = branchOpsService.computeCashBalance([
    row('cash_in', 50000),
    row('expense', 5500, { status: 'approved' }),
    row('person_allowance', 1000, { status: 'pending_approval' }), // cash already left the drawer
    row('commission', 2000, { status: 'rejected' }),               // never happened
    row('daily_open', 999999),                                     // counts, not flows
    row('opening_cash', 999999),
  ]);
  assert.equal(bal, 43500);
});

test('buildDayReport: groups by kind, computes spent + filed + balance', () => {
  const dayRows = [
    row('person_allowance', 1000, { subject: 'Abdul', ref_id: 'u1' }),
    row('person_allowance', 3000, { subject: 'Yarima', ref_id: 'u2' }),
    row('expense', 5500, { subject: 'Fuel' }),
    row('commission', 104000, { subject: 'Sir Pee — 52 bales' }),
    row('cash_in', 150000, { subject: 'Cash received' }),
    row('expense', 700, { subject: 'Typo', status: 'rejected' }), // invisible
  ];
  const rep = branchOpsService.buildDayReport(dayRows, dayRows);
  assert.deepEqual(rep.allowances, [{ name: 'Abdul', amount: 1000 }, { name: 'Yarima', amount: 3000 }]);
  assert.deepEqual(rep.office, [{ title: 'Fuel', amount: 5500 }]);
  assert.deepEqual(rep.commissions, [{ note: 'Sir Pee — 52 bales', amount: 104000 }]);
  assert.equal(rep.cashInTotal, 150000);
  assert.equal(rep.spent, 113500);
  assert.equal(rep.filed, true);
  assert.equal(rep.balance, 36500, 'running balance over the same rows');
});

test('buildDayReport: an empty day is NOT filed; a zero-day marker IS', () => {
  assert.equal(branchOpsService.buildDayReport([], []).filed, false);
  const marked = branchOpsService.buildDayReport([row('zero_day', '', { subject: 'Nothing spent' })], []);
  assert.equal(marked.filed, true);
  assert.equal(marked.zeroDay, true);
});

test('recordZeroDay: refused once outflows exist; idempotent otherwise', async () => {
  const appended = [];
  branchOpsLogRepository.findByBranchDate = async () => [row('expense', 500)];
  branchOpsLogRepository.append = async (r) => { appended.push(r); return r; };
  await assert.rejects(() => branchOpsService.recordZeroDay({ userId: 'abdul' }), /contradict/);
  assert.equal(appended.length, 0);

  branchOpsLogRepository.findByBranchDate = async () => [];
  const first = await branchOpsService.recordZeroDay({ userId: 'abdul' });
  assert.equal(first.already, false);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].kind, 'zero_day');

  branchOpsLogRepository.findByBranchDate = async () => [row('zero_day', '', { subject: 'Nothing spent' })];
  const second = await branchOpsService.recordZeroDay({ userId: 'abdul' });
  assert.equal(second.already, true);
  assert.equal(appended.length, 1, 'no duplicate marker row');
});

test('lastAllowanceAmount: newest non-rejected row for that person', async () => {
  branchOpsLogRepository.getAll = async () => [
    row('person_allowance', 1000, { ref_id: 'u1', date: '2026-08-01' }),
    row('person_allowance', 1800, { ref_id: 'u1', date: '2026-08-05' }),
    row('person_allowance', 9999, { ref_id: 'u1', date: '2026-08-07', status: 'rejected' }),
    row('person_allowance', 4000, { ref_id: 'u2', date: '2026-08-06' }),
  ];
  assert.equal(await branchOpsService.lastAllowanceAmount('u1'), 1800);
  assert.equal(await branchOpsService.lastAllowanceAmount('nobody'), null);
});
