'use strict';

/**
 * CUR-1 — approvalCards.js prints for BOTH sides of the books
 * (BUSINESS_RULES §17), so the two must be provably kept apart:
 *
 *   Side B (bare, no symbol): the sale, return-credit, customer-payment-IN,
 *     credit-limit and "Owes" lines — the printed output of approvals that
 *     write the Inventory sheet or the customer ledger.
 *   Side A (₦): PAY-1 `request_payment` — money LEAVING the office. Its card
 *     lives in paymentCards.js; approvalCards only delegates to it.
 *
 * S-CUR rule 5 (CUR-1 §6): the inbox rebuild of a `request_payment` row
 * still shows ₦, and the generic field list prints `price` / `amount` raw
 * — never through a side-A formatter.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../../helpers/controllerHarness');
const { cb } = require('../../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const flow = require(path.join(SRC, 'flows/approvalsInboxFlow'));

approvalCards.resolveUserLabel = async (id) => ({ 4242: 'Abdul' }[String(id)] || String(id));

const ADMIN = '777';

/** The queue row paymentFlow writes for an outgoing payment (PAY-1). */
const PAYMENT_ROW = {
  requestId: 'PAY-1', user: '4242', status: 'pending', createdAt: new Date().toISOString(),
  actionJSON: {
    action: 'request_payment', payment_id: 'P-0001', payee_name: 'Musa Bello',
    amount_ngn: 45000, account_number: '0123456789', bank: 'GTB', above_threshold: false,
    // PAY-2 — the reason rides the payload so every rebuild prints it.
    reason: 'Transport to Idumota',
  },
};

function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
    && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}
function lastText(bot) {
  const withText = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
  return withText.length ? withText[withText.length - 1].args.text : '';
}

test('S-CUR rule 5: the inbox rebuild of a request_payment row still shows ₦ (side A)', async () => {
  const orig = approvalQueueRepository.getAllPending;
  approvalQueueRepository.getAllPending = async () => [PAYMENT_ROW];
  try {
    const bot = createFakeBot();
    await flow.start(bot, ADMIN, ADMIN, null);
    const cats = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:cat:'));
    assert.equal(cats.length, 1, `one group holds the row: ${cats.map((b) => b.callback_data)}`);
    await flow.handleCallback(bot, cb(cats[0].callback_data, ADMIN));
    const items = lastKb(bot).filter((b) => b.callback_data.startsWith('abx:i:'));
    assert.equal(items.length, 1);
    await flow.handleCallback(bot, cb(items[0].callback_data, ADMIN));
    const text = lastText(bot);
    assert.match(text, /₦45,000/, `the outgoing amount keeps the naira symbol, got: ${text}`);
    assert.match(text, /Musa Bello/, 'the payee is named — two payment requests never read identically');
    assert.match(text, /0123456789/, 'the account the money leaves to');
    assert.match(text, /Reason: Transport to Idumota/, 'PAY-2 — the reason rides the inbox rebuild');
  } finally {
    approvalQueueRepository.getAllPending = orig;
    sessionStore.clear(ADMIN);
  }
});

test('S-CUR rule 5: the request_payment rebuild is the side-A builder\'s text, not the generic list', async () => {
  const paymentCards = require(path.join(SRC, 'services/paymentCards'));
  const card = await approvalCards.buildCardFromActionJSON(PAYMENT_ROW.actionJSON);
  assert.equal(card, paymentCards.buildApprovalSummary({ ...PAYMENT_ROW.actionJSON, payee_type: '?' }));
  assert.match(card, /Payment request: ₦45,000/);
  // PAY-2 — the Reason line sits after Account, before the badge / bill lines.
  assert.match(card, /Account: 0123456789 · GTB\nReason: Transport to Idumota/);
  const noReason = await approvalCards.buildCardFromActionJSON({ ...PAYMENT_ROW.actionJSON, reason: undefined });
  assert.doesNotMatch(noReason, /Reason:/, 'a pre-PAY-2 row prints no empty Reason line');
  // A large one carries the badge the notify-time card carries.
  const big = await approvalCards.buildCardFromActionJSON({ ...PAYMENT_ROW.actionJSON, amount_ngn: 250000, above_threshold: true });
  assert.match(big, /₦250,000/);
  assert.match(big, /Reason: Transport to Idumota\n⚠️ LARGE PAYMENT/);
});

test('S-CUR rule 5: the generic field list prints price / amount RAW — bare, never via a side-A formatter', async () => {
  const card = await approvalCards.buildCardFromActionJSON({ action: 'update_price', design: 'Cashmere', price: 1450 });
  assert.match(card, /Price: 1450/);
  assert.doesNotMatch(card, /₦/);
  // An outgoing-payment key must never be swept into that list: a row that
  // carries only `amount_ngn` under some future action prints NO figure
  // rather than a bare one (the side-A builder is the only door for it).
  const stray = await approvalCards.buildCardFromActionJSON({ action: 'some_future_action', amount_ngn: 45000 });
  assert.doesNotMatch(stray, /45,?000/, 'no side-A amount leaks bare through the generic rows');
});

test('the side-B cards carry no naira symbol, and the whole file spells none outside comments', async () => {
  accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 200000 });
  const pay = await approvalCards.buildPaymentCard({ customer: 'OKESON', amount: 50000, method: 'bank' });
  assert.match(pay, /Amount: 50,000/);
  assert.doesNotMatch(pay, /₦/);

  const contact = await approvalCards.buildCardFromActionJSON({ action: 'add_contact', name: 'ACME', type: 'customer', credit_limit: 250000 });
  assert.match(contact, /💳 limit 250,000/);

  const removal = await approvalCards.buildCardFromActionJSON({ action: 'remove_customer', name: 'Mr femi', outstanding_balance: 250000 });
  assert.match(removal, /Owes 250,000/);
  assert.doesNotMatch(removal, /₦/);

  // The source itself: ₦ may sit in a comment, never in code (S-CUR rule 1).
  const src = fs.readFileSync(path.join(SRC, 'services/approvalCards.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/[^'"`]\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(code, /₦/, 'approvalCards.js spells the symbol only in comments');
  assert.doesNotMatch(code, /toLocaleString\('en-NG'\)/, 'every money figure goes through the money module');
});
