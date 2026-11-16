'use strict';

/**
 * PRC-2 (owner, 16-Nov-2026) — askedApprover: who is messaged about a
 * request asked of one named admin, and the one payment card every admin
 * surface prints (approvalCards.buildPaymentCard).
 */

process.env.ADMIN_IDS = '777,888,555';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const askedApprover = require(path.join(SRC, 'services/askedApprover'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const money = require(path.join(SRC, 'utils/money'));
const fmtDate = require(path.join(SRC, 'utils/formatDate'));
const { todayInLagos } = require(path.join(SRC, 'utils/dates'));

const ADMINS = ['777', '888', '555'];
const H = 3600 * 1000;
const NOW = Date.parse('2026-11-16T12:00:00Z');
const ago = (h) => new Date(NOW - h * H).toISOString();
const MUSA = { id: '888', name: 'Musa' };

const aud = (aj, extra = {}) => askedApprover.audience({
  aj, requesterId: '4242', createdAt: ago(1), adminIds: ADMINS, now: NOW, widenHours: 4, ...extra,
});

test('askedOf: absent, malformed, or no longer an admin → null', () => {
  assert.equal(askedApprover.askedOf({}, ADMINS), null);
  assert.equal(askedApprover.askedOf({ askedAdmin: 'Musa' }, ADMINS), null);
  assert.equal(askedApprover.askedOf({ askedAdmin: { name: 'Musa' } }, ADMINS), null);
  assert.equal(askedApprover.askedOf({ askedAdmin: { id: '999', name: 'Gone' } }, ADMINS), null);
  assert.deepEqual(askedApprover.askedOf({ askedAdmin: MUSA }, ADMINS), MUSA);
  assert.deepEqual(askedApprover.askedOf({ askedAdmin: { id: 888 } }, ADMINS), { id: '888', name: '888' });
});

test('audience: not asked = every admin − requester − signers (today\'s set)', () => {
  assert.deepEqual(aud({}), { targets: ADMINS, asked: null, widened: false, reason: 'open', hours: 1 });
  assert.deepEqual(aud({ approvals: ['777'] }).targets, ['888', '555']);
  // an admin requester is never messaged about their own request
  assert.deepEqual(aud({}, { requesterId: '777' }).targets, ['888', '555']);
});

test('audience: asked, no signature, young → the asked admin alone', () => {
  const a = aud({ askedAdmin: MUSA });
  assert.deepEqual(a.targets, ['888']);
  assert.equal(a.reason, 'asked');
  assert.equal(a.widened, false);
});

test('audience: asked, no signature, at the widen hour → every admin but the requester', () => {
  const a = aud({ askedAdmin: MUSA }, { createdAt: ago(4) });
  assert.equal(a.reason, 'waited');
  assert.deepEqual(a.targets, ADMINS);
  assert.equal(a.hours, 4);
  // the card already went wider (unreachable asked admin, a reminder): waited at once
  assert.equal(aud({ askedAdmin: MUSA, askWidenedAt: ago(0) }).reason, 'waited');
  // an unreadable CreatedAt is never "young" — never stuck on one person
  assert.equal(aud({ askedAdmin: MUSA }, { createdAt: '' }).reason, 'waited');
});

test('audience: widenHours 0 = never widen by time', () => {
  const a = aud({ askedAdmin: MUSA }, { createdAt: ago(500), widenHours: 0 });
  assert.equal(a.reason, 'asked');
  assert.deepEqual(a.targets, ['888']);
});

test('audience: asked and signed → the admins who have not signed', () => {
  const a = aud({ askedAdmin: MUSA, approvals: ['888'] });
  assert.equal(a.reason, 'signed');
  assert.deepEqual(a.targets, ['777', '555']);
  assert.deepEqual(aud({ askedAdmin: MUSA, approvals: ['777'] }).targets, ['888', '555'], 'R2 — another admin signed first');
});

test('audience: asked admin no longer an admin, or the requester → behaves as un-asked', () => {
  assert.equal(aud({ askedAdmin: { id: '999', name: 'Gone' } }).reason, 'open');
  const self = aud({ askedAdmin: { id: '777', name: 'Krishna' } }, { requesterId: '777' });
  assert.equal(self.reason, 'open');
  assert.deepEqual(self.targets, ['888', '555']);
});

test('audience: an admin requester asking another admin', () => {
  const a = aud({ askedAdmin: MUSA }, { requesterId: '777' });
  assert.deepEqual(a.targets, ['888']);
  const w = aud({ askedAdmin: MUSA }, { requesterId: '777', createdAt: ago(9) });
  assert.deepEqual(w.targets, ['888', '555'], 'waited: everyone but the requester');
});

test('note lines', () => {
  assert.equal(askedApprover.askYouNote('Abdul'), '🙋 Abdul asks YOU to approve this.');
  assert.equal(askedApprover.askedLine(MUSA), '🙋 Asked: Musa');
  assert.equal(askedApprover.askedLine(MUSA, { reason: 'waited', hours: 5 }), '🙋 Asked: Musa · no answer for 5h — any admin may approve');
  assert.equal(askedApprover.askedLine(MUSA, { reason: 'waited', hours: 0 }), '🙋 Asked: Musa', 'widened early: no "0h"');
  assert.equal(askedApprover.askedLine(null), '');
});

test('widenHours: default 4, blank = 4, 0 = 0, junk = 4', async () => {
  const real = settingsRepository.getAll;
  try {
    assert.equal(settingsRepository.DEFAULTS.ASKED_ADMIN_WIDEN_HOURS, 4);
    settingsRepository.getAll = async () => ({});
    assert.equal(await askedApprover.widenHours(), 4);
    settingsRepository.getAll = async () => ({ ASKED_ADMIN_WIDEN_HOURS: '' });
    assert.equal(await askedApprover.widenHours(), 4);
    settingsRepository.getAll = async () => ({ ASKED_ADMIN_WIDEN_HOURS: '0' });
    assert.equal(await askedApprover.widenHours(), 0);
    settingsRepository.getAll = async () => ({ ASKED_ADMIN_WIDEN_HOURS: 'soon' });
    assert.equal(await askedApprover.widenHours(), 4);
    settingsRepository.getAll = async () => { throw new Error('quota'); };
    assert.equal(await askedApprover.widenHours(), 4);
  } finally { settingsRepository.getAll = real; }
});

/* ── buildPaymentCard ─────────────────────────────────────────────────── */

/** The builder exactly as it stood before PRC-2 — the byte-for-byte pin. */
async function legacyCard({ customer, amount, method }) {
  let text = `Record Payment Request\nCustomer: ${customer}\nAmount: ${money.sale(amount || 0)}\nMethod: ${method || '—'}\nDate: ${fmtDate(todayInLagos())}`;
  try {
    const { outstandingAsOfToday } = await accountingService.getCustomerLedger(customer);
    const after = Number(outstandingAsOfToday) - Number(amount || 0);
    text += `\nOutstanding today: ${money.sale(outstandingAsOfToday)}`
      + `\nAfter this payment: ${money.sale(after)}`;
    if (after < 0) text += '\n⚠️ Payment EXCEEDS the outstanding balance.';
  } catch (_) { text += '\n(Outstanding balance unavailable right now.)'; }
  return text;
}

test('buildPaymentCard: an un-asked request with an amount is byte-identical to before', async () => {
  const real = accountingService.getCustomerLedger;
  try {
    for (const [ledger, req] of [
      [async () => ({ outstandingAsOfToday: 120000 }), { customer: 'ABBA', amount: 50000, method: 'Bank — Zenith' }],
      [async () => ({ outstandingAsOfToday: 10000 }), { customer: 'ABBA', amount: 50000, method: 'Cash' }],
      [async () => { throw new Error('down'); }, { customer: 'Ibrahim', amount: 1250.5, method: '' }],
    ]) {
      accountingService.getCustomerLedger = ledger;
      assert.equal(await approvalCards.buildPaymentCard(req), await legacyCard(req));
      // the whole stored row (source, customerId, action) prints the same card
      assert.equal(await approvalCards.buildPaymentCard({ ...req, action: 'record_payment', customerId: 'C-1', source: 'payment_received_door' }), await legacyCard(req));
    }
  } finally { accountingService.getCustomerLedger = real; }
});

test('buildPaymentCard: asked · blank amount · entered by an admin', async () => {
  const real = accountingService.getCustomerLedger;
  accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 120000 });
  const date = fmtDate(todayInLagos());
  try {
    assert.equal(await approvalCards.buildPaymentCard({ customer: 'ABBA', amount: 50000, method: 'Bank — Zenith', askedAdmin: MUSA }), [
      'Record Payment Request', 'Customer: ABBA', 'Amount: 50,000', 'Method: Bank — Zenith', `Date: ${date}`,
      '🙋 Asked: Musa', 'Outstanding today: 120,000', 'After this payment: 70,000',
    ].join('\n'));
    assert.equal(await approvalCards.buildPaymentCard({ customer: 'ABBA', amountPending: true, method: 'Cash', askedAdmin: MUSA }), [
      'Record Payment Request', 'Customer: ABBA', 'Amount: not entered — typed at the first approval', 'Method: Cash', `Date: ${date}`,
      '🙋 Asked: Musa', 'Outstanding today: 120,000',
    ].join('\n'), 'no After line, no EXCEEDS line');
    assert.equal(await approvalCards.buildPaymentCard({ customer: 'ABBA', amount: 500000, method: 'Cash', amountBy: { id: '888', name: 'Musa' } }), [
      'Record Payment Request', 'Customer: ABBA', 'Amount: 500,000 · entered by Musa', 'Method: Cash', `Date: ${date}`,
      'Outstanding today: 120,000', 'After this payment: -380,000', '⚠️ Payment EXCEEDS the outstanding balance.',
    ].join('\n'));
    // an asked admin no longer in the pool: no line
    assert.ok(!/Asked/.test(await approvalCards.buildPaymentCard({ customer: 'ABBA', amount: 5, method: 'Cash', askedAdmin: { id: '999', name: 'Gone' } })));
    // the rebuild from the row is the same card
    const row = { action: 'record_payment', customer: 'ABBA', amountPending: true, method: 'Cash', askedAdmin: MUSA };
    assert.equal(await approvalCards.buildCardFromActionJSON(row), await approvalCards.buildPaymentCard(row));
    // the inbox passes the row's age: once waited, the line says so
    const old = new Date(Date.now() - 5 * H - 60000).toISOString();
    assert.match(await approvalCards.buildCardFromActionJSON(row, { createdAt: old, requesterId: '4242' }),
      /🙋 Asked: Musa · no answer for 5h — any admin may approve/);
    // a decided record carries no live balance
    assert.ok(!/Outstanding/.test(await approvalCards.buildCardFromActionJSON({ ...row, amount: 5 }, { decided: true })));
  } finally { accountingService.getCustomerLedger = real; }
});
