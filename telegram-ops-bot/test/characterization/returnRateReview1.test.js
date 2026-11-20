'use strict';

/**
 * RET-8 / CARD-8 review 1 — regressions for the findings of the first
 * review, driven through the REAL controller, approval handler, executor
 * and repositories on the in-memory sheet (the same fixture as
 * returnRateStep.test.js). The ledger and the last-paid lookup are
 * stand-ins.
 *
 *   R1-1  a sole admin may enter the rate on their own return
 *   R1-2  a gap than whose sale row gained a rate: the admins are told the
 *         booked credit differs from the signed one
 *   R1-4  a decided record says no "asked for it" and projects no ledger
 *   R1-5  a decimal rate: the card shows the exact credit that posts
 *   R1-12 return_thans: the employee is not shown the entered rate
 *   R1-13 a sale wizard touched after the step takes the typed number
 *   R1-14 opening the step names the return draft it closed
 *   R1-15 `cancel` and a word line close the step; a Return line goes on
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

const config = require(path.join(SRC, 'config'));
const returnBundleFlow = require(path.join(SRC, 'flows/returnBundleFlow'));
const textsTo = (bot, uid, from = 0) => toChat(bot, uid, from).map((c) => String(c.args.text));

/** A1 enters `rate` for every gap and confirms; returns the check card. */
async function fillAndConfirm(bot, uid, id, rate) {
  await openStep(bot, uid, id);
  await controller.handleMessage(bot, msg(uid, String(rate)));
  const check = lastScreen(bot, uid);
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), uid, 1));
  return check;
}

test('R1-1: a sole admin enters the rate on their own return and their approval completes it', async () => {
  reset();
  const saved = config.access.adminIds.slice();
  config.access.adminIds.splice(0, config.access.adminIds.length, A1);
  try {
    const bot = createFakeBot();
    const id = seed(bundleAJ(), A1);
    const step = await openStep(bot, A1, id);
    assert.match(step.text, /rate needed/);
    let from = bot.calls.length;
    await controller.handleMessage(bot, msg(A1, '1450'));
    const check = lastScreen(bot, A1, from);
    assert.match(check.text, /1,450\/yd → credit 87,000/);
    assert.match(check.text, /\n\nYour approval completes the return\.$/);
    assert.ok(!textsTo(bot, A1, from).some((t) => /no longer needs a rate/.test(t)));
    from = bot.calls.length;
    await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, 1));
    assert.ok(!toasts(bot, from).some((t) => /own request/.test(t)), JSON.stringify(toasts(bot, from)));
    assert.equal(statusOf(id), 'approved');
    assert.equal(CREDITS.length, 1);
    assert.equal(Math.round(CREDITS[0].yards * CREDITS[0].pricePerYard), 117000);
  } finally {
    config.access.adminIds.splice(0, config.access.adminIds.length, ...saved);
    await require(path.join(SRC, 'middlewares/auth')).invalidate(); // the allow-set was rebuilt for one admin
  }
});

test('R1-1: with another admin present the requester is still refused, and told so plainly', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ(), A1);
  // A forged step for the requester (the card never opens it for them).
  sessionStore.set(A1, { type: 'return_bundle_flow', step: 'admin_rate', requestId: id, gi: 0, answers: [], ttlMs: 60000 });
  const from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, '1450'));
  assert.deepEqual(textsTo(bot, A1, from), ['🔒 You cannot enter the rate on your own request — a second admin must.']);
  assert.equal(jsonOf(id).rateFill, undefined);
});

test('R1-2: a gap than whose sale row gained a rate is credited at it — the admins are told the credit is not the one they signed', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await fillAndConfirm(bot, A1, id, 1450);
  // After the fill, the sale row of 9300/1 gains its own rate.
  const inv = fake._store.get('Inventory');
  inv.find((r) => r[0] === '9300' && r[5] === '1')[9] = '1200';
  const at = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 61));
  const second = lastScreen(bot, A2, at);
  assert.deepEqual(second.chips.map((c) => c.split('|')[0]), ['✅ Approve · credit 117,000', '✖ Not now']);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(second.chips, /^✅ Approve ·/), A2, 62));
  assert.equal(statusOf(id), 'approved');
  assert.equal(Math.round(CREDITS[0].yards * CREDITS[0].pricePerYard), 109500, 'the recorded rate wins (§6)');
  const reply = textsTo(bot, A2, from).join('\n');
  assert.match(reply, /↩️ Credited solder madam 109,500 \(3 thans, 90 yd\)\./);
  assert.match(reply, /⚠️ solder madam: credited 109,500, not the 117,000 the approvals were given for — 9300\/1 now carries its own rate on the sale record \(1,200\/yd\), and a recorded rate is always used\./);
  // The requester is not shown the admins' rate lines.
  const toEmp = textsTo(bot, EMP, from).join('\n');
  assert.doesNotMatch(toEmp, /1,450|1,200\/yd|approvals were given for/);
});

test('R1-2: when the booked credit is the signed one, no extra line', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await fillAndConfirm(bot, A1, id, 1450);
  const at = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 61));
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A2, at).chips, /^✅ Approve ·/), A2, 62));
  assert.equal(statusOf(id), 'approved');
  assert.doesNotMatch(textsTo(bot, A2, from).join('\n'), /approvals were given for/);
});

test('R1-4 / R1-9 / R1-16: a decided return record states the gap and projects no ledger', async () => {
  reset();
  const bundle = plain(await approvalCards.buildCardFromActionJSON(bundleAJ(), { decided: true }));
  assert.match(bundle, /⚠️ No rate on the sale record: solder madam · 44200 · 2 thans\.(\n|$)/);
  assert.doesNotMatch(bundle, /asked for it/);
  assert.doesNotMatch(bundle, /outstanding/i);
  assert.match(bundle, /💰 solder madam 30,000(\n|$)/);
  const thans = plain(await approvalCards.buildCardFromActionJSON(thansAJ(), { decided: true }));
  assert.match(thans, /⚠️ No rate on the sale record: solder madam · 44200 · 2 thans\.(\n|$)/);
  assert.doesNotMatch(thans, /asked for it|Outstanding/);
  // A filled, decided record: the credit and who entered it, no projection.
  const fills = [{ key: 'CUS-S|44200', customer: 'solder madam', customerId: 'CUS-S', design: '44200', thans: 2, yards: 60, rate: 1450 }];
  const filled = plain(await approvalCards.buildCardFromActionJSON(bundleAJ(SOLDER, { rateFill: fills, rateFillBy: { id: A1, name: 'Musa' } }), { decided: true }));
  assert.match(filled, /💰 solder madam 117,000\n {3}44200 at 1,450\/yd — entered by Musa/);
  assert.doesNotMatch(filled, /outstanding/i);
  // The waiting card is unchanged.
  const waiting = plain(await approvalCards.buildCardFromActionJSON(bundleAJ()));
  assert.match(waiting, /The admin who approves first is asked for it\./);
  assert.match(waiting, /outstanding 500,000 → 470,000/);
});

test('R1-5: a decimal rate — the cards show the exact credit that posts', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  await controller.handleMessage(bot, msg(A1, '3.33'));
  const check = lastScreen(bot, A1);
  assert.match(check.text, /3\.33\/yd → credit 199\.80\nCredit for solder madam on this return: 30,199\.80\nOutstanding 500,000 → 469,800\.20/);
  await controller.handleCallbackQuery(bot, cb(chip(check.chips, /^✅ Approve with/), A1, 1));
  const at = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 61));
  const second = lastScreen(bot, A2, at);
  assert.deepEqual(second.chips.map((c) => c.split('|')[0]), ['✅ Approve · credit 30,199.80', '✖ Not now']);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(second.chips, /^✅ Approve ·/), A2, 62));
  assert.equal(statusOf(id), 'approved');
  assert.ok(Math.abs(CREDITS[0].yards * CREDITS[0].pricePerYard - 30199.8) < 0.001);
  const reply = textsTo(bot, A2, from).join('\n');
  assert.match(reply, /↩️ Credited solder madam 30,199\.80 \(3 thans, 90 yd\)\./);
  assert.doesNotMatch(reply, /approvals were given for/, 'signed and booked agree');
});

test('R1-12: return_thans — the employee is told the credit, never the rate an admin typed', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(thansAJ());
  await fillAndConfirm(bot, A1, id, 1450);
  const at = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 71));
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A2, at).chips, /credit 87,000/), A2, 72));
  assert.equal(statusOf(id), 'approved');
  const toEmp = textsTo(bot, EMP, from).join('\n');
  assert.match(toEmp, /↩️ Credited 87,000 to solder madam \(2 thans, 60 yds\)\./);
  assert.doesNotMatch(toEmp, /1,450/);
  const toAdmin = textsTo(bot, A2, from).join('\n');
  assert.match(toAdmin, /✏️ solder madam · 44200 at 1,450\/yd, entered by Musa/);
});

test('R1-12: a return_thans with every rate on record still names the rate, as before RET-8', async () => {
  reset();
  const bot = createFakeBot();
  fake._store.get('Inventory').filter((r) => r[0] === '5801').forEach((r) => { r[9] = '1000'; });
  const id = seed(thansAJ({ pricePerYard: 1000, thanRates: [{ thanNo: 1, yards: 30, rate: 1000 }, { thanNo: 2, yards: 30, rate: 1000 }] }));
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A1, 1));
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 2));
  assert.equal(statusOf(id), 'approved');
  assert.match(textsTo(bot, EMP, from).join('\n'), /↩️ Credited 60,000 to solder madam \(2 thans, 60 yds × 1,000\/yd\)\./);
});

test('R1-13: a sale wizard touched after the rate step takes the typed number; touched before, the step keeps it', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  const { pendingEnrichment, wizKey } = approvalEvents._internals;
  const key = wizKey(A1, 'sale-xyz');
  try {
    // Opened BEFORE the step: the step keeps the line.
    pendingEnrichment.set(key, { adminId: A1, requestId: 'sale-xyz', step: 'rate', startedAt: Date.now() - 60000, touchedAt: Date.now() - 60000 });
    let session = sessionStore.get(A1);
    assert.equal(await returnBundleFlow.handleText(bot, msg(A1, '1450')), true);
    assert.equal(sessionStore.get(A1).answers[0].rate, 1450);
    // Re-open the step, then a wizard opened AFTER it: the line is given up.
    await controller.handleCallbackQuery(bot, cb(`rb:rc:${id}`, A1, 1));
    session = sessionStore.get(A1);
    pendingEnrichment.set(key, { adminId: A1, requestId: 'sale-xyz', step: 'rate', startedAt: Date.now() + 1000, touchedAt: Date.now() + 1000 });
    assert.equal(await returnBundleFlow.handleText(bot, msg(A1, '1500')), false, 'the sale wizard gets it');
    assert.deepEqual(sessionStore.get(A1).answers, session.answers, 'the return step recorded nothing');
    assert.equal(sessionStore.get(A1).step, 'admin_rate', 'the step stays open');
  } finally {
    pendingEnrichment.delete(key);
  }
});

test('R1-14: opening the rate step names the admin\'s own return draft it closed', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg(A1, 'Return 6189/5'));
  assert.equal(sessionStore.get(A1).step, 'review');
  const id = seed(bundleAJ());
  const from = bot.calls.length;
  const step = await openStep(bot, A1, id);
  assert.ok(toasts(bot, from).includes('Type the rate first. Your own return draft was closed.'), JSON.stringify(toasts(bot, from)));
  assert.match(step.text, /\n\nℹ️ Your own return draft was closed to open this step\.$/);
  assert.equal(sessionStore.get(A1).step, 'admin_rate');
});

test('R1-15: `cancel` closes the step; a typed Return line closes it and opens its own card', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  let from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, 'cancel'));
  assert.ok(!sessionStore.get(A1), 'the step is closed');
  assert.ok(textsTo(bot, A1, from).includes(`Rate step for return ${approvalCards.shortRequestRef(id)} closed — nothing was approved. The request still waits.`));
  assert.equal(statusOf(id), 'pending');

  await openStep(bot, A1, id);
  from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, 'Return 6189/5'));
  const texts = textsTo(bot, A1, from);
  assert.ok(texts.some((t) => /Rate step for return R-[0-9A-F]{4} closed/.test(t)), 'the step message says it closed');
  assert.ok(!texts.some((t) => /That is not a rate/.test(t)));
  const s = sessionStore.get(A1);
  assert.ok(s && s.type === 'return_bundle_flow' && s.step !== 'admin_rate', `the Return line opened its own card: ${JSON.stringify(s && s.step)}`);
  assert.equal(jsonOf(id).rateFill, undefined);
  assert.deepEqual(jsonOf(id).approvals || [], []);
});
