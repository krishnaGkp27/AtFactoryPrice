'use strict';

/**
 * PAY-4 — FOUR EYES ON THE MONEY.
 *
 * Owner ruling, 14-Sep-2026: "Make a rule that the person who is approving
 * shall not be paying from the same Telegram ID. Any time in the future
 * make a workaround this."
 *
 * Being the finance seat is not enough. An id that gave either approval has
 * forfeited the right to release THAT payment — permanently, with no knob,
 * no override and no once-only path. BUSINESS_RULES §13.
 */

process.env.ADMIN_IDS = '777,888';
process.env.FINANCE_IDS = '888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const paymentService = require(path.join(SRC, 'services/paymentService'));
const paymentCards = require(path.join(SRC, 'services/paymentCards'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const paymentEventsRepository = require(path.join(SRC, 'repositories/paymentEventsRepository'));

const PAY = {
  payment_id: 'PAY-0001',
  approval_request_id: 'REQ-1',
  payee_name: 'Abdul',
  payee_type: 'employee',
  amount_ngn: 6000,
  status: 'approved',
  raised_by: '4242',
  raised_at: '2026-09-13T10:39:00Z',
  approved_by: 'Krishna ‖ Musa',
};

function stubQueue(approvals) {
  approvalQueueRepository.getByRequestId = async () => ({
    requestId: 'REQ-1', status: 'pending',
    actionJSON: { action: 'request_payment', payment_id: 'PAY-0001', approvals },
  });
}

test('PAY-4: the finance seat may pay a payment it did NOT approve', async () => {
  stubQueue(['777']);                       // the other admin signed
  paymentEventsRepository.forPayment = async () => [];
  const gate = await paymentService.canExecute('888', PAY);
  assert.equal(gate.ok, true, 'the seat that did not sign releases the money');
});

test('PAY-4: the same id may NOT approve and then pay', async () => {
  stubQueue(['777', '888']);                // the finance seat signed too
  paymentEventsRepository.forPayment = async () => [];
  const gate = await paymentService.canExecute('888', PAY);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'approved_it', 'refused for approving, not for being a stranger');
  assert.ok(gate.approvers.includes('888'), 'the refusal names the evidence');
});

test('PAY-4: a non-finance id is still refused, and for the OTHER reason', async () => {
  stubQueue(['777']);
  const gate = await paymentService.canExecute('4242', PAY);
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'not_finance', 'the two refusals never collapse into one');
});

test('PAY-4: with no payment in hand the gate behaves exactly as before', async () => {
  stubQueue(['777', '888']);
  const gate = await paymentService.canExecute('888');
  assert.equal(gate.ok, true, 'list screens that ask only "are you finance" are unchanged');
});

test('PAY-4: approver ids come from the queue row, and fall back to the event trail', async (t) => {
  await t.test('queue row first', async () => {
    stubQueue(['777', '888']);
    paymentEventsRepository.forPayment = async () => [];
    assert.deepEqual(await paymentService.approverIdsFor(PAY), ['777', '888']);
  });

  await t.test('event trail when the queue row is gone', async () => {
    approvalQueueRepository.getByRequestId = async () => null;
    paymentEventsRepository.forPayment = async () => [
      { kind: 'raised', actor_id: '4242', detail: {} },
      { kind: 'approved', actor_id: '777', detail: { approverIds: ['777', '888'] } },
    ];
    assert.deepEqual(await paymentService.approverIdsFor(PAY), ['777', '888']);
  });

  await t.test('a throwing read never silently opens the gate', async () => {
    approvalQueueRepository.getByRequestId = async () => { throw new Error('sheets down'); };
    paymentEventsRepository.forPayment = async () => { throw new Error('pg down'); };
    assert.deepEqual(await paymentService.approverIdsFor(PAY), [],
      'unknown approvers block nobody, but nothing throws into the pay path');
  });
});

test('PAY-4: payableBy says whether ANY seat is left to release it', async () => {
  paymentEventsRepository.forPayment = async () => [];
  stubQueue(['777']);
  const ok = await paymentService.payableBy(PAY);
  assert.equal(ok.payable, true);
  assert.deepEqual(ok.eligible, ['888']);

  stubQueue(['777', '888']);
  const stuck = await paymentService.payableBy(PAY);
  assert.equal(stuck.payable, false, 'every seat signed it');
  assert.deepEqual(stuck.blocked, ['888']);
});

test('PAY-4: a signer\'s copy of the card loses ✔ Mark Done but keeps ✖ Decline', () => {
  const normal = paymentCards.financeKeyboard('PAY-0001').inline_keyboard.flat();
  assert.deepEqual(normal.map((b) => b.text), ['✔ Mark Done', '✖ Decline']);

  const signer = paymentCards.financeKeyboard('PAY-0001', { approvedIt: true }).inline_keyboard.flat();
  assert.deepEqual(signer.map((b) => b.text), ['✖ Decline'],
    'decline stays — it moves no money and is how a stuck payment is unstuck');
  assert.equal(signer[0].callback_data, 'pay:dec:PAY-0001');
});

test('PAY-4: the signer\'s card says why the button is gone', () => {
  const card = paymentCards.buildFinanceCard(PAY, { ok: true }, { reason: 'Total tp', approvedIt: true });
  assert.match(card, /You approved this one/);
  assert.match(card, /different hand must release the money/);
  const plain = paymentCards.buildFinanceCard(PAY, { ok: true }, { reason: 'Total tp' });
  assert.doesNotMatch(plain, /You approved this one/, 'said only on the copy it applies to');
});
