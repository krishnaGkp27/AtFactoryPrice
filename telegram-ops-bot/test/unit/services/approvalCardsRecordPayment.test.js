'use strict';

/**
 * FIX-INBOX2 — the card of a customer's payment IN (`record_payment`: the
 * 💵 Payment Received door, or the typed line) rebuilt from its queue row.
 *
 * Every surface that draws a request again — the 🛂 inbox, the reminder
 * sweep, the requester's 🔔 Remind approvers, the Decided record — goes
 * through `buildCardFromActionJSON`. It had no branch for this type, so the
 * generic field list drew `record payment / Customer: ABBA / Amount: 50000`:
 * no method (cash, or which bank), no balance before and after, the amount
 * unformatted. Two admins sign this request, and the second usually signs
 * from one of those surfaces.
 *
 * Pinned:
 *  - a pending row rebuilds the first chat card's lines — method, what the
 *    customer owes today and after, the over-payment warning — bare (side B);
 *  - no `Date:` line on a rebuild (the row carries no payment date; the
 *    first card's own date line stays);
 *  - a DECIDED row is a record: what it carried, no ledger read, no balance;
 *  - the card never fails on a ledger that cannot be read;
 *  - two payments never read the same (D-4).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const accountingService = require(path.join(SRC, 'services/accountingService'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));

let LEDGER_READS = [];
function owes(amount) {
  LEDGER_READS = [];
  accountingService.getCustomerLedger = async (name) => { LEDGER_READS.push(name); return { outstandingAsOfToday: amount }; };
}

// The row the 💵 Payment Received door queues (paymentReceivedFlow.submit).
const DOOR = { action: 'record_payment', customer: 'ABBA', customerId: 'C-1', amount: 50000, method: 'Bank — ZENITH — BLACK PANTHER', source: 'payment_received_door' };
// The row the typed line queues: no id, the method as one word.
const TYPED = { action: 'record_payment', customer: 'Ibrahim', amount: 12500, method: 'cash' };

test('a pending payment rebuilds with the method and what the customer owes before and after', async () => {
  owes(200000);
  assert.equal(await approvalCards.buildCardFromActionJSON(DOOR),
    'Record Payment Request\nCustomer: ABBA\nAmount: 50,000\nMethod: Bank — ZENITH — BLACK PANTHER\n'
    + 'Outstanding today: 200,000\nAfter this payment: 150,000');
  assert.deepEqual(LEDGER_READS, ['ABBA'], 'one ledger read, by the name the first card used');
});

test('the typed line\'s row rebuilds the same way; the inbox\'s requester option changes nothing', async () => {
  owes(40000);
  const text = await approvalCards.buildCardFromActionJSON(TYPED, { requester: 'Abdul' });
  assert.equal(text, 'Record Payment Request\nCustomer: Ibrahim\nAmount: 12,500\nMethod: cash\nOutstanding today: 40,000\nAfter this payment: 27,500');
  assert.doesNotMatch(text, /₦/, 'a customer payment IN is side B — no naira sign (BUSINESS_RULES §17)');
});

test('a payment larger than the balance carries the warning on the rebuilt card too', async () => {
  owes(30000);
  const text = await approvalCards.buildCardFromActionJSON(DOOR);
  assert.match(text, /\nOutstanding today: 30,000\nAfter this payment: -20,000\n⚠️ Payment EXCEEDS the outstanding balance\.$/, `got: ${text}`);
});

test('a ledger that cannot be read still draws customer, amount and method, and says the balance is missing', async () => {
  accountingService.getCustomerLedger = async () => { throw new Error('sheets down'); };
  assert.equal(await approvalCards.buildCardFromActionJSON(DOOR),
    'Record Payment Request\nCustomer: ABBA\nAmount: 50,000\nMethod: Bank — ZENITH — BLACK PANTHER\n(Outstanding balance unavailable right now.)');
});

test('no Date line on a rebuild; the first chat card keeps the day the payment was entered', async () => {
  owes(200000);
  assert.doesNotMatch(await approvalCards.buildCardFromActionJSON(DOOR), /Date:/,
    'a card drawn days later must not print the day it was drawn as the payment\'s date');
  const first = await approvalCards.buildPaymentCard({ customer: 'ABBA', amount: 50000, method: 'Cash' });
  assert.match(first, /\nMethod: Cash\nDate: \d{2}-[A-Z][a-z]{2}-\d{4}\nOutstanding today: 200,000\nAfter this payment: 150,000$/, `got: ${first}`);
});

test('a decided payment is a record: what it carried, no ledger read, no balance', async () => {
  // Once approved, today's outstanding already holds this payment: an
  // "After this payment" line would subtract it twice — here it would warn
  // that a payment already booked EXCEEDS the balance.
  owes(0);
  const text = await approvalCards.buildCardFromActionJSON(DOOR, { decided: true });
  assert.equal(text, 'Record Payment Request\nCustomer: ABBA\nAmount: 50,000\nMethod: Bank — ZENITH — BLACK PANTHER');
  assert.deepEqual(LEDGER_READS, [], 'the record reads no ledger');
});

test('two payments never read the same: another customer, amount or bank is another card (D-4)', async () => {
  owes(200000);
  const card = (extra) => approvalCards.buildCardFromActionJSON({ ...DOOR, ...extra });
  const base = await card({});
  assert.notEqual(await card({ customer: 'CJE' }), base);
  assert.notEqual(await card({ amount: 50001 }), base);
  assert.notEqual(await card({ method: 'Cash' }), base, 'cash and a bank were one card before');
});

test('a row with no method says so; a row with no customer keeps the generic card and reads no ledger', async () => {
  owes(200000);
  assert.match(await approvalCards.buildCardFromActionJSON({ action: 'record_payment', customer: 'ABBA', amount: 50000 }), /\nMethod: —\n/);
  LEDGER_READS = [];
  assert.equal(await approvalCards.buildCardFromActionJSON({ action: 'record_payment', amount: 50000 }), 'record payment\nAmount: 50000');
  assert.deepEqual(LEDGER_READS, []);
});
