'use strict';

/**
 * RET-8 review 2 — regressions for the findings of the second review,
 * driven through the REAL controller, approval handler, executor and
 * repositories on the in-memory sheet (the fixture of returnRateReview1).
 *
 *   R2-1  the second admin's chip carries only the credit the card shows;
 *         a "no credit" choice is worded as one
 *   R2-2  a signed "no credit" is not reported as a failed book entry
 *   R2-3  `rate 1450` keeps the step (a hint), a script line still leaves
 *   R2-4  a decided record prints the credit that posted when it differs
 *   R2-5  the inbox taking the session back closes the step message visibly
 *   R2-6  approving from the inbox raises no "screen was closed" alert
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
const textsTo = (bot, uid, from = 0) => toChat(bot, uid, from).map((c) => String(c.args.text));
const ABBA_RATED = item('6189', 5, 'ABBA', 'CUS-A', '77014', 1000);
const inbox = require(path.join(SRC, 'flows/approvalsInboxFlow'));
const erpLog = () => AUDIT.filter((a) => /erp/i.test(a.event));

/** A1 chooses no credit for every gap and confirms; A2 opens the check card. */
async function noCreditThenSecond(bot, id) {
  const step = await openStep(bot, A1, id);
  await controller.handleCallbackQuery(bot, cb(chip(step.chips, /No credit/), A1, 1));
  const check = lastScreen(bot, A1);
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, 1));
  const at = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 61));
  return lastScreen(bot, A2, at);
}

test('R2-1: another buyer\'s rated credit is not on the chip — the chip says what the card shows', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ([SOLDER[0], SOLDER[1], ABBA_RATED]));
  const second = await noCreditThenSecond(bot, id);
  assert.match(second.text, /solder madam · 44200 · 2 thans · 60 yd\nno credit\n/);
  assert.doesNotMatch(second.text, /30,000|ABBA/);
  assert.match(second.text, /Musa chose no credit for these\. Check it before you approve\./);
  assert.doesNotMatch(second.text, /typed this rate/);
  assert.deepEqual(second.chips.map((c) => c.split('|')[0]), ['✅ Approve · no credit', '✖ Not now']);
});

test('R2-1: with a typed rate, the chip is the shown buyer\'s credit only', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ([SOLDER[0], SOLDER[1], ABBA_RATED]));
  await openStep(bot, A1, id);
  await controller.handleMessage(bot, msg(A1, '1450'));
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A1).chips, /^✅ Approve with/), A1, 1));
  const at = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 61));
  const second = lastScreen(bot, A2, at);
  assert.match(second.text, /1,450\/yd → credit 87,000/);
  assert.match(second.text, /Musa typed this rate\./);
  assert.deepEqual(second.chips.map((c) => c.split('|')[0]), ['✅ Approve · credit 87,000', '✖ Not now']);
});

test('R2-2: a signed "no credit" is told plainly — no failed-entry alarm, no "post it manually"', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ([SOLDER[0], SOLDER[1], ABBA_RATED]));
  const second = await noCreditThenSecond(bot, id);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(second.chips, /^✅ Approve ·/), A2, 62));
  assert.equal(statusOf(id), 'approved');
  const reply = textsTo(bot, A2, from).join('\n');
  assert.doesNotMatch(reply, /FAILED|post it manually|NO credit posted/);
  // Review 3 (R3-3) — worded as what happened, never as "Credited".
  assert.match(reply, /No credit to solder madam — chosen at approval \(2 thans, 60 yd\)/);
  assert.match(reply, /ABBA 30,000 \(1 than, 30 yd\)/);
  assert.match(reply, /✏️ solder madam · 44200: no credit — chosen by Musa/);
  assert.doesNotMatch(textsTo(bot, EMP, from).join('\n'), /need an admin's attention/);
  assert.equal(erpLog().length, 0, JSON.stringify(erpLog()));
});

test('R2-2: a gap with NO fill still raises the alarm (a return signed before RET-8)', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ(SOLDER.slice(0, 2), { approvals: [A1], signoffs: [{ id: A1, name: 'Musa', at: '2026-11-19T10:00:00Z' }] }));
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 1));
  assert.equal(statusOf(id), 'approved');
  assert.match(textsTo(bot, A2, from).join('\n'), /post it manually/);
});

test('R2-2: return_thans — a signed "no credit" is not a books failure', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(thansAJ());
  const second = await noCreditThenSecond(bot, id);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(second.chips, /^✅ Approve ·/), A2, 62));
  assert.equal(statusOf(id), 'approved');
  const reply = textsTo(bot, A2, from).join('\n');
  assert.doesNotMatch(reply, /FAILED|post it manually/);
  assert.match(reply, /No credit to solder madam for 2 thans, 60 yds — chosen at approval\./);
  assert.equal(erpLog().length, 0);
});

test('R2-3: a rate typed with a word in front keeps the step and says what a rate looks like', async () => {
  for (const typed of ['rate 1450', 'at 1450', 'N 1450']) {
    reset();
    const bot = createFakeBot();
    const id = seed(bundleAJ());
    await openStep(bot, A1, id);
    const from = bot.calls.length;
    await controller.handleMessage(bot, msg(A1, typed));
    const s = sessionStore.get(A1);
    assert.ok(s && s.step === 'admin_rate', `${typed}: the step stays open`);
    const texts = textsTo(bot, A1, from).join('\n');
    assert.match(texts, /That is not a rate\. Type a number above zero, for example 1450\./, typed);
    assert.doesNotMatch(texts, /closed|personalized activity menu/, typed);
    assert.equal(jsonOf(id).rateFill, undefined);
  }
});

test('R2-4: a decided record prints the credit that posted, and the signed one when they differ', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  await controller.handleMessage(bot, msg(A1, '1450'));
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A1).chips, /^✅ Approve with/), A1, 1));
  fake._store.get('Inventory').find((r) => r[0] === '9300' && r[5] === '1')[9] = '1200';
  const at = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 61));
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A2, at).chips, /^✅ Approve ·/), A2, 62));
  assert.equal(statusOf(id), 'approved');
  const aj = jsonOf(id);
  assert.deepEqual(aj.creditBooked, [{ key: 'CUS-S', customer: 'solder madam', amount: 109500 }]);
  const record = plain(await approvalCards.buildCardFromActionJSON(aj, { decided: true }));
  assert.match(record, /💰 solder madam 109,500 credited \(approved for 117,000\)\n {3}44200 at 1,450\/yd — entered by Musa/);
  assert.doesNotMatch(record, /💰 solder madam 117,000/);
});

test('R2-4: when the booked credit is the signed one, the record reads as before', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  await controller.handleMessage(bot, msg(A1, '1450'));
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A1).chips, /^✅ Approve with/), A1, 1));
  const at = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 61));
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A2, at).chips, /^✅ Approve ·/), A2, 62));
  const record = plain(await approvalCards.buildCardFromActionJSON(jsonOf(id), { decided: true }));
  assert.match(record, /💰 solder madam 117,000\n {3}44200 at 1,450\/yd — entered by Musa/);
});

test('R2-4: return_thans — a decided record states the credit that posted', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(thansAJ());
  await openStep(bot, A1, id);
  await controller.handleMessage(bot, msg(A1, '1450'));
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A1).chips, /^✅ Approve with/), A1, 1));
  fake._store.get('Inventory').find((r) => r[0] === '5801' && r[5] === '1')[9] = '1200';
  require(path.join(SRC, 'repositories/inventoryRepository')).invalidateCache(); // the sheet moved under the bot's read cache
  const at = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 61));
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A2, at).chips, /^✅ Approve ·/), A2, 62));
  assert.equal(statusOf(id), 'approved');
  const record = plain(await approvalCards.buildCardFromActionJSON(jsonOf(id), { decided: true }));
  assert.match(record, /💰 Credits solder madam 79,500 credited \(approved for 87,000\)/);
});

/** Open the 🛂 inbox, the Returns item, and tap its ✅ Approve. */
async function approveFromInbox(bot, id) {
  await inbox.start(bot, A1, A1);
  const anchor = sessionStore.get(A1).flowMessageId;
  await controller.handleCallbackQuery(bot, cb('abx:cat:returns', A1, anchor));
  await controller.handleCallbackQuery(bot, cb('abx:i:0', A1, anchor));
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`abx:ok:${id}`, A1, anchor));
  return { anchor, from };
}

test('R2-6: approving from the inbox opens the step with no "screen was closed" alert', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  const { from } = await approveFromInbox(bot, id);
  assert.equal(sessionStore.get(A1).step, 'admin_rate');
  const alerts = bot.calls.slice(from).filter((c) => c.method === 'answerCallbackQuery');
  assert.ok(alerts.every((c) => !(c.args.opts && c.args.opts.show_alert)), JSON.stringify(alerts.map((c) => c.args.opts)));
  assert.ok(toasts(bot, from).includes('Type the rate first.'), JSON.stringify(toasts(bot, from)));
  assert.doesNotMatch(lastScreen(bot, A1, from).text, /was closed/);
});

test('R2-5: the inbox ⬅ Back takes the session — the step message says it closed and how to reopen', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  const { anchor } = await approveFromInbox(bot, id);
  const stepMsg = sessionStore.get(A1).flowMessageId;
  assert.ok(stepMsg);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('abx:back', A1, anchor));
  await new Promise((r) => setImmediate(r));
  const edit = bot.calls.slice(from).find((c) => c.method === 'editMessageText' && String(c.args.opts.message_id) === String(stepMsg));
  assert.ok(edit, 'the step message is rewritten');
  assert.match(String(edit.args.text), new RegExp(`^Rate step for return ${approvalCards.shortRequestRef(id)} closed — nothing was approved\\. The request still waits\\.\\nTap ✏️ Type the rate to open it again\\.$`));
  const chips = edit.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(chips, [`rb:re:${id}`, `rb:rx:${id}`]);
  // ✏️ Type the rate reopens the step; the typed rate reaches it.
  await controller.handleCallbackQuery(bot, cb(`rb:re:${id}`, A1, stepMsg));
  assert.equal(sessionStore.get(A1).step, 'admin_rate');
  const at = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, '1450'));
  assert.match(lastScreen(bot, A1, at).text, /check the credit/);
});
