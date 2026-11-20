'use strict';

/**
 * RET-8 (owner, 20-Nov-2026) — a return whose sale record has no rate for
 * some thans: the admin who approves first enters the missing rate, and the
 * credit posts with the return.
 *
 * Driven through the REAL controller, the real approval handler, the real
 * executor and the real ApprovalQueue / Inventory / Transactions
 * repositories on the in-memory sheet. The ledger (accountingService) and
 * the last-paid lookup are stand-ins.
 */

process.env.ADMIN_IDS = '777,888,999';
process.env.EMPLOYEE_IDS = '555';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

const INV_HEADERS = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
function invRow(pkg, than, soldTo, design, rate, wh = 'Lagos') {
  return [pkg, '', '', design, '01', String(than), '30', 'sold', wh, String(rate), '2026-07-01',
    soldTo, '2026-11-02', '', '', '', 'fabric', `UID-${pkg}-${than}`, '2026-07-01', '', '', 'Jul26', ''];
}
const INVENTORY = [
  INV_HEADERS,
  invRow('9300', 1, 'solder madam', '44200', 0),
  invRow('9300', 2, 'solder madam', '44200', 0),
  invRow('9301', 1, 'solder madam', '9060-A', 1000),
  invRow('6190', 1, 'ABBA', '77015', 0),
  invRow('6189', 5, 'ABBA', '77014', 1000),
  invRow('5801', 1, 'solder madam', '44200', 0, 'Kano office'),
  invRow('5801', 2, 'solder madam', '44200', 0, 'Kano office'),
];
const CUS_HEADERS = ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases'];
const QUEUE_HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'];

const fake = createFakeSheets({
  Inventory: INVENTORY.map((r) => r.slice()),
  Customers: [
    CUS_HEADERS,
    ['CUS-S', 'solder madam', '080', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
    ['CUS-A', 'ABBA', '081', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
  ],
  ApprovalQueue: [QUEUE_HEADERS],
});
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const auditService = require(path.join(SRC, 'services/auditService'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const approvalGate = require(path.join(SRC, 'services/approvalGate'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const stockEngine = require(path.join(SRC, 'services/stockEngine'));
const returnRate = require(path.join(SRC, 'services/returnRate'));

const EMP = '555';
const A1 = '777';
const A2 = '888';
const A3 = '999';
const NAMES = { [A1]: 'Musa', [A2]: 'Krishna', [A3]: 'John', [EMP]: 'Abdul' };

usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: NAMES[String(id)] || String(id), role: String(id) === EMP ? 'employee' : 'admin' });
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);
auditService.log = async () => true;
if (stockEngine._internals && stockEngine._internals.shadow) stockEngine._internals.shadow = async () => {};
let AUDIT = [];
let CREDITS = [];
auditLogRepository.append = async (event, payload, by) => { AUDIT.push({ event, payload, by }); };
accountingService.recordReturn = async (data) => { CREDITS.push(data); };
accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 500000 });
let LAST_PAID = 1450;
approvalEvents.getLastPaidRate = async () => LAST_PAID;
const realUpdate = approvalQueueRepository.updateActionJSON;

function reset() {
  fake._store.set('Inventory', INVENTORY.map((r) => r.slice()));
  fake._store.set('ApprovalQueue', [[...QUEUE_HEADERS]]);
  fake._store.set('Transactions', []);
  [EMP, A1, A2, A3].forEach((id) => sessionStore.clear(id));
  approvalGate._internals.recent.clear();
  AUDIT = [];
  CREDITS = [];
  LAST_PAID = 1450;
  approvalQueueRepository.updateActionJSON = realUpdate;
}

let seq = 0;
function uuid() {
  seq += 1;
  return `c6770000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

/** The bundle items of the inventory rows above (as the typed flow stores them). */
function item(pkg, than, customer, customerId, design, rate, wh = 'Lagos') {
  return {
    packageNo: pkg, thanNo: than, baleUid: `UID-${pkg}-${than}`, warehouse: wh, design, shade: '01',
    arrivalBatch: 'Jul26', yards: 30, pricePerYard: rate, soldTo: customer, customer, customerId, soldOn: '2026-11-02',
  };
}
const SOLDER = [
  item('9300', 1, 'solder madam', 'CUS-S', '44200', 0),
  item('9300', 2, 'solder madam', 'CUS-S', '44200', 0),
  item('9301', 1, 'solder madam', 'CUS-S', '9060-A', 1000),
];
function bundleAJ(items = SOLDER, extra = {}) {
  const groups = [];
  for (const it of items) {
    let g = groups.find((x) => x.customerId === it.customerId);
    if (!g) { g = { customer: it.customer, customerId: it.customerId, thans: 0, yards: 0, amount: 0, noRateThans: 0, qty: '' }; groups.push(g); }
    g.thans += 1; g.yards += it.yards;
    if (it.pricePerYard > 0) g.amount += it.yards * it.pricePerYard; else g.noRateThans += 1;
  }
  return {
    action: 'return_bundle', items, wholeBales: [], storedFacts: 1, groups, stores: ['Lagos'], qty: `${items.length}t`,
    thans: items.length, yards: items.length * 30, returnedOn: '2026-11-19', condition: 'good', conditionNote: '',
    return_photo_file_id: '', return_photo_type: '', ...extra,
  };
}
function thansAJ(extra = {}) {
  return {
    action: 'return_thans', packageNo: '5801', warehouse: 'Kano office', thanNos: [1, 2],
    customer: 'solder madam', customerId: 'CUS-S', returnedOn: '2026-11-19', condition: 'good', conditionNote: '',
    return_photo_file_id: '', return_photo_type: '', pricePerYard: 0, yards: 60, design: '44200', shade: '01',
    thanRates: [{ thanNo: 1, yards: 30, rate: 0 }, { thanNo: 2, yards: 30, rate: 0 }], ...extra,
  };
}
function seed(aj, user = EMP) {
  const id = uuid();
  fake._store.get('ApprovalQueue').push([id, user, JSON.stringify(aj), 'All return operations require two-admin approval.', 'pending', new Date().toISOString(), '', '']);
  return id;
}
const rowOf = (id) => fake._store.get('ApprovalQueue').slice(1).find((r) => r[0] === id);
const jsonOf = (id) => JSON.parse(rowOf(id)[2]);
const statusOf = (id) => rowOf(id)[4];
const msg = (uid, text) => ({ message_id: 77, chat: { id: uid, type: 'private' }, from: { id: uid, first_name: 'X' }, text });

const toChat = (bot, uid, from = 0) => bot.calls.slice(from).filter((c) => (c.method === 'sendMessage' && String(c.args.chatId) === String(uid))
  || (c.method === 'editMessageText' && String(c.args.opts && c.args.opts.chat_id) === String(uid)));
function lastScreen(bot, uid, from = 0) {
  const all = toChat(bot, uid, from);
  const last = all[all.length - 1];
  if (!last) return { text: '', chips: [] };
  const kb = (last.args.opts && last.args.opts.reply_markup && last.args.opts.reply_markup.inline_keyboard) || [];
  return { text: String(last.args.text), chips: kb.flat().map((b) => `${b.text}|${b.callback_data}`), call: last };
}
const screenMatching = (bot, uid, re, from = 0) => toChat(bot, uid, from).filter((c) => re.test(String(c.args.text))).pop();
const chipsOf = (call) => ((call && call.args.opts && call.args.opts.reply_markup && call.args.opts.reply_markup.inline_keyboard) || []).flat()
  .map((b) => `${b.text}|${b.callback_data}`);
const toasts = (bot, from = 0) => bot.calls.slice(from).filter((c) => c.method === 'answerCallbackQuery').map((c) => (c.args.opts && c.args.opts.text) || '');
const chip = (chips, re) => {
  const c = chips.find((x) => re.test(x));
  assert.ok(c, `a chip matching ${re}: ${JSON.stringify(chips)}`);
  return c.split('|').pop();
};
const plain = (s) => String(s).replace(/\\/g, '');

/** Admin taps ✅ Approve on a card (message 51) → the rate step opens. */
async function openStep(bot, uid, id) {
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, uid, 51));
  return lastScreen(bot, uid, from);
}

test('bundle, two admins: the first is asked, types the rate, confirms and signs; the second checks it on an old card; the credit posts', async () => {
  reset();
  const bot = createFakeBot();
  // The employee raises it through the typed line: the confirm card says the approver is asked.
  await controller.handleMessage(bot, msg(EMP, 'Return 9300, 9301'));
  const cardId = sessionStore.get(EMP).flowMessageId;
  await controller.handleCallbackQuery(bot, cb('rb:go', EMP, cardId));
  const today = lastScreen(bot, EMP).chips.find((c) => c.includes('|rb:dd:')).split('|').pop();
  await controller.handleCallbackQuery(bot, cb(today, EMP, cardId));
  await controller.handleCallbackQuery(bot, cb('rb:c:good', EMP, cardId));
  await controller.handleCallbackQuery(bot, cb('rb:pskip', EMP, cardId));
  assert.match(plain(lastScreen(bot, EMP).text), /⚠️ Thans without a rate: the approving admin is asked for the rate\./);
  assert.doesNotMatch(lastScreen(bot, EMP).text, /NO credit posts/);
  await controller.handleCallbackQuery(bot, cb('rb:submit', EMP, cardId));
  const id = fake._store.get('ApprovalQueue')[1][0];
  const ref = approvalCards.shortRequestRef(id);
  const dm = screenMatching(bot, A1, /Approval required/);
  assert.match(plain(dm.args.text), /⚠️ No rate on the sale record: solder madam · 44200 · 2 thans\. The admin who approves first is asked for it\./);
  assert.match(plain(dm.args.text), /💰 solder madam 30,000 · outstanding 500,000 → 470,000/, 'the rated than is still shown');

  // Musa taps ✅ Approve → the rate step, nothing signed.
  let from = bot.calls.length;
  const step = await openStep(bot, A1, id);
  assert.ok(toasts(bot, from).includes('Type the rate first.'));
  assert.equal(step.text, [
    `↩️ Return ${ref} · rate needed`, '',
    'solder madam · 44200',
    '2 thans · 60 yd have no rate on the sale record.', '',
    'Type the rate per yard this customer was charged, for example 1450.',
    'Nothing is approved until you confirm.',
  ].join('\n'));
  assert.deepEqual(step.chips.map((c) => c.split('|')[0]),
    ['1,450/yd — last paid by solder madam', '⏭ No credit for these', '✏️ Type the rate', '✖ Not now']);
  assert.equal(step.call.args.opts.reply_to_message_id, 51, 'a reply to the approval card');
  assert.deepEqual(jsonOf(id).approvals || [], []);
  assert.equal(sessionStore.get(A1).step, 'admin_rate');

  // A wrong number is refused on the card with one plain line.
  from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, '0'));
  assert.match(lastScreen(bot, A1, from).text, /⚠️ That is not a rate\. Type a number above zero, for example 1450\.$/);

  // 1450 typed → the check card (not the bale card reader).
  from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, '1450'));
  const check = lastScreen(bot, A1, from);
  assert.equal(check.text, [
    `↩️ Return ${ref} · check the credit`, '',
    'solder madam · 44200 · 2 thans · 60 yd',
    '1,450/yd → credit 87,000',
    'Credit for solder madam on this return: 117,000',
    'Outstanding 500,000 → 383,000', '',
    'Your approval is the first of two. A second admin checks the rate.',
  ].join('\n'));
  assert.deepEqual(check.chips.map((c) => c.split('|')[0]), ['✅ Approve with this credit', '✏️ Change rate', '✖ Not now']);
  assert.deepEqual(jsonOf(id).approvals || [], [], 'typing records nothing');

  // ✅ Approve with this credit → fills saved, Musa's signature carries the print.
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, check.call.args.opts.message_id || 1));
  const aj = jsonOf(id);
  assert.equal(statusOf(id), 'pending');
  assert.deepEqual(aj.rateFill.map((f) => [f.customer, f.design, f.thans, f.yards, f.rate]), [['solder madam', '44200', 2, 60, 1450]]);
  assert.equal(aj.rateFillBy.id, A1);
  assert.equal(aj.rateFillBy.name, 'Musa');
  assert.deepEqual(aj.approvals, [A1]);
  assert.equal(aj.signoffs[0].ratePrint, returnRate.printOf(aj.rateFill));
  const audit = AUDIT.find((a) => a.event === 'return_rate_entered');
  assert.ok(audit, 'an AuditLog line');
  assert.equal(audit.payload.requestId, id);
  assert.equal(audit.payload.admin.id, A1);
  assert.equal(audit.payload.fills[0].rate, 1450);
  // Every other admin gets the FULL card again, now showing the credit.
  for (const other of [A2, A3]) {
    const full = screenMatching(bot, other, /Approval required/, from);
    assert.ok(full, `${other} got the full card`);
    const t = plain(full.args.text);
    assert.match(t, /🔏 1 of 2 — signed by Musa\. Yours is the second approval\./);
    assert.match(t, /💰 solder madam 117,000 · outstanding 500,000 → 383,000\n {3}44200 at 1,450\/yd — entered by Musa/);
  }
  assert.match(lastScreen(bot, A1).text, /✅ You entered the rate and gave approval 1 of 2\. A second admin checks it\./);

  // Krishna taps his OLD card → the check card, nothing signed.
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 61));
  const second = lastScreen(bot, A2, from);
  assert.match(second.text, /^↩️ Return R-[0-9A-F]{4} · check the credit\n\nsolder madam · 44200 · 2 thans · 60 yd\n1,450\/yd → credit 87,000\nCredit for solder madam on this return: 117,000\nOutstanding 500,000 → 383,000\n\nMusa typed this rate\. Check it before you approve\.\nYour approval completes the return\.$/);
  assert.deepEqual(second.chips.map((c) => c.split('|')[0]), ['✅ Approve · credit 117,000', '✖ Not now']);
  assert.equal(statusOf(id), 'pending');
  assert.deepEqual(jsonOf(id).approvals, [A1]);

  // His chip completes it: the ledger credit and Transactions carry the entered rate.
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(second.chips, /^✅ Approve ·/), A2, 62));
  assert.equal(statusOf(id), 'approved');
  assert.equal(CREDITS.length, 1, 'one ledger credit per buyer');
  assert.equal(CREDITS[0].customer, 'solder madam');
  assert.equal(CREDITS[0].yards, 90);
  assert.equal(Math.round(CREDITS[0].yards * CREDITS[0].pricePerYard), 117000, '87,000 entered + 30,000 at the than\'s own rate');
  const txns = (fake._store.get('Transactions') || []).filter((r) => r.includes('return_bundle'));
  assert.equal(txns.length, 1, 'one Transactions row per buyer');
  assert.ok(txns[0].some((c) => Math.abs(Number(c) - 1300) < 0.01), `the row carries the credited rate: ${JSON.stringify(txns[0])}`);
  const reply = toChat(bot, A2, from).map((c) => c.args.text).join('\n');
  assert.match(reply, /↩️ Credited solder madam 117,000 \(3 thans, 90 yd\)\./);
  assert.match(reply, /✏️ solder madam · 44200 at 1,450\/yd, entered by Musa/);
  // The employee is told the credit, never the rate.
  const toEmp = toChat(bot, EMP, from).map((c) => c.args.text).join('\n');
  assert.match(toEmp, /117,000/);
  assert.doesNotMatch(toEmp, /1,450/);
  // The than that had its own rate kept it.
  const inv = fake._store.get('Inventory').slice(1);
  assert.equal(inv.find((r) => r[0] === '9301')[7], 'available');
  assert.equal(Number(inv.find((r) => r[0] === '9301')[9]), 1000);
});

test('return_thans (one bale): the last-paid chip, then a second admin checks and completes', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(thansAJ());
  const card = await approvalCards.buildCardFromActionJSON(thansAJ());
  assert.match(card, /⚠️ No rate on the sale record: solder madam · 44200 · 2 thans\. The admin who approves first is asked for it\./);
  const step = await openStep(bot, A1, id);
  assert.match(step.text, /rate needed\n\nsolder madam · 44200\n2 thans · 60 yd have no rate/);
  let from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(step.chips, /last paid by/), A1, 1));
  const check = lastScreen(bot, A1, from);
  assert.match(check.text, /1,450\/yd → credit 87,000\nOutstanding 500,000 → 413,000\n\nYour approval is the first of two\./);
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, 1));
  assert.deepEqual(jsonOf(id).approvals, [A1]);
  const filledCard = await approvalCards.buildCardFromActionJSON(jsonOf(id));
  assert.match(filledCard, /💰 Credits solder madam 87,000\nOutstanding 500,000 → 413,000\n {3}44200 at 1,450\/yd — entered by Musa/);
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A3, 71));
  const second = lastScreen(bot, A3, from);
  assert.match(second.text, /Musa typed this rate\. Check it before you approve\./);
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(second.chips, /credit 87,000/), A3, 72));
  assert.equal(statusOf(id), 'approved');
  assert.equal(CREDITS.length, 1);
  assert.equal(CREDITS[0].yards, 60);
  assert.equal(CREDITS[0].pricePerYard, 1450);
  assert.match(toChat(bot, A3, from).map((c) => c.args.text).join('\n'), /✏️ solder madam · 44200 at 1,450\/yd, entered by Musa/);
});

test('⏭ No credit for these is a choice: the card says who chose it and nothing is credited for the gap', async () => {
  reset();
  const bot = createFakeBot();
  const items = SOLDER.slice(0, 2);
  const id = seed(bundleAJ(items));
  const step = await openStep(bot, A1, id);
  let from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(step.chips, /No credit/), A1, 1));
  const check = lastScreen(bot, A1, from);
  assert.match(check.text, /solder madam · 44200 · 2 thans · 60 yd\nno credit\nOutstanding 500,000 → 500,000/);
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, 1));
  assert.equal(jsonOf(id).rateFill[0].noCredit, true);
  const card = plain(await approvalCards.buildCardFromActionJSON(jsonOf(id)));
  assert.match(card, /⚠️ solder madam · 44200 · 2 thans: no credit — chosen by Musa/);
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 81));
  const second = lastScreen(bot, A2, from);
  assert.deepEqual(second.chips.map((c) => c.split('|')[0]), ['✅ Approve · no credit', '✖ Not now']);
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(second.chips, /no credit/), A2, 82));
  assert.equal(statusOf(id), 'approved');
  assert.ok(CREDITS.every((c) => !(Number(c.pricePerYard) > 0)), 'nothing credited for the gap');
  assert.match(toChat(bot, A2, from).map((c) => c.args.text).join('\n'), /✏️ solder madam · 44200: no credit — chosen by Musa/);
});

test('several gaps: one prompt per gap ("1 of 2"), then one check card with a block per buyer', async () => {
  reset();
  const bot = createFakeBot();
  const items = [...SOLDER.slice(0, 2), item('6190', 1, 'ABBA', 'CUS-A', '77015', 0), item('6189', 5, 'ABBA', 'CUS-A', '77014', 1000)];
  const id = seed(bundleAJ(items));
  const step = await openStep(bot, A1, id);
  assert.match(step.text, / · rate needed · 1 of 2\n\nABBA · 77015\n1 than · 30 yd has no rate/);
  await controller.handleMessage(bot, msg(A1, '900'));
  const s2 = lastScreen(bot, A1);
  assert.match(s2.text, / · rate needed · 2 of 2\n\nsolder madam · 44200\n/);
  await controller.handleMessage(bot, msg(A1, '3.20'));
  const check = lastScreen(bot, A1);
  assert.match(check.text, /ABBA · 77015 · 1 than · 30 yd\n900\/yd → credit 27,000\nCredit for ABBA on this return: 57,000\nOutstanding 500,000 → 443,000\n\nsolder madam · 44200 · 2 thans · 60 yd\n3\.20\/yd → credit 192\nOutstanding 500,000 → 499,808/);
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, 1));
  assert.deepEqual(jsonOf(id).rateFill.map((f) => [f.customer, f.rate]), [['ABBA', 900], ['solder madam', 3.2]]);
  assert.deepEqual(jsonOf(id).approvals, [A1]);
});

test('an admin requester: one other admin is asked, and their confirmation completes the return', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ(), A1);
  const step = await openStep(bot, A2, id);
  assert.match(step.text, /rate needed/);
  await controller.handleMessage(bot, msg(A2, '1450'));
  const check = lastScreen(bot, A2);
  assert.match(check.text, /\n\nYour approval completes the return\.$/);
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A2, 1));
  assert.equal(statusOf(id), 'approved');
  assert.equal(CREDITS.length, 1);
  assert.equal(Math.round(CREDITS[0].yards * CREDITS[0].pricePerYard), 117000);
  // The requester cannot use the step on their own request.
  const id2 = seed(bundleAJ(), A1);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`rb:re:${id2}`, A1, 1));
  assert.ok(toasts(bot, from).some((t) => /cannot enter the rate on your own request/.test(t)));
  assert.equal(jsonOf(id2).rateFill, undefined);
});

test('✖ Not now changes nothing; ✏️ Type the rate re-opens the step after the session is gone', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  const step = await openStep(bot, A1, id);
  let from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(step.chips, /Not now/), A1, 1));
  assert.equal(lastScreen(bot, A1, from).text, 'Nothing was approved. The request still waits.');
  assert.ok(!sessionStore.get(A1), 'the step is closed');
  assert.equal(statusOf(id), 'pending');
  assert.equal(jsonOf(id).rateFill, undefined);
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`rb:re:${id}`, A1, 1));
  assert.match(lastScreen(bot, A1, from).text, /rate needed/);
  assert.equal(sessionStore.get(A1).step, 'admin_rate');
});

test('the session lost between typing and confirming: the ✅ chip approves nothing', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  await controller.handleMessage(bot, msg(A1, '1450'));
  const check = lastScreen(bot, A1);
  sessionStore.clear(A1);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, 1));
  assert.match(lastScreen(bot, A1, from).text, /This step expired — nothing was approved/);
  assert.equal(jsonOf(id).rateFill, undefined);
  assert.deepEqual(jsonOf(id).approvals || [], []);
});

test('a stale chip after another admin filled the rate approves nothing and says who entered it', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  await openStep(bot, A2, id);
  await controller.handleMessage(bot, msg(A2, '1500'));
  const staleCheck = lastScreen(bot, A2);
  await controller.handleMessage(bot, msg(A1, '1450'));
  const check = lastScreen(bot, A1);
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, 1));
  assert.equal(jsonOf(id).rateFillBy.id, A1);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(staleCheck.chips, /^✅ Approve with/), A2, 1));
  assert.match(lastScreen(bot, A2, from).text, /Musa already entered the rate for this return/);
  assert.equal(jsonOf(id).rateFill[0].rate, 1450, 'the first fill stands');
  assert.deepEqual(jsonOf(id).approvals, [A1]);
  // A typed rate on a filled request is told the same.
  await openStep(bot, A3, id);   // A3 now gets the check card, not a step
  assert.match(lastScreen(bot, A3).text, /Musa typed this rate/);
});

test('two admins confirming at once: the per-request lock lets exactly one fill land', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  await openStep(bot, A2, id);
  await controller.handleMessage(bot, msg(A1, '1450'));
  const c1 = lastScreen(bot, A1);
  await controller.handleMessage(bot, msg(A2, '1500'));
  const c2 = lastScreen(bot, A2);
  await Promise.all([
    controller.handleCallbackQuery(bot, cb(chip(c1.chips, /^✅ Approve with/), A1, 1)),
    controller.handleCallbackQuery(bot, cb(chip(c2.chips, /^✅ Approve with/), A2, 1)),
  ]);
  const aj = jsonOf(id);
  assert.equal(aj.rateFill.length, 1);
  assert.equal(aj.approvals.length, 1, 'one signature');
  assert.equal(aj.approvals[0], aj.rateFillBy.id, 'the signature is the one who entered the rate');
  assert.equal(statusOf(id), 'pending');
});

test('a save that fails approves nothing', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  await controller.handleMessage(bot, msg(A1, '1450'));
  const check = lastScreen(bot, A1);
  approvalQueueRepository.updateActionJSON = async () => { throw new Error('quota'); };
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, 1));
  approvalQueueRepository.updateActionJSON = realUpdate;
  assert.ok(toasts(bot, from).some((t) => /Could not save the rate — nothing was approved/.test(t)));
  assert.equal(jsonOf(id).rateFill, undefined);
  assert.deepEqual(jsonOf(id).approvals || [], []);
});

test('a signature without a print on a row with fills is refused: nothing recorded', async () => {
  reset();
  const bot = createFakeBot();
  const fills = [{ key: 'CUS-S|44200', customer: 'solder madam', customerId: 'CUS-S', design: '44200', thans: 2, yards: 60, rate: 1450 }];
  const id = seed(bundleAJ(SOLDER, {
    rateFill: fills, rateFillBy: { id: A1, name: 'Musa', at: '2026-11-20T10:00:00Z' },
    approvals: [A1], signoffs: [{ id: A1, name: 'Musa', at: '2026-11-20T10:00:00Z' }],
  }));
  await openStep(bot, A2, id);
  const second = lastScreen(bot, A2);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(second.chips, /^✅ Approve ·/), A2, 1));
  assert.ok(toasts(bot, from).some((t) => /given for a different rate — nothing was recorded/.test(t)));
  assert.equal(statusOf(id), 'pending');
  assert.equal(CREDITS.length, 0);
});

test('a request signed before any fill finishes as before: no step, no credit for the gap', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ(SOLDER.slice(0, 2), { approvals: [A1], signoffs: [{ id: A1, name: 'Musa', at: '2026-11-19T10:00:00Z' }] }));
  const card = plain(await approvalCards.buildCardFromActionJSON(jsonOf(id)));
  assert.match(card, /⚠️ solder madam: no rate on record — the stock comes back, but NO credit will post\./);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 1));
  assert.ok(!toChat(bot, A2, from).some((c) => /rate needed|check the credit/.test(c.args.text)));
  assert.equal(statusOf(id), 'approved');
  assert.match(toChat(bot, A2, from).map((c) => c.args.text).join('\n'), /no rate on record — NO credit posted/);
});

test('a return with no gap never sees the step', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ([SOLDER[2]]));
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A1, 1));
  assert.ok(toasts(bot, from).some((t) => /Approval 1 of 2 recorded/.test(t)));
  assert.ok(!toChat(bot, A1, from).some((c) => /rate needed/.test(c.args.text)));
  assert.deepEqual(jsonOf(id).approvals, [A1]);
});

test('a non-admin is refused on every step chip', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  for (const data of [`rb:re:${id}`, `rb:rc:${id}`, `rb:rx:${id}`, `rb:rn:${id}:0`, `rb:ry:${id}:0123456789`, `rb:rk:${id}:0123456789`]) {
    const from = bot.calls.length;
    await controller.handleCallbackQuery(bot, cb(data, EMP, 1));
    assert.ok(toasts(bot, from).includes('Only admins can approve.'), data);
  }
  assert.equal(jsonOf(id).rateFill, undefined);
});

test('every new button fits Telegram\'s 64-byte callback_data with a real request id', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ([...SOLDER, item('6190', 1, 'ABBA', 'CUS-A', '77015', 0)]));
  assert.equal(id.length, 36);
  await openStep(bot, A1, id);
  await controller.handleMessage(bot, msg(A1, '1450'));
  await controller.handleMessage(bot, msg(A1, '1234567.25'));
  const check = lastScreen(bot, A1);
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, 1));
  await openStep(bot, A2, id);
  const all = bot.calls.flatMap((c) => chipsOf(c)).map((c) => c.split('|').pop()).filter((d) => d.startsWith('rb:r'));
  assert.ok(all.length >= 8);
  for (const d of all) assert.ok(Buffer.byteLength(d, 'utf8') <= 64, `${d} is ${Buffer.byteLength(d, 'utf8')} bytes`);
});
