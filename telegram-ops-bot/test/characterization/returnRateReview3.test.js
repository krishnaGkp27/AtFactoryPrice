'use strict';

/**
 * RET-8 review 3 — regressions for the findings of the third review,
 * driven through the REAL controller, approval handler, executor and
 * repositories on the in-memory sheet (the fixture of returnRateReview2).
 *
 *   R3-1  a gap buyer whose every than was skipped: the record says 0 credited
 *   R3-2  the note after a takeover never claims the request still waits when it does not
 *   R3-3  a no-credit outcome is never announced as "Credited"
 *   R3-4  `price 1450` keeps the step (a hint); `Price 9006 black 1500` still leaves
 *   R3-5  the executor stores 0 for a gap buyer it skipped entirely
 *   R3-6  a refused ledger credit is stored and printed as not posted
 *   R3-7  `Returns …` and a typed customer line leave the step for their own doors
 *   R3-8  a rate with three decimals is refused; the chip rate is kept to two
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

const rr = require(path.join(SRC, 'services/returnRate'));
const tick = () => new Promise((r) => setImmediate(r));

/** A1 types the rates in turn and confirms; A2's check chip completes. Returns A2's texts. */
async function typedThenSecond(bot, id, rates, beforeSecond) {
  await openStep(bot, A1, id);
  for (const r of rates) await controller.handleMessage(bot, msg(A1, r));
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A1).chips, /^✅ Approve with/), A1, 1));
  if (beforeSecond) await beforeSecond();
  const at = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`approve:${id}`, A2, 61));
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A2, at).chips, /^✅ Approve ·/), A2, 62));
  return { from, reply: textsTo(bot, A2, from).join('\n') };
}

test('R3-1: a gap buyer whose thans were all skipped — the decided record says nothing was credited', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ([SOLDER[0], SOLDER[1], ABBA_RATED]));
  const { reply } = await typedThenSecond(bot, id, ['1450'], async () => {
    for (const r of fake._store.get('Inventory')) if (r[0] === '9300') { r[7] = 'available'; r[11] = ''; }
  });
  assert.equal(statusOf(id), 'approved');
  assert.match(reply, /Skipped: 9300\/1/);
  assert.deepEqual(CREDITS.map((c) => c.customer), ['ABBA']);
  const record = plain(await approvalCards.buildCardFromActionJSON(jsonOf(id), { decided: true }));
  assert.match(record, /💰 solder madam 0 credited \(approved for 87,000\)/);
  assert.doesNotMatch(record, /💰 solder madam 87,000/);
});

test('R3-1: bookedFor — a buyer missing from a stored list was credited 0', () => {
  assert.equal(rr.bookedFor({ creditBooked: [{ key: 'CUS-A', amount: 30000 }] }, 'CUS-S'), 0);
  assert.equal(rr.bookedFor({}, 'CUS-S'), null);
});

test('R3-5: two gap buyers, one skipped entirely — stored as 0 and printed so', async () => {
  reset();
  const bot = createFakeBot();
  const ABBA_GAP = item('6190', 1, 'ABBA', 'CUS-A', '77015', 0);
  const id = seed(bundleAJ([SOLDER[0], SOLDER[1], ABBA_GAP]));
  // gaps in the cards' order: ABBA first, then solder madam
  await typedThenSecond(bot, id, ['1450', '1500'], async () => {
    for (const r of fake._store.get('Inventory')) if (r[0] === '6190') { r[7] = 'available'; r[11] = ''; }
  });
  assert.equal(statusOf(id), 'approved');
  assert.deepEqual(CREDITS.map((c) => [c.customer, c.yards, c.pricePerYard]), [['solder madam', 60, 1500]]);
  const aj = jsonOf(id);
  assert.deepEqual(aj.creditBooked.find((b) => b.key === 'CUS-A'), { key: 'CUS-A', customer: 'ABBA', amount: 0 });
  assert.deepEqual(aj.creditBooked.find((b) => b.key === 'CUS-S'), { key: 'CUS-S', customer: 'solder madam', amount: 90000 });
  const record = plain(await approvalCards.buildCardFromActionJSON(aj, { decided: true }));
  assert.match(record, /💰 ABBA 0 credited \(approved for 43,500\)/);
  assert.match(record, /💰 solder madam 90,000\n/);
});

test('R3-6: return_bundle — a refused ledger credit is stored and printed as not posted', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  const realRecord = accountingService.recordReturn;
  accountingService.recordReturn = async () => { throw new Error('ledger down'); };
  try {
    const { reply } = await typedThenSecond(bot, id, ['1450'], async () => {
      fake._store.get('Inventory').find((r) => r[0] === '9300' && r[5] === '1')[9] = '1200';
    });
    assert.equal(statusOf(id), 'approved');
    assert.equal(CREDITS.length, 0);
    assert.match(reply, /FAILED/);
    assert.doesNotMatch(reply, /↩️ Credited \./, 'no empty "Credited" line');
    const aj = jsonOf(id);
    assert.deepEqual(aj.creditBooked, [{ key: 'CUS-S', customer: 'solder madam', amount: 0, failed: true }]);
    const record = plain(await approvalCards.buildCardFromActionJSON(aj, { decided: true }));
    assert.match(record, /💰 solder madam credit not posted — the ledger entry failed \(approved for 117,000\)/);
    assert.doesNotMatch(record, /109,500 credited/);
  } finally { accountingService.recordReturn = realRecord; }
});

test('R3-6: return_thans — a refused ledger credit is stored and printed as not posted', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(thansAJ());
  const realRecord = accountingService.recordReturn;
  accountingService.recordReturn = async () => { throw new Error('ledger down'); };
  try {
    await typedThenSecond(bot, id, ['1450']);
    assert.equal(statusOf(id), 'approved');
    const aj = jsonOf(id);
    assert.deepEqual(aj.creditBooked, [{ key: 'CUS-S', customer: 'solder madam', amount: 0, failed: true }]);
    const record = plain(await approvalCards.buildCardFromActionJSON(aj, { decided: true }));
    assert.match(record, /💰 Credits solder madam credit not posted — the ledger entry failed \(approved for 87,000\)/);
  } finally { accountingService.recordReturn = realRecord; }
});

test('R3-3: a bundle whose only buyer gets no credit on purpose is never announced as credited', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ(SOLDER.slice(0, 2)));
  const second = await noCreditThenSecond(bot, id);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(second.chips, /^✅ Approve ·/), A2, 62));
  assert.equal(statusOf(id), 'approved');
  for (const uid of [A2, EMP]) {
    const t = textsTo(bot, uid, from).join('\n');
    assert.match(t, /↩️ No credit to solder madam — chosen at approval \(2 thans, 60 yd\)\./, uid);
    assert.doesNotMatch(t, /Credited solder madam/, uid);
  }
});

test('R3-3: a mixed bundle names the credited buyer and the no-credit buyer each for what happened', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ([SOLDER[0], SOLDER[1], ABBA_RATED]));
  const second = await noCreditThenSecond(bot, id);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(second.chips, /^✅ Approve ·/), A2, 62));
  const reply = textsTo(bot, A2, from).join('\n');
  assert.match(reply, /↩️ Credited ABBA 30,000 \(1 than, 30 yd\) · No credit to solder madam — chosen at approval \(2 thans, 60 yd\)\./);
});

test('R3-4: `price 1450` keeps the step; `Price 9006 black 1500` still leaves it', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  let from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, 'price 1450'));
  let s = sessionStore.get(A1);
  assert.ok(s && s.step === 'admin_rate', 'the step stays open');
  let texts = textsTo(bot, A1, from).join('\n');
  assert.match(texts, /That is not a rate\. Type a number above zero, for example 1450\./);
  assert.doesNotMatch(texts, /closed|personalized activity menu/);
  from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, 'Price 9006 black 1500'));
  s = sessionStore.get(A1);
  assert.ok(!s || s.step !== 'admin_rate', 'the price line leaves the step');
  texts = textsTo(bot, A1, from).join('\n');
  assert.match(texts, /Rate step for return R-C677 closed — nothing was approved/);
  assert.equal(jsonOf(id).rateFill, undefined);
});

test('R3-7: `Returns 631/1+2` and a typed customer line leave the step for their own doors', async () => {
  for (const typed of ['Returns 631/1+2', 'Amib international\n0806 256 2752\nKano']) {
    reset();
    const bot = createFakeBot();
    const id = seed(bundleAJ());
    await openStep(bot, A1, id);
    const from = bot.calls.length;
    await controller.handleMessage(bot, msg(A1, typed));
    const s = sessionStore.get(A1);
    assert.ok(!s || s.step !== 'admin_rate', `${typed}: the step closes`);
    const texts = textsTo(bot, A1, from).join('\n');
    assert.doesNotMatch(texts, /That is not a rate/, typed);
    assert.match(texts, /Rate step for return R-C677 closed — nothing was approved/, typed);
    assert.equal(jsonOf(id).rateFill, undefined);
  }
});

test('R3-8: a rate with three decimals is refused; two decimals are taken and the card adds up', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ(SOLDER.slice(0, 2)));
  await openStep(bot, A1, id);
  let from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, '1450.555'));
  assert.match(textsTo(bot, A1, from).join('\n'), /A rate has at most two decimals, for example 3\.20\./);
  assert.doesNotMatch(lastScreen(bot, A1, from).text, /check the credit/);
  from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, '1450.55'));
  const check = lastScreen(bot, A1, from);
  assert.match(check.text, /1,450\.55\/yd → credit 87,033\b/);
  assert.equal(rr.buildFills([{ key: 'K', thans: 1, yards: 30 }], [{ rate: 1450.555 }])[0].rate, 1450.56, 'a chip rate is kept to two decimals');
});

test('R3-2: a takeover after the request was decided says so, with no reopen chip', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  const stepMsg = sessionStore.get(A1).flowMessageId;
  rowOf(id)[4] = 'approved';
  const from = bot.calls.length;
  sessionStore.set(A1, { type: 'some_other_flow', step: 'x' });
  await tick(); await tick(); await tick();
  const edit = bot.calls.slice(from).find((c) => c.method === 'editMessageText' && c.args.opts && c.args.opts.message_id === stepMsg);
  assert.ok(edit, 'the step message is rewritten');
  assert.equal(String(edit.args.text), 'Rate step for return R-C677 closed. The request is already approved.');
  assert.deepEqual(edit.args.opts.reply_markup.inline_keyboard, []);
});

test('R3-2: a takeover while the request still asks for the rate keeps the reopen offer', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  const stepMsg = sessionStore.get(A1).flowMessageId;
  const from = bot.calls.length;
  sessionStore.set(A1, { type: 'some_other_flow', step: 'x' });
  await tick(); await tick(); await tick();
  const edit = bot.calls.slice(from).find((c) => c.method === 'editMessageText' && c.args.opts && c.args.opts.message_id === stepMsg);
  assert.ok(edit);
  assert.match(String(edit.args.text), /The request still waits\./);
  assert.match(JSON.stringify(edit.args.opts.reply_markup), /rb:re:/);
});

test('R3-2: "This return needs no rate" ends the step session', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  await openStep(bot, A1, id);
  assert.equal(sessionStore.get(A1).step, 'admin_rate');
  const aj = jsonOf(id);
  for (const it of aj.items) it.pricePerYard = 1000;
  rowOf(id)[2] = JSON.stringify(aj);
  await controller.handleCallbackQuery(bot, cb(`rb:re:${id}`, A1, 1));
  assert.ok(toasts(bot).some((t) => /needs no rate/.test(t)));
  assert.equal(sessionStore.get(A1), null);
});

// ── Final read-through before the deploy (20-Nov-2026) ─────────────────────

test('final check: a rate typed with its thousands comma is read; a malformed comma is not', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ(SOLDER.slice(0, 2)));
  await openStep(bot, A1, id);
  let from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, '14,50'));
  assert.match(textsTo(bot, A1, from).join('\n'), /That is not a rate/);
  assert.doesNotMatch(lastScreen(bot, A1, from).text, /check the credit/);
  from = bot.calls.length;
  await controller.handleMessage(bot, msg(A1, '1,450'));
  assert.match(lastScreen(bot, A1, from).text, /1,450\/yd → credit 87,000\b/);
  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(chip(lastScreen(bot, A1).chips, /Change rate/), A1, 1));
  await controller.handleMessage(bot, msg(A1, '1,450.555'));
  assert.match(textsTo(bot, A1, from).join('\n'), /A rate has at most two decimals/);
});

test('final check: every ledger entry refused and a than skipped — the skipped line stands alone, never after "null"', async () => {
  reset();
  const bot = createFakeBot();
  const id = seed(bundleAJ());
  const realRecord = accountingService.recordReturn;
  accountingService.recordReturn = async () => { throw new Error('ledger down'); };
  try {
    const { reply } = await typedThenSecond(bot, id, ['1450'], async () => {
      const r = fake._store.get('Inventory').find((x) => x[0] === '9301' && x[5] === '1');
      r[7] = 'available'; r[11] = '';
    });
    assert.equal(statusOf(id), 'approved');
    assert.match(reply, /⚠️ Skipped: 9301\/1/);
    assert.doesNotMatch(reply, /null/);
    assert.match(reply, /FAILED/);
  } finally { accountingService.recordReturn = realRecord; }
});
