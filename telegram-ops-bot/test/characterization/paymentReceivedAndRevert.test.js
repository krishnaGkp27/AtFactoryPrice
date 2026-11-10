'use strict';

/**
 * APG-1 phase 3 — the two tap doors that replace typed AI sentences,
 * through the REAL controller:
 *
 *  PRC-1  💰 Finance → 💵 Payment Received: customer → amount → cash / bank
 *         → one `record_payment` request (a bank chip is stored as
 *         `Bank — <name>`, so it reaches the Bank ledger).
 *  REV-1  🛂 Approvals → ✅❌ Decided → an approved sale → ↩️ Revert this
 *         sale: asks first, raises one dual-admin `revert_sale_bundle`,
 *         and a sale is never offered a second revert.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const approvalGate = require(path.join(SRC, 'services/approvalGate'));
const saleRevert = require(path.join(SRC, 'services/saleRevert'));
const paymentReceivedFlow = require(path.join(SRC, 'flows/paymentReceivedFlow'));

let QUEUE = [];
let NOTIFIED = [];
approvalQueueRepository.append = async (rec) => { QUEUE.push({ createdAt: new Date().toISOString(), ...rec }); };
approvalQueueRepository.getByRequestId = async (id) => QUEUE.find((q) => String(q.requestId) === String(id)) || null;
approvalQueueRepository.getAllPending = async () => QUEUE.filter((q) => q.status === 'pending');
approvalQueueRepository.getAllWithRowIndex = async () => QUEUE.map((q, i) => ({ ...q, rowIndex: i + 2 }));
approvalQueueRepository.getResolved = async () => QUEUE.filter((q) => q.status !== 'pending');
auditLogRepository.append = async () => {};
customersRepository.getAll = async () => [
  { customer_id: 'C-1', name: 'ABBA', phone: '0801', status: 'Active', outstanding_balance: 120000 },
  { customer_id: 'C-2', name: 'Ibrahim Kano', phone: '0802', status: 'Active', outstanding_balance: 0 },
  { customer_id: 'C-3', name: 'Old Buyer', phone: '', status: 'inactive', outstanding_balance: 0 },
];
settingsRepository.getAll = async () => ({ BANK_LIST: 'Zenith, GTB — Main' });
transactionsRepository.findBySaleRef = async (ref) => (ref === 'SALE-1'
  ? [{ timestamp: '2026-11-01T10:00:00Z', user: '4242', action: 'sale_bundle', status: 'approved', saleRefId: 'SALE-1' }] : []);
approvalEvents.notifyAdminsApprovalRequest = async (bot, requestId, label, card, reason, excludeId) => {
  NOTIFIED.push({ requestId, label, card, reason, excludeId });
  return { sent: 2, failed: 0 };
};
approvalCards.resolveUserLabel = async (id) => ({ 777: 'Krishna', 888: 'Musa', 4242: 'Abdul' }[String(id)] || String(id));

const cq = (uid, data) => ({ id: `cq-${data}`, data, from: { id: Number(uid) }, message: { chat: { id: Number(uid) }, message_id: 77 } });
const msg = (uid, text) => ({ message_id: 5, text, from: { id: Number(uid) }, chat: { id: Number(uid), type: 'private' } });
function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}
function lastKb(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup && x.args.opts.reply_markup.inline_keyboard);
  const kb = c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => `${b.text}|${b.callback_data}`);
}
function reset() {
  QUEUE = []; NOTIFIED = [];
  ['777', '888', '4242'].forEach((u) => sessionStore.clear(u));
  approvalGate._internals.recent.clear();
}

/* ── PRC-1 ─────────────────────────────────────────────────────────────── */

test('PRC-1 registry: 💵 Payment Received sits in the Finance hub', () => {
  const a = activityRegistry.getActivity('payment_received');
  assert.ok(a);
  assert.equal(a.label, 'Payment Received');
  assert.equal(a.hub, 'finance');
});

test('PRC-1 parseAmount: digits, commas, k and m; nothing else', () => {
  const { parseAmount } = paymentReceivedFlow._internals;
  assert.equal(parseAmount('50000'), 50000);
  assert.equal(parseAmount('50,000'), 50000);
  assert.equal(parseAmount('₦ 1,250.50'), 1250.5);
  assert.equal(parseAmount('50k'), 50000);
  assert.equal(parseAmount('1.5m'), 1500000);
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount('-5'), null);
  assert.equal(parseAmount('fifty'), null);
  assert.equal(parseAmount('50000 cash'), null);
});

test('PRC-1: customer → amount → bank → confirm → ONE record_payment request, the admins told once', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('4242', 'act:payment_received'));
  assert.match(lastText(bot), /💵 \*Payment received\*\n\nWho paid\?\nTap the customer, or type part of the name\./);
  assert.deepEqual(lastKb(bot), ['👤 ABBA|prc:c:0', '👤 Ibrahim Kano|prc:c:1', '❌ Cancel|prc:cancel'], 'a removed customer is not offered');

  // a typed search narrows the list
  await controller.handleMessage(bot, msg('4242', 'ibra'));
  assert.deepEqual(lastKb(bot), ['👤 Ibrahim Kano|prc:c:0', '❌ Cancel|prc:cancel']);
  assert.match(lastText(bot), /🔎 _ibra_ · 1 match/);
  await controller.handleMessage(bot, msg('4242', 'abb'));
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:c:0'));
  assert.match(lastText(bot), /Customer: \*ABBA\*\n\nHow much did they pay\?/);
  assert.ok(!/120,?000/.test(lastText(bot)), 'the balance is never shown to the person entering the payment');

  await controller.handleMessage(bot, msg('4242', 'fifty thousand'));
  assert.match(lastText(bot), /That is not an amount/);
  await controller.handleMessage(bot, msg('4242', '50,000'));
  assert.match(lastText(bot), /Amount: \*50,000\*\n\nHow was it paid\?/);
  assert.deepEqual(lastKb(bot), ['💵 Cash|prc:m:0', '🏦 Zenith|prc:m:1', '🏦 GTB — Main|prc:m:2', '⬅ Back|prc:back', '❌ Cancel|prc:cancel']);

  await controller.handleCallbackQuery(bot, cq('4242', 'prc:m:1'));
  const confirm = lastText(bot);
  assert.match(confirm, /Customer: \*ABBA\*\nAmount: \*50,000\*\nPaid by: Bank — Zenith\nDate: \d{2}-[A-Z][a-z]{2}-\d{4}/);
  assert.match(confirm, /An admin approves it before the customer's balance moves\./);
  assert.equal(QUEUE.length, 0, 'nothing is raised before Submit');

  await controller.handleCallbackQuery(bot, cq('4242', 'prc:submit'));
  assert.equal(QUEUE.length, 1);
  const row = QUEUE[0];
  assert.equal(row.user, '4242');
  assert.equal(row.status, 'pending');
  assert.deepEqual(
    { action: row.actionJSON.action, customer: row.actionJSON.customer, customerId: row.actionJSON.customerId, amount: row.actionJSON.amount, method: row.actionJSON.method },
    { action: 'record_payment', customer: 'ABBA', customerId: 'C-1', amount: 50000, method: 'Bank — Zenith' });
  assert.match(row.actionJSON.method, /bank/i, 'the stored method reaches the Bank ledger');
  assert.equal(NOTIFIED.length, 1);
  assert.equal(NOTIFIED[0].excludeId, undefined, 'an employee\'s request goes to every admin');
  assert.match(NOTIFIED[0].card, /Record Payment Request\nCustomer: ABBA\nAmount: 50,000\nMethod: Bank — Zenith/);
  const receipt = lastText(bot);
  assert.match(receipt, /⏳ \*Sent for approval\*/);
  assert.ok(lastKb(bot).some((b) => b === `🔔 Remind approvers|apg:nudge:${row.requestId}`));
  assert.ok(lastKb(bot).some((b) => b === `📋 Status|apg:st:${row.requestId}`));
  assert.ok(!sessionStore.get('4242'), 'the flow is over');

  // a second Submit tap on the old card raises nothing
  await controller.handleCallbackQuery(bot, cq('4242', 'prc:submit'));
  assert.equal(QUEUE.length, 1);
  assert.equal(NOTIFIED.length, 1);
});

test('PRC-1: cash is stored as Cash; Back walks the steps; Cancel records nothing', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('777', 'act:payment_received'));
  await controller.handleCallbackQuery(bot, cq('777', 'prc:c:1'));
  await controller.handleMessage(bot, msg('777', '20k'));
  await controller.handleCallbackQuery(bot, cq('777', 'prc:m:0'));
  assert.match(lastText(bot), /Paid by: Cash/);
  await controller.handleCallbackQuery(bot, cq('777', 'prc:back'));
  assert.match(lastText(bot), /How was it paid\?/);
  await controller.handleCallbackQuery(bot, cq('777', 'prc:back'));
  assert.match(lastText(bot), /How much did they pay\?/);
  await controller.handleCallbackQuery(bot, cq('777', 'prc:back'));
  assert.match(lastText(bot), /Who paid\?/);
  await controller.handleCallbackQuery(bot, cq('777', 'prc:cancel'));
  assert.match(lastText(bot), /Payment entry cancelled\. Nothing was recorded\./);
  assert.equal(QUEUE.length, 0);

  // an admin's own request is not sent to themselves
  await controller.handleCallbackQuery(bot, cq('777', 'act:payment_received'));
  await controller.handleCallbackQuery(bot, cq('777', 'prc:c:1'));
  await controller.handleMessage(bot, msg('777', '20000'));
  await controller.handleCallbackQuery(bot, cq('777', 'prc:m:0'));
  await controller.handleCallbackQuery(bot, cq('777', 'prc:submit'));
  assert.equal(QUEUE.length, 1);
  assert.equal(QUEUE[0].actionJSON.method, 'Cash');
  assert.equal(NOTIFIED[0].excludeId, '777');
});

/* ── REV-1 ─────────────────────────────────────────────────────────────── */

const SALE = () => ({
  requestId: 'SALE-1', user: '4242', status: 'approved', approver: 'Musa', createdAt: '2026-11-01T09:00:00Z', resolvedAt: '2026-11-01T10:00:00Z',
  actionJSON: {
    action: 'sale_bundle', customer: 'ABBA', salesDate: '2026-11-01', totalYards: 450,
    items: [{ type: 'package', packageNo: '1111', warehouse: 'IDUMOTA' }, { type: 'package', packageNo: '1112', warehouse: 'IDUMOTA' }, { type: 'than', packageNo: '1100', thanNo: 1 }],
  },
});

test('REV-1 goodsOf: whole bales count once, loose thans as thans', () => {
  assert.equal(saleRevert.goodsOf(SALE().actionJSON), '2B + 1t · 450 yd');
  assert.equal(saleRevert.goodsOf({ items: [{ type: 'than', packageNo: '9', thanNo: 1 }, { type: 'than', packageNo: '9', thanNo: 2 }], wholeBales: ['9'], totalYards: 60 }), '1B · 60 yd');
});

test('REV-1: an admin asks for the revert of an approved sale — one dual-admin request that names the sale; a second is refused', async () => {
  reset();
  QUEUE.push(SALE());
  const res = await saleRevert.request({ bot: createFakeBot(), userId: '777', sale: QUEUE[0] });
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  const row = QUEUE[1];
  assert.equal(row.actionJSON.action, 'revert_sale_bundle');
  assert.equal(row.actionJSON.saleRefId, 'SALE-1');
  assert.deepEqual(
    { ts: row.actionJSON.txnTimestamp, user: row.actionJSON.txnUser, action: row.actionJSON.txnAction },
    { ts: '2026-11-01T10:00:00Z', user: '4242', action: 'sale_bundle' }, 'the Transactions row to mark reverted rides the request');
  assert.equal(row.actionJSON.customer, 'ABBA');
  assert.equal(row.actionJSON.goods, '2B + 1t · 450 yd');
  assert.equal(NOTIFIED.length, 1);
  assert.equal(NOTIFIED[0].excludeId, '777', 'the requester cannot approve their own');
  assert.match(NOTIFIED[0].card, /^↩️ Revert sale\nCustomer: ABBA\nGoods: 2B \+ 1t · 450 yd\nSale: 01-Nov-2026 · Ref /);
  // the inbox and the reminder rebuild the SAME card from the row
  assert.equal(await approvalCards.buildCardFromActionJSON(row.actionJSON), NOTIFIED[0].card);

  // while it waits, nobody can ask again
  assert.deepEqual((await saleRevert.stateOf('SALE-1')).state, 'pending');
  const again = await saleRevert.request({ bot: createFakeBot(), userId: '888', sale: QUEUE[0] });
  assert.equal(again.ok, false);
  assert.match(again.reason, /already waiting for approval/);
  assert.equal(QUEUE.length, 2);

  // once approved, the sale is reverted for good
  row.status = 'approved'; row.resolvedAt = '2026-11-02T08:00:00Z';
  assert.equal((await saleRevert.stateOf('SALE-1')).state, 'reverted');
  const after = await saleRevert.request({ bot: createFakeBot(), userId: '888', sale: QUEUE[0] });
  assert.match(after.reason, /already been reverted/);
});

test('REV-1: only an admin, only an approved sale; an unreadable record offers nothing', async () => {
  reset();
  QUEUE.push(SALE());
  assert.equal(saleRevert.eligible(QUEUE[0], '4242'), false, 'an employee');
  assert.equal(saleRevert.eligible({ ...SALE(), status: 'rejected' }, '777'), false, 'a rejected sale');
  assert.equal(saleRevert.eligible({ ...SALE(), actionJSON: { action: 'request_payment' } }, '777'), false, 'not a sale');
  const no = await saleRevert.request({ bot: createFakeBot(), userId: '4242', sale: QUEUE[0] });
  assert.equal(no.ok, false);
  const real = approvalQueueRepository.getAllWithRowIndex;
  approvalQueueRepository.getAllWithRowIndex = async () => { throw new Error('quota'); };
  try {
    assert.equal((await saleRevert.stateOf('SALE-1')).state, 'unknown');
    const res = await saleRevert.request({ bot: createFakeBot(), userId: '777', sale: QUEUE[0] });
    assert.equal(res.ok, false);
    assert.match(res.reason, /could not be read/);
  } finally { approvalQueueRepository.getAllWithRowIndex = real; }
  assert.equal(QUEUE.length, 1);
});

test('REV-1 through the inbox: the approved sale\'s record offers ↩️ Revert this sale, asks first, then shows it waiting', async () => {
  reset();
  QUEUE.push(SALE());
  const bot = createFakeBot();
  sessionStore.set('777', { type: 'approvals_inbox_flow', step: 'items', category: 'decided', _items: [QUEUE[0]], flowMessageId: 77 });
  await controller.handleCallbackQuery(bot, cq('777', 'abx:i:0'));
  assert.match(lastText(bot), /Already approved by Musa/);
  assert.ok(lastKb(bot).includes('↩️ Revert this sale|abx:rev:0'));

  await controller.handleCallbackQuery(bot, cq('777', 'abx:rev:0'));
  assert.match(lastText(bot), /↩️ \*Revert this sale\?\*/);
  assert.match(lastText(bot), /Two admins must approve\. You cannot approve your own request\./);
  assert.equal(QUEUE.length, 1, 'asking is not doing');
  assert.ok(lastKb(bot).includes('↩️ Yes, ask for the revert|abx:revyes:0'));

  await controller.handleCallbackQuery(bot, cq('777', 'abx:revyes:0'));
  assert.equal(QUEUE.length, 2);
  assert.equal(QUEUE[1].actionJSON.action, 'revert_sale_bundle');
  assert.match(lastText(bot), /⏳ \*Revert sent for approval\*\n\nABBA · 2B \+ 1t · 450 yd/);
  assert.match(lastText(bot), /Nothing changes until two admins approve it\./);
  assert.ok(lastKb(bot).some((b) => b.startsWith('🔔 Remind approvers|apg:nudge:')));

  // back on the record: no second button, the waiting line instead
  await controller.handleCallbackQuery(bot, cq('777', 'abx:i:0'));
  assert.match(lastText(bot), /↩️ _A revert is waiting for approval · /);
  assert.ok(!lastKb(bot).some((b) => b.includes('abx:rev:0')));

  // an employee looking at the same record is offered nothing
  const emp = createFakeBot();
  sessionStore.set('4242', { type: 'approvals_inbox_flow', step: 'items', category: 'decided', _items: [QUEUE[0]], flowMessageId: 77 });
  await controller.handleCallbackQuery(emp, cq('4242', 'abx:revyes:0'));
  assert.equal(QUEUE.length, 2);
});
