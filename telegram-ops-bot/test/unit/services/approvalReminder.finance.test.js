'use strict';

/**
 * PAY-2 §2 H — the finance nudge on the existing reminder sweep.
 *
 * An approved-but-unpaid payment re-sends its finance card after
 * PAYMENT_FINANCE_REMINDER_HOURS (Settings, default 4; 0 = off) measured
 * from the LATER of the approval and the last finance card / reminder in
 * the `payment_events` trail. The card goes through
 * paymentCards.sendFinanceCard with { kind: 'reminder_sent' }, which logs
 * the event itself. Without a trail (Postgres off) the queue row's resolve
 * stamp is the clock and this process remembers what it sent.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const { createFakeBot } = require('../../helpers/fakeBot');

const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const paymentRequestsRepo = require(path.join(SRC, 'repositories/paymentRequestsRepository'));
const paymentEventsRepo = require(path.join(SRC, 'repositories/paymentEventsRepository'));
const paymentCards = require(path.join(SRC, 'services/paymentCards'));
const reminder = require(path.join(SRC, 'services/approvalReminder'));

const NOW = Date.parse('2026-09-09T12:00:00Z');
const H = 60 * 60 * 1000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

let settings = {};
settingsRepository.getAll = async () => ({ ...settings });
approvalQueueRepository.getAllPending = async () => [];
let queueRows = {};
approvalQueueRepository.getByRequestId = async (id) => queueRows[id] || null;

let waiting = [];
paymentRequestsRepo.awaitingPayment = async () => waiting;
let trail = {}; // payment_id → { kind: ISO }
paymentEventsRepo.lastKindAt = async (paymentId, kind) => (trail[paymentId] && trail[paymentId][kind]) || null;
let sends = [];
paymentCards.sendFinanceCard = async (bot, paymentId, opts) => { sends.push({ paymentId, opts }); return { sent: 1, failed: 0 }; };

function pay(id, extra = {}) {
  return { payment_id: id, approval_request_id: `REQ-${id}`, status: 'approved', raised_at: iso(30 * H), ...extra };
}

function reset() {
  reminder._resetForTests();
  settings = {};
  queueRows = {};
  waiting = [];
  trail = {};
  sends = [];
}

test('DEFAULTS carries the knob at 4 hours', () => {
  assert.equal(settingsRepository.DEFAULTS.PAYMENT_FINANCE_REMINDER_HOURS, 4);
});

test('financeReminderHours: sheet value wins, blank/unreadable falls back to the default, 0 is 0', async () => {
  settings = {};
  assert.equal(await reminder.financeReminderHours(), 4);
  settings = { PAYMENT_FINANCE_REMINDER_HOURS: '' };
  assert.equal(await reminder.financeReminderHours(), 4);
  settings = { PAYMENT_FINANCE_REMINDER_HOURS: 'abc' };
  assert.equal(await reminder.financeReminderHours(), 4);
  settings = { PAYMENT_FINANCE_REMINDER_HOURS: '2' };
  assert.equal(await reminder.financeReminderHours(), 2);
  settings = { PAYMENT_FINANCE_REMINDER_HOURS: 0 };
  assert.equal(await reminder.financeReminderHours(), 0);
});

test('due: approved 5 h ago with no card since → the finance card is re-sent as reminder_sent', async () => {
  reset();
  waiting = [pay('PAY-A')];
  trail = { 'PAY-A': { approved: iso(5 * H) } };
  const sent = await reminder.sweepFinance(createFakeBot(), { now: NOW });
  assert.equal(sent, 1);
  assert.deepEqual(sends, [{ paymentId: 'PAY-A', opts: { kind: 'reminder_sent' } }]);
});

test('not due: a finance card / reminder inside the window holds the clock', async () => {
  reset();
  waiting = [pay('PAY-B'), pay('PAY-C')];
  trail = {
    'PAY-B': { approved: iso(9 * H), finance_card_sent: iso(1 * H) },
    'PAY-C': { approved: iso(9 * H), finance_card_sent: iso(8 * H), reminder_sent: iso(3 * H) },
  };
  const sent = await reminder.sweepFinance(createFakeBot(), { now: NOW });
  assert.equal(sent, 0);
  assert.deepEqual(sends, []);
});

test('due again once the window has lapsed since the last reminder', async () => {
  reset();
  waiting = [pay('PAY-D')];
  trail = { 'PAY-D': { approved: iso(20 * H), finance_card_sent: iso(19 * H), reminder_sent: iso(4.5 * H) } };
  assert.equal(await reminder.sweepFinance(createFakeBot(), { now: NOW }), 1);
});

test('knob 0 → off: nothing is read, nothing is sent', async () => {
  reset();
  settings = { PAYMENT_FINANCE_REMINDER_HOURS: 0 };
  waiting = [pay('PAY-E')];
  trail = { 'PAY-E': { approved: iso(48 * H) } };
  let read = false;
  const orig = paymentRequestsRepo.awaitingPayment;
  paymentRequestsRepo.awaitingPayment = async () => { read = true; return waiting; };
  try {
    assert.equal(await reminder.sweepFinance(createFakeBot(), { now: NOW }), 0);
    assert.equal(read, false);
    assert.deepEqual(sends, []);
  } finally { paymentRequestsRepo.awaitingPayment = orig; }
});

test('no trail (Postgres off): the queue row\'s resolve stamp is the approval time, and this process remembers its own send', async () => {
  reset();
  waiting = [pay('PAY-F'), pay('PAY-G')];
  queueRows = {
    'REQ-PAY-F': { requestId: 'REQ-PAY-F', status: 'approved', resolvedAt: iso(6 * H) },
    'REQ-PAY-G': { requestId: 'REQ-PAY-G', status: 'approved', resolvedAt: iso(1 * H) },
  };
  assert.equal(await reminder.sweepFinance(createFakeBot(), { now: NOW }), 1, 'only F is 4 h past approval');
  assert.deepEqual(sends.map((s) => s.paymentId), ['PAY-F']);
  // An hour later, still no trail: the per-process memory holds F back.
  assert.equal(await reminder.sweepFinance(createFakeBot(), { now: NOW + 1 * H }), 0);
  // Past the window: F again, and G (5 h after its approval by then) too.
  assert.equal(await reminder.sweepFinance(createFakeBot(), { now: NOW + 4 * H }), 2);
});

test('a failed send is not remembered as sent; a row that is not approved is skipped', async () => {
  reset();
  waiting = [pay('PAY-H'), pay('PAY-I', { status: 'done' })];
  trail = { 'PAY-H': { approved: iso(9 * H) }, 'PAY-I': { approved: iso(9 * H) } };
  const orig = paymentCards.sendFinanceCard;
  paymentCards.sendFinanceCard = async () => ({ sent: 0, failed: 1 });
  try {
    assert.equal(await reminder.sweepFinance(createFakeBot(), { now: NOW }), 0);
  } finally { paymentCards.sendFinanceCard = orig; }
  // Nothing was remembered, so the next tick tries H again (and only H).
  assert.equal(await reminder.sweepFinance(createFakeBot(), { now: NOW + 1 }), 1);
  assert.deepEqual(sends.map((s) => s.paymentId), ['PAY-H']);
});

test('the combined sweep() runs the finance pass on the same tick and keeps returning the approval count', async () => {
  reset();
  settings = { APPROVAL_REMINDER_HOURS: 0 }; // admin reminders off — finance still runs
  waiting = [pay('PAY-J')];
  trail = { 'PAY-J': { approved: iso(5 * H) } };
  const sent = await reminder.sweep(createFakeBot(), { now: NOW });
  assert.equal(sent, 0, 'no approval cards (that pass is off)');
  assert.deepEqual(sends.map((s) => s.paymentId), ['PAY-J'], 'the finance nudge went out regardless');
});
