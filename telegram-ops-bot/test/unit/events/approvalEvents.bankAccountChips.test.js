'use strict';

/**
 * BANK-4 (owner, 17-Nov-2026) — the sale approval wizard's Step 3:
 *
 *   "I have 2 accounts in zenith bank whose abbreviation needs to be used to
 *    capture the payment in particular account for accounting. Let me know
 *    your proposal to add further chips when I select particular bank."
 *
 * One chip per BANK. A bank with two or more accounts registered under it
 * opens a second set of chips, one per account; nothing is stored until an
 * account is chosen. One account = stamped at the tap. No account = the
 * bank, exactly as before. A typed `Paid to Zenith` asks the same chips.
 *
 * Every repository reached is monkeypatched — no sheet, no Telegram.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const approvalEvents = require('../../../src/events/approvalEvents');
const menuAnchor = require('../../../src/services/menuAnchor');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const accountingService = require('../../../src/services/accountingService');

const { pendingEnrichment, wizKey, lastTouchedWizard, sendPaymentStep } = approvalEvents._internals;

const BANK_LIST = 'GTBank,Zenith,Zenith — AFP,Zenith — BP,FirstBank,UBA — MAIN';

let settings;
let drafts;
let executed;
const realExecute = inventoryService.executeApprovedAction;
const real = {
  getAll: settingsRepository.getAll,
  updateStatus: approvalQueueRepository.updateStatus,
  getByRequestId: approvalQueueRepository.getByRequestId,
  updateActionJSON: approvalQueueRepository.updateActionJSON,
  getCustomerLedger: accountingService.getCustomerLedger,
};

test.before(() => {
  settingsRepository.getAll = async () => ({ ...settings });
  approvalQueueRepository.updateStatus = async () => true;
  approvalQueueRepository.getByRequestId = async () => null;
  approvalQueueRepository.updateActionJSON = async (id, patch) => { drafts.push({ id, patch }); return true; };
  accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 0 });
  inventoryService.executeApprovedAction = async (requestId, adminId, enrichment) => {
    executed = { requestId, adminId, enrichment };
    return { ok: true };
  };
});
test.after(() => {
  settingsRepository.getAll = real.getAll;
  approvalQueueRepository.updateStatus = real.updateStatus;
  approvalQueueRepository.getByRequestId = real.getByRequestId;
  approvalQueueRepository.updateActionJSON = real.updateActionJSON;
  accountingService.getCustomerLedger = real.getCustomerLedger;
  inventoryService.executeApprovedAction = realExecute;
});

const CHAT = 1;
const ADMIN = '777';
const RID = 'R-BANK4';
const cbq = (data) => ({ id: 'q', data: `enr:q:${RID}:${data}`, from: { id: 777 }, message: { chat: { id: CHAT }, message_id: 2 } });
const lastCard = (bot) => bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1);
const rowsOf = (card) => (card.args.opts && card.args.opts.reply_markup ? card.args.opts.reply_markup.inline_keyboard : []);
const chips = (card) => rowsOf(card).flat();
const bankChips = (card) => chips(card).filter((b) => b.text.startsWith('🏦') && /:pay:[ab]:/.test(b.callback_data));
const lastAck = (bot) => bot.callsTo('answerCallbackQuery').at(-1).args.opts;

/** A wizard that has answered the rate and is about to be shown Step 3. */
function freshState() {
  const item = {
    requestId: RID, user: '555',
    actionJSON: { action: 'sale_bundle', customer: 'ABBA', yardsByDesign: { 9006: 100 }, items: [] },
  };
  const state = {
    requestId: RID, adminId: ADMIN, step: 'rate', item, requestingUser: '555',
    customer: 'ABBA', designs: ['9006'], unit: 'yard',
    ratePerUnitByDesign: { 9006: 10 }, startedAt: Date.now(),
  };
  pendingEnrichment.set(wizKey(ADMIN, RID), state);
  lastTouchedWizard.set(ADMIN, { requestId: RID, at: Date.now() });
  return state;
}

test.beforeEach(() => {
  menuAnchor._resetForTests();
  pendingEnrichment.clear();
  lastTouchedWizard.clear();
  settings = { BANK_LIST, INVOICE_MULTIPLIER_ASK: 0 };
  drafts = [];
  executed = null;
});

test('Step 3: one chip per bank — the bank with two accounts says how many, the one-account bank names it', async () => {
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);

  const card = lastCard(bot);
  assert.deepEqual(bankChips(card).map((b) => b.text),
    ['🏦 GTBank', '🏦 Zenith ▾ 2', '🏦 FirstBank', '🏦 UBA — MAIN']);
  assert.deepEqual(bankChips(card).map((b) => b.callback_data.split(':').slice(3).join(':')),
    ['pay:b:0', 'pay:b:1', 'pay:b:2', 'pay:b:3'], 'the index is the bank\'s');
  // The first row and the tail of the keyboard are untouched.
  assert.deepEqual(rowsOf(card)[0].map((b) => b.text), ['💵 Cash', '🕐 Not yet paid']);
  assert.deepEqual(chips(card).slice(-3).map((b) => b.text), ['✏️ Type payment mode', '🏦 Manage accounts', '⬅ Change rate']);
  assert.match(card.args.text, /\*Step 3 — Payment mode:\* tap below/);
  for (const b of chips(card)) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
});

test('tap the bank with two accounts: the same card asks which account, and NOTHING is stored yet', async () => {
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:1'));

  const card = lastCard(bot);
  assert.equal(card.method, 'editMessageText', 'the same card, redrawn');
  assert.match(card.args.text, /📋 \*Confirm sale — /);
  assert.match(card.args.text, /👤 ABBA\n\n\*Step 3 — Payment mode\*\n🏦 Zenith · which account\?/);
  assert.deepEqual(rowsOf(card).map((r) => r.map((b) => b.text)),
    [['🏦 AFP', '🏦 BP'], ['⬅ Back to payment modes']]);
  assert.equal(lastAck(bot).text, 'Zenith — which account?');
  assert.equal(state.step, 'payment', 'still Step 3');
  assert.equal(state.paymentMode, undefined, 'no mode stored');
  assert.equal(drafts.length, 0, 'no draft written');
  assert.equal(executed, null);
  for (const b of chips(card)) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
});

test('tap an account: stored as `Paid to Zenith — AFP`, the draft is saved, Step 4 names it', async () => {
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:1'));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:a:1:0'));

  assert.equal(state.paymentMode, 'Paid to Zenith — AFP');
  assert.equal(state.step, 'amount_paid');
  assert.equal(lastAck(bot).text, 'Zenith — AFP');
  assert.equal(drafts.at(-1).patch.enrichDraft.paymentMode, 'Paid to Zenith — AFP');
  const card = lastCard(bot);
  assert.match(card.args.text, /👤 ABBA · Paid to Zenith — AFP\n\n\*Step 4 — Amount paid:\*/);

  // …and the sale reaches the executor with exactly that mode.
  await approvalEvents.handleEnrichmentCallback(bot, cbq('amt:full'));
  assert.equal(executed.enrichment.paymentMode, 'Paid to Zenith — AFP');
  assert.equal(executed.enrichment.amountPaid, 1000);
});

test('the second account is its own chip: `Paid to Zenith — BP`', async () => {
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:1'));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:a:1:1'));
  assert.equal(state.paymentMode, 'Paid to Zenith — BP');
});

test('⬅ Back to payment modes returns to the bank chips; ⬅ Change payment mode from Step 4 does too', async () => {
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:1'));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:modes'));
  assert.deepEqual(bankChips(lastCard(bot)).map((b) => b.text),
    ['🏦 GTBank', '🏦 Zenith ▾ 2', '🏦 FirstBank', '🏦 UBA — MAIN']);
  assert.equal(state.bankPick, null, 'no bank is open any more');

  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:1'));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:a:1:0'));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('back:payment'));
  assert.equal(state.step, 'payment');
  assert.match(lastCard(bot).args.text, /\*Step 3 — Payment mode:\*/);
});

test('a bank with ONE account is stamped at the tap; a bank with none is the bank, as before', async () => {
  const bot = createFakeBot();
  let state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:3'));
  assert.equal(state.paymentMode, 'Paid to UBA — MAIN');
  assert.equal(state.step, 'amount_paid', 'no second screen');

  pendingEnrichment.clear();
  state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:0'));
  assert.equal(state.paymentMode, 'Paid to GTBank');
  assert.equal(state.step, 'amount_paid');
});

test('a list of plain banks only draws exactly the chips it drew before BANK-4', async () => {
  settings.BANK_LIST = 'GTBank,Zenith,FirstBank,Access,UBA,OPAY';
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  assert.deepEqual(bankChips(lastCard(bot)).map((b) => b.text),
    ['🏦 GTBank', '🏦 Zenith', '🏦 FirstBank', '🏦 Access', '🏦 UBA', '🏦 OPAY']);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:1'));
  assert.equal(state.paymentMode, 'Paid to Zenith');
});

test('typed `Paid to Zenith`: the account chips are asked — the sale is not sealed without an account', async () => {
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'Paid to Zenith');

  assert.equal(state.paymentMode, undefined);
  assert.equal(state.step, 'payment');
  assert.equal(executed, null);
  const card = lastCard(bot);
  assert.match(card.args.text, /🏦 Zenith · which account\?/);
  assert.deepEqual(bankChips(card).map((b) => b.text), ['🏦 AFP', '🏦 BP']);

  // With the chips open, the account's own name is enough.
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'bp');
  assert.equal(state.paymentMode, 'Paid to Zenith — BP');
  assert.equal(state.step, 'amount_paid');
});

test('with the account chips open, a typed word that is no account is refused — the sale is not sealed under it', async () => {
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:1'));
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'AF');

  assert.equal(executed, null, 'nothing was executed');
  assert.equal(state.paymentMode, undefined);
  assert.equal(state.step, 'payment');
  const card = lastCard(bot);
  assert.match(card.args.text, /🏦 Zenith · which account\?\n⚠️ “AF” is not an account at Zenith\. Tap one, or go back\./);
  assert.deepEqual(bankChips(card).map((b) => b.text), ['🏦 AFP', '🏦 BP'], 'the chips are still there');

  // The three whole-mode answers still work from this screen.
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'Cash');
  assert.equal(state.paymentMode, 'Cash');
  assert.equal(state.step, 'amount_paid');
});

test('typed with the account, with or without the dash: stored as registered', async () => {
  for (const typed of ['Paid to Zenith — AFP', 'paid to zenith afp', 'Paid to ZENITH - AFP']) {
    pendingEnrichment.clear();
    const bot = createFakeBot();
    const state = freshState();
    await sendPaymentStep(bot, CHAT, state);
    await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, typed);
    assert.equal(state.paymentMode, 'Paid to Zenith — AFP', typed);
    assert.equal(state.step, 'amount_paid', typed);
  }
});

test('a bare registered bank name is read as paid to it — never sealed as an unpaid sale under that word', async () => {
  // a bank with no account: straight to the amount
  let bot = createFakeBot();
  let state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'gtbank');
  assert.equal(executed, null, 'not finished as unpaid');
  assert.equal(state.paymentMode, 'Paid to GTBank');
  assert.equal(state.step, 'amount_paid');

  // a bank that holds accounts: the account chips
  pendingEnrichment.clear();
  bot = createFakeBot();
  state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'Zenith');
  assert.equal(executed, null);
  assert.equal(state.paymentMode, undefined);
  assert.deepEqual(bankChips(lastCard(bot)).map((b) => b.text), ['🏦 AFP', '🏦 BP']);

  // bank and account together
  pendingEnrichment.clear();
  bot = createFakeBot();
  state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'zenith bp');
  assert.equal(state.paymentMode, 'Paid to Zenith — BP');
  assert.equal(state.step, 'amount_paid');
});

test('a free word that names no bank is still stored as written and finishes unpaid, as before', async () => {
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'Credit');
  assert.equal(state.paymentMode, 'Credit');
  assert.equal(executed.enrichment.paymentMode, 'Credit');
  assert.equal(executed.enrichment.amountPaid, 0);
});

test('typed modes that name no registered bank behave exactly as before', async () => {
  // an unlisted bank is kept as typed and goes on to the amount
  let bot = createFakeBot();
  let state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'Paid to Moniepoint');
  assert.equal(state.paymentMode, 'Paid to Moniepoint');
  assert.equal(state.step, 'amount_paid');

  // Cash goes on to the amount
  pendingEnrichment.clear();
  bot = createFakeBot();
  state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'Cash');
  assert.equal(state.paymentMode, 'Cash');
  assert.equal(state.step, 'amount_paid');

  // Not yet paid finishes with nothing paid
  pendingEnrichment.clear();
  bot = createFakeBot();
  state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'Not yet paid');
  assert.equal(executed.enrichment.paymentMode, 'Not yet paid');
  assert.equal(executed.enrichment.amountPaid, 0);
});

test('an account chip that no longer exists says so and redraws the banks; nothing is stored', async () => {
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:1'));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:a:1:7'));
  assert.equal(lastAck(bot).text, 'Expired — pick again.');
  assert.equal(state.paymentMode, undefined);
  assert.match(lastCard(bot).args.text, /\*Step 3 — Payment mode:\*/);

  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:9'));
  assert.equal(lastAck(bot).text, 'Expired — pick again.');
  assert.equal(state.paymentMode, undefined);
});

test('an account chip tapped from another step does nothing', async () => {
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:0')); // → Step 4
  assert.equal(state.step, 'amount_paid');
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:a:1:0'));
  assert.equal(state.paymentMode, 'Paid to GTBank', 'the stale account chip changed nothing');
  assert.equal(state.step, 'amount_paid');
});

test('an account name with Markdown characters cannot break the card', async () => {
  settings.BANK_LIST = 'Zen_ith — A*FP,Zen_ith — B`P';
  const bot = createFakeBot();
  const state = freshState();
  await sendPaymentStep(bot, CHAT, state);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('pay:b:0'));
  const text = lastCard(bot).args.text;
  const line = text.split('\n').find((l) => l.startsWith('🏦'));
  assert.equal(line, '🏦 Zen ith · which account?', 'the bank name is printed without its control characters');
});
