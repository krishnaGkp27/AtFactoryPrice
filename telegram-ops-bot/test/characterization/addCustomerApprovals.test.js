'use strict';

/**
 * ACA-1 (owner, 27-Nov-2026) — one admin or two behind a NEW CUSTOMER.
 *
 *   "I want to make a toggle for admin to add customer through one admin
 *    approval or 2 admin. I need it on urgent basis and make it default to
 *    1 admin for now."
 *
 * Settings `ADD_CUSTOMER_APPROVALS` (default 1). Pinned through the REAL
 * controller and approval handler:
 *
 *  ONE (default)
 *   - an employee's customer request is approved by one admin, as before;
 *   - an admin's own customer entry is approved by that admin, on the
 *     approval card every admin is sent (the submitted card says so);
 *   - an admin's own NON-customer entry still needs another admin.
 *  TWO
 *   - an employee's customer request needs two DIFFERENT admins: the first
 *     tap records "1 of 2" and creates nothing, the same admin cannot sign
 *     twice, the second admin completes it;
 *   - an admin's own customer entry needs one OTHER admin, never their own;
 *   - a request routed to 📒 Contact is not a customer and takes one admin;
 *   - ⚡ Quick Add (one admin, writes at once) is closed;
 *   - the approval card says two admins are needed.
 */

process.env.ADMIN_IDS = '777,778';
process.env.EMPLOYEE_IDS = '888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const contactsRepository = require(path.join(SRC, 'repositories/contactsRepository'));
const contactLinksRepository = require(path.join(SRC, 'repositories/contactLinksRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const crmService = require(path.join(SRC, 'services/crmService'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));
const customerApprovals = require(path.join(SRC, 'services/customerApprovals'));
const approvalGate = require(path.join(SRC, 'services/approvalGate'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

const KRISHNA = '777'; // admin
const MUSA = '778';    // admin
const ABDUL = '888';   // employee

/* ── fixture state ── */
let rows = {};
let contactsAdded = [];
let customersAdded = [];
let switchCell; // what the Settings cell holds; undefined = no row

approvalQueueRepository.getByRequestId = async (id) => (rows[id] ? JSON.parse(JSON.stringify(rows[id])) : null);
approvalQueueRepository.getAllPending = async () => Object.values(rows).filter((r) => r.status === 'pending');
approvalQueueRepository.updateStatus = async (id, status) => { if (rows[id]) rows[id].status = status; return true; };
approvalQueueRepository.updateActionJSON = async (id, patch) => {
  if (rows[id]) rows[id].actionJSON = { ...rows[id].actionJSON, ...patch };
  return true;
};
approvalQueueRepository.append = async (row) => { rows[row.requestId] = row; return row; };
auditLogRepository.append = async () => {};

contactsRepository.getAll = async () => [];
contactsRepository.append = async (c) => {
  const created = { ...c, contact_id: c.contact_id || `CON-${contactsAdded.length + 1}` };
  contactsAdded.push(created);
  return created;
};
contactLinksRepository.append = async (l) => ({ ...l, link_id: 'CL-1' });
crmService.addCustomer = async (c) => {
  const hit = customersAdded.find((x) => x.name.toLowerCase() === String(c.name).toLowerCase());
  if (hit) return { status: 'exists', customer: hit };
  const cust = { ...c, customer_id: `AFP-C-${customersAdded.length + 1}` };
  customersAdded.push(cust);
  return { status: 'created', customer: cust };
};
customerEntity.resolve = async () => null;

// The Settings sheet, as the switch reads it.
const realStrict = settingsRepository.getAllStrict;
const realAll = settingsRepository.getAll;
const withSwitch = () => ({
  ...settingsRepository.DEFAULTS,
  ...(switchCell === undefined ? {} : { [customerApprovals.KEY]: switchCell }),
});
settingsRepository.getAllStrict = async () => withSwitch();
settingsRepository.getAll = async () => withSwitch();
test.after(() => { settingsRepository.getAllStrict = realStrict; settingsRepository.getAll = realAll; });

function reset(cell) {
  rows = {}; contactsAdded = []; customersAdded = [];
  switchCell = cell;
  customerApprovals._reset();
  [KRISHNA, MUSA, ABDUL].forEach((id) => sessionStore.clear(id));
}
function queuePerson(requestId, user, aj = {}) {
  rows[requestId] = {
    requestId, user, status: 'pending', createdAt: '2026-11-27T09:00:00.000Z',
    actionJSON: {
      action: 'add_contact', name: 'Amib International', type: 'customer',
      phone: '+2348062562752', address: 'Kano', notes: '',
      category: 'Retail', credit_limit: 0, payment_terms: 'COD', ...aj,
    },
    riskReason: 'New contact requires admin approval',
  };
}
const cb = (data, uid) => ({
  data, id: `q-${data}-${uid}`, from: { id: uid },
  message: { message_id: 9, chat: { id: uid } },
});
const msg = (text, uid) => ({ from: { id: uid }, chat: { id: uid }, text });
const answers = (bot) => bot.calls.filter((c) => c.method === 'answerCallbackQuery')
  .map((c) => String((c.args.opts && c.args.opts.text) || ''));
function screen(bot) {
  const c = bot.calls.filter((x) => x.method === 'editMessageText' || x.method === 'sendMessage').pop();
  const kb = c && c.args.opts && c.args.opts.reply_markup;
  return { text: c ? String(c.args.text || '') : '', kb: kb && kb.inline_keyboard ? kb.inline_keyboard.flat() : [] };
}
/** Every button painted in ONE person's chat while the door ran, newest last. */
function everyButton(bot, chatId) {
  const chatOf = (c) => String(c.method === 'editMessageText'
    ? ((c.args.opts && c.args.opts.chat_id) || '') : (c.args.chatId || ''));
  return bot.calls
    .filter((x) => x.method === 'editMessageText' || x.method === 'sendMessage')
    .filter((c) => chatOf(c) === String(chatId))
    .flatMap((c) => {
      const kb = c.args.opts && c.args.opts.reply_markup;
      return kb && kb.inline_keyboard ? kb.inline_keyboard.flat() : [];
    });
}

/** Everything written into ONE person's chat, joined. */
function textsIn(bot, chatId) {
  const chatOf = (c) => String(c.method === 'editMessageText'
    ? ((c.args.opts && c.args.opts.chat_id) || '') : (c.args.chatId || ''));
  return bot.calls
    .filter((x) => x.method === 'editMessageText' || x.method === 'sendMessage')
    .filter((c) => chatOf(c) === String(chatId))
    .map((c) => String(c.args.text || '')).join('\n---\n');
}

/** Walk ➕ Add Contact as a customer up to the confirm card and tap Submit. */
async function submitCustomerThroughTheDoor(bot, uid) {
  await controller.handleCallbackQuery(bot, cb('act:add_customer', uid));
  await controller.handleCallbackQuery(bot, cb('actype:customer', uid));
  await controller.handleMessage(bot, msg('Amib International', uid));
  await controller.handleMessage(bot, msg('+2348062562752', uid));
  await controller.handleMessage(bot, msg('Kano', uid));
  await controller.handleCallbackQuery(bot, cb('accat:Retail', uid));
  await controller.handleCallbackQuery(bot, cb('accred:0', uid));
  await controller.handleCallbackQuery(bot, cb('acpt:COD', uid));
  await controller.handleCallbackQuery(bot, cb('acskip:notes', uid));
  // CRM-R1 — an admin is asked the store; "place later" keeps the walk short.
  const later = screen(bot).kb.find((b) => /^acst:/.test(b.callback_data) && /later/.test(b.callback_data));
  if (later) await controller.handleCallbackQuery(bot, cb(later.callback_data, uid));
  await controller.handleCallbackQuery(bot, cb('acconf:1', uid));
}
const onlyRequest = () => Object.values(rows)[0];

/* ── the switch itself ── */

test('the switch reads 1 by default, 2 only when the cell clearly says two', () => {
  assert.equal(settingsRepository.DEFAULTS.ADD_CUSTOMER_APPROVALS, 1, 'owner: default to 1 admin');
  for (const one of [undefined, null, '', ' ', 0, 1, '1', 'one', 'yes', -3, 'x']) {
    assert.equal(customerApprovals.parse(one), 1, `${JSON.stringify(one)} → one admin`);
  }
  // Two is read generously: a cell the owner meant as two is never one.
  for (const two of [2, '2', ' 2 ', 'two', 'TWO', 'dual', 3, '2 admins', 'Two admins', '２', '2.0']) {
    assert.equal(customerApprovals.parse(two), 2, `${JSON.stringify(two)} → two admins`);
  }
  assert.equal(customerApprovals.parse('1 admin'), 1);
});

test('what counts as creating a customer follows the executor, not the button', () => {
  const c = customerApprovals.createsCustomer;
  assert.equal(c({ action: 'add_contact', type: 'customer' }), true, 'requested as a customer');
  assert.equal(c({ action: 'add_contact', type: 'other', destination: 'customer' }), true, 'routed to 🛒 by the admin');
  assert.equal(c({ action: 'add_contact', type: 'customer', destination: 'contact' }), false, 'routed to 📒 — not a customer');
  assert.equal(c({ action: 'add_contact', type: 'customer', destination: 'network' }), false, 'routed to 🕸 — not a customer');
  assert.equal(c({ action: 'add_contact', type: 'worker' }), false);
  assert.equal(c({ action: 'add_customer' }), true, 'the legacy action');
  assert.equal(c({ action: 'new_customer' }), true, 'the legacy in-flow action');
  assert.equal(c({ action: 'sale_bundle' }), false);
  assert.equal(c(null), false);
});

test('a Settings read that fails keeps the last value read, never falls back to one', async () => {
  reset(2);
  assert.equal(await customerApprovals.count(), 2);
  const stub = settingsRepository.getAllStrict;
  settingsRepository.getAllStrict = async () => { throw new Error('Sheets is down'); };
  try {
    assert.equal(await customerApprovals.count(), 2, 'the owner’s two survives an unreadable sheet');
    assert.equal(customerApprovals.countNow(), 2);
  } finally { settingsRepository.getAllStrict = stub; }

  // …and a one that WAS read survives it too (no needless second admin).
  reset(1);
  assert.equal(await customerApprovals.count(), 1);
  settingsRepository.getAllStrict = async () => { throw new Error('Sheets is down'); };
  try {
    assert.equal(await customerApprovals.count(), 1);
    assert.equal(await customerApprovals.ownApprovalAllowed({ action: 'add_contact', type: 'customer' }), true);
  } finally { settingsRepository.getAllStrict = stub; }
});

test('FAIL CLOSED: a switch never read (restart, sheet unreadable) is two admins and opens no self-approval', async () => {
  reset(2); // the owner's cell says 2 — but no read has ever succeeded
  const stub = settingsRepository.getAllStrict;
  settingsRepository.getAllStrict = async () => { throw new Error('Sheets is down'); };
  try {
    assert.equal(customerApprovals.confirmed(), false);
    assert.equal(await customerApprovals.count(), 2, 'unconfirmed reads as two');
    assert.equal(await customerApprovals.ownApprovalAllowed({ action: 'add_contact', type: 'customer' }), false);

    // An admin's own entry: their own tap is refused.
    queuePerson('R-BOOT-OWN', KRISHNA);
    const own = createFakeBot();
    await controller.handleCallbackQuery(own, cb('approve:R-BOOT-OWN', KRISHNA));
    assert.equal(customersAdded.length, 0);
    assert.equal(rows['R-BOOT-OWN'].status, 'pending');
    assert.ok(answers(own).some((t) => /cannot approve your own request/.test(t)));

    // An employee's entry: one admin's tap is a first signature, no more.
    queuePerson('R-BOOT-EMP', ABDUL);
    const emp = createFakeBot();
    await controller.handleCallbackQuery(emp, cb('approve:R-BOOT-EMP', KRISHNA));
    assert.equal(customersAdded.length, 0, 'nothing created on one admin while the switch is unconfirmed');
    assert.deepEqual(rows['R-BOOT-EMP'].actionJSON.approvals, [KRISHNA]);
  } finally { settingsRepository.getAllStrict = stub; }

  // The sheet comes back and says ONE: the same admin is not asked for more.
  switchCell = 1; customerApprovals._reset();
  await controller.handleCallbackQuery(createFakeBot(), cb('approve:R-BOOT-EMP', MUSA));
  assert.equal(customersAdded.length, 1);
});

/* ── ONE admin (the default) ── */

test('ONE (no Settings row): an employee’s customer is approved by one admin, as before', async () => {
  reset(undefined);
  queuePerson('R-ONE', ABDUL);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('approve:R-ONE', KRISHNA));

  assert.equal(customersAdded.length, 1, 'one tap creates the customer');
  assert.equal(rows['R-ONE'].status, 'approved');
  assert.ok(!answers(bot).some((t) => /1 of 2/.test(t)), 'no "1 of 2" anywhere');
  assert.equal(approvalGate.requiredFor(rows['R-ONE']), 1, 'the requester’s cards count one');
  assert.doesNotMatch(approvalCards.buildAddContactCard(rows['R-ONE'].actionJSON), /two admins/);
});

test('ONE: an admin’s own customer entry is saved by that admin’s own ✅ Approve', async () => {
  reset(1);
  const bot = createFakeBot();
  await submitCustomerThroughTheDoor(bot, KRISHNA);

  const row = onlyRequest();
  assert.ok(row, 'the entry is still a request on the queue');
  assert.equal(row.actionJSON.action, 'add_contact');
  assert.equal(String(row.user), KRISHNA);
  assert.equal(customersAdded.length, 0, 'Submit alone saves nothing');
  // The approval card goes to every admin, the requester included — that
  // card's ✅ Approve is where the admin saves their own entry. (If a later
  // change stops sending the requester their own card, this door needs its
  // own button — hence the pin.)
  const own = everyButton(bot, KRISHNA).find((b) => b.callback_data === `approve:${row.requestId}`);
  assert.ok(own, 'the admin’s own chat carries an Approve for their entry');
  assert.ok(everyButton(bot, MUSA).some((b) => b.callback_data === `approve:${row.requestId}`),
    'the other admin still gets the request');
  assert.match(textsIn(bot, KRISHNA), /One admin is enough for a new customer — tap ✅ Approve on the card below/);

  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb(`approve:${row.requestId}`, KRISHNA));
  assert.equal(customersAdded.length, 1, 'the admin’s own approval creates the customer');
  assert.equal(customersAdded[0].name, 'Amib International');
  assert.equal(rows[row.requestId].status, 'approved');
  assert.ok(contactsAdded.some((c) => c.type === 'customer'), 'and its network node');
  assert.ok(!answers(bot2).some((t) => /cannot approve your own/.test(t)));
  // One admin's word is never a silent one: the other admin is told.
  assert.match(textsIn(bot2, MUSA),
    /ℹ️ .* added the customer Amib International and approved it on their own \(one admin is enough for a new customer\)\. R-/);
});

test('ONE: an employee’s customer approved by an admin sends no "on their own" notice', async () => {
  reset(1);
  queuePerson('R-NOFYI', ABDUL);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('approve:R-NOFYI', KRISHNA));
  assert.equal(customersAdded.length, 1);
  assert.doesNotMatch(textsIn(bot, MUSA), /on their own/);
});

test('ONE: another admin may still approve an admin’s entry instead', async () => {
  reset(1);
  queuePerson('R-OTHER', KRISHNA);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('approve:R-OTHER', MUSA));
  assert.equal(customersAdded.length, 1);
  assert.equal(rows['R-OTHER'].status, 'approved');
});

test('ONE: an admin’s own NON-customer entry still needs another admin', async () => {
  reset(1);
  queuePerson('R-WORKER', KRISHNA, { type: 'worker' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('approve:R-WORKER', KRISHNA));
  assert.equal(contactsAdded.length, 0, 'nothing written');
  assert.equal(rows['R-WORKER'].status, 'pending');
  assert.ok(answers(bot).some((t) => /cannot approve your own request/.test(t)));

  // …and routing their own customer entry to 📒 Contact is the same refusal.
  queuePerson('R-OWNCONTACT', KRISHNA);
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('ctg:R-OWNCONTACT:p', KRISHNA));
  assert.equal(contactsAdded.length, 0);
  assert.equal(rows['R-OWNCONTACT'].status, 'pending');
  assert.ok(answers(bot2).some((t) => /cannot approve your own request/.test(t)));
  // The refused tap leaves no routing behind: the other admin's plain
  // Approve still files the person as the CUSTOMER that was requested.
  assert.ok(!rows['R-OWNCONTACT'].actionJSON.destination, 'no destination left on the row');
  await controller.handleCallbackQuery(createFakeBot(), cb('approve:R-OWNCONTACT', MUSA));
  assert.equal(customersAdded.length, 1, 'filed as a customer, as requested');
});

test('a routing chip that DOES decide keeps its routing (the undo is for refusals only)', async () => {
  reset(2);
  queuePerson('R-KEEP', ABDUL, { type: 'other' });
  await controller.handleCallbackQuery(createFakeBot(), cb('ctg:R-KEEP:c', KRISHNA));
  assert.equal(rows['R-KEEP'].actionJSON.destination, 'customer', 'a recorded first signature keeps its routing');
  assert.deepEqual(rows['R-KEEP'].actionJSON.approvals, [KRISHNA]);
  await controller.handleCallbackQuery(createFakeBot(), cb('approve:R-KEEP', MUSA));
  assert.equal(customersAdded.length, 1);
});

test('ONE: the switch opens nothing but a customer entry — another kind of own request stays closed', async () => {
  reset(1);
  rows['R-PRICE'] = {
    requestId: 'R-PRICE', user: KRISHNA, status: 'pending', createdAt: '2026-11-27T09:00:00.000Z',
    actionJSON: { action: 'update_price', design: '9006', shade: 'BLACK', price: 1500 },
    riskReason: 'price',
  };
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('approve:R-PRICE', KRISHNA));
  assert.equal(rows['R-PRICE'].status, 'pending', 'the switch opens nothing but a customer entry');
  assert.ok(answers(bot).some((t) => /cannot approve your own request/.test(t)));
});

test('ONE: ⚡ Quick Add stays on the admin’s name step', async () => {
  reset(1);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:add_customer', KRISHNA));
  await controller.handleCallbackQuery(bot, cb('actype:customer', KRISHNA));
  assert.ok(screen(bot).kb.some((b) => b.callback_data === 'acquick:1'));
});

/* ── TWO admins ── */

test('TWO: an employee’s customer needs two DIFFERENT admins', async () => {
  reset(2);
  queuePerson('R-TWO', ABDUL);

  // First admin — recorded, nothing created.
  const bot1 = createFakeBot();
  await controller.handleCallbackQuery(bot1, cb('ctg:R-TWO:c', KRISHNA));
  assert.equal(customersAdded.length, 0, 'one signature creates nothing');
  assert.equal(rows['R-TWO'].status, 'pending');
  assert.deepEqual(rows['R-TWO'].actionJSON.approvals, [KRISHNA]);
  assert.ok(answers(bot1).some((t) => /Approval 1 of 2 recorded/.test(t)));
  assert.equal(approvalGate.requiredFor(rows['R-TWO']), 2, 'the requester’s cards count two');
  const toAbdul = bot1.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === ABDUL)
    .map((c) => String(c.args.text || '')).join('\n');
  assert.match(toAbdul, /1 of 2/, 'the requester is told one of two has signed');

  // The same admin again — refused.
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('approve:R-TWO', KRISHNA));
  assert.equal(customersAdded.length, 0);
  assert.equal(rows['R-TWO'].status, 'pending');
  assert.ok(answers(bot2).some((t) => /different admin must give the second/.test(t)));

  // A different admin — completes it.
  const bot3 = createFakeBot();
  await controller.handleCallbackQuery(bot3, cb('approve:R-TWO', MUSA));
  assert.equal(customersAdded.length, 1, 'the second admin creates the customer');
  assert.equal(rows['R-TWO'].status, 'approved');
});

test('TWO: a plain Approve on a customer-typed request is a first signature too', async () => {
  reset('2');
  queuePerson('R-PLAIN', ABDUL);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('approve:R-PLAIN', MUSA));
  assert.equal(customersAdded.length, 0);
  assert.deepEqual(rows['R-PLAIN'].actionJSON.approvals, [MUSA]);
});

test('TWO: a request routed to 📒 Contact is not a customer — one admin, at once', async () => {
  reset(2);
  queuePerson('R-PHONE', ABDUL, { type: 'other' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('ctg:R-PHONE:p', KRISHNA));
  assert.equal(contactsAdded.length, 1, 'the phonebook entry is written on one approval');
  assert.equal(customersAdded.length, 0);
  assert.equal(rows['R-PHONE'].status, 'approved');
  assert.equal(approvalGate.requiredFor({ user: ABDUL, actionJSON: { action: 'add_contact', type: 'other' } }), 1);
});

test('TWO: an admin’s own customer needs one OTHER admin, never their own', async () => {
  reset(2);
  const bot = createFakeBot();
  await submitCustomerThroughTheDoor(bot, KRISHNA);
  const row = onlyRequest();
  assert.ok(row);
  assert.doesNotMatch(textsIn(bot, KRISHNA), /One admin is enough/, 'the submitted card promises no own approval');
  assert.match(textsIn(bot, KRISHNA), /⏳ Waiting for one other admin — a new customer needs two admins\./);
  assert.ok(everyButton(bot, MUSA).some((b) => b.callback_data === `approve:${row.requestId}`),
    'the other admin gets the request');

  const own = createFakeBot();
  await controller.handleCallbackQuery(own, cb(`approve:${row.requestId}`, KRISHNA));
  assert.equal(customersAdded.length, 0, 'their own tap is refused');
  assert.equal(rows[row.requestId].status, 'pending');
  assert.ok(answers(own).some((t) => /cannot approve your own request/.test(t)));
  assert.equal(approvalGate.requiredFor(rows[row.requestId]), 1, 'the requester counts as the first admin');

  const other = createFakeBot();
  await controller.handleCallbackQuery(other, cb(`approve:${row.requestId}`, MUSA));
  assert.equal(customersAdded.length, 1, 'one other admin completes it — two admins stand behind it');
  assert.equal(rows[row.requestId].status, 'approved');
});

test('TWO: ⚡ Quick Add is closed — not offered, and an old button writes nothing', async () => {
  reset(2);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:add_customer', KRISHNA));
  await controller.handleCallbackQuery(bot, cb('actype:customer', KRISHNA));
  assert.ok(!screen(bot).kb.some((b) => b.callback_data === 'acquick:1'), 'not offered');
  assert.doesNotMatch(screen(bot).text, /Quick Add/);

  // An old card's button, tapped after the switch moved.
  await controller.handleCallbackQuery(bot, cb('acquick:1', KRISHNA));
  assert.match(screen(bot).text, /needs two admins now, so Quick Add is closed/);
  await controller.handleMessage(bot, msg('Mariam Salisu', KRISHNA));
  assert.equal(customersAdded.length, 0, 'the line is taken as the full form’s name, not written');
  assert.equal(sessionStore.get(KRISHNA).name, 'Mariam Salisu');
});

test('TWO: a session already on the one-line step writes nothing when the switch moves', async () => {
  reset(1);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:add_customer', KRISHNA));
  await controller.handleCallbackQuery(bot, cb('actype:customer', KRISHNA));
  await controller.handleCallbackQuery(bot, cb('acquick:1', KRISHNA));
  assert.equal(sessionStore.get(KRISHNA).step, 'quick_add');

  switchCell = 2; customerApprovals._reset(); // the owner types 2
  await controller.handleMessage(bot, msg('Mariam Salisu, +2348035557777', KRISHNA));
  assert.equal(customersAdded.length, 0, 'nothing is written on one admin’s word');
  assert.match(screen(bot).text, /Quick Add is closed/);
  assert.equal(sessionStore.get(KRISHNA).step, 'name');
});

test('TWO: the approval card says two admins are needed, before the first tap', async () => {
  reset(2);
  await customerApprovals.count();
  const aj = { action: 'add_contact', name: 'Amib', type: 'customer' };
  const card = approvalCards.buildAddContactCard(aj);
  assert.match(card, /🔏 A customer needs two admins\. Contact and Network need one\./);
  // A decided record states no present-tense rule.
  assert.doesNotMatch(await approvalCards.buildCardFromActionJSON(aj, { decided: true }), /needs two admins/);
});

test('TWO: the message admins are SENT says so, and so does the employee’s submitted card', async () => {
  reset(2);
  const bot = createFakeBot();
  await submitCustomerThroughTheDoor(bot, ABDUL);
  const row = onlyRequest();
  assert.ok(row);
  for (const admin of [KRISHNA, MUSA]) {
    assert.match(textsIn(bot, admin), /Approval required/);
    assert.match(textsIn(bot, admin), /🔏 A customer needs two admins/, `${admin}'s card says two are needed`);
  }
  assert.match(textsIn(bot, ABDUL), /⏳ Waiting for admin approval — a new customer needs two admins\./);

  // An admin's own entry on two: "one other admin".
  reset(2);
  const bot2 = createFakeBot();
  await submitCustomerThroughTheDoor(bot2, KRISHNA);
  assert.match(textsIn(bot2, KRISHNA), /⏳ Waiting for one other admin — a new customer needs two admins\./);
});

test('ONE: neither the admins’ message nor the submitted card mentions two admins', async () => {
  reset(1);
  const bot = createFakeBot();
  await submitCustomerThroughTheDoor(bot, ABDUL);
  assert.doesNotMatch(textsIn(bot, KRISHNA), /two admins/);
  assert.match(textsIn(bot, ABDUL), /⏳ Waiting for admin approval\.\n/);
  assert.doesNotMatch(textsIn(bot, ABDUL), /two admins/);
});

test('the switch is live: 2 → 1 lets the one signature already given finish it', async () => {
  reset(2);
  queuePerson('R-FLIP', ABDUL);
  await controller.handleCallbackQuery(createFakeBot(), cb('approve:R-FLIP', KRISHNA));
  assert.equal(customersAdded.length, 0);

  switchCell = 1; customerApprovals._reset(); // the owner types 1
  await controller.handleCallbackQuery(createFakeBot(), cb('approve:R-FLIP', MUSA));
  assert.equal(customersAdded.length, 1);
  assert.equal(rows['R-FLIP'].status, 'approved');
});

/* ── second review ── */

test('only a customer entry asks the Settings sheet at the gate — no other approval waits on it', async () => {
  reset(1);
  const real = customerApprovals.count;
  let asked = 0;
  customerApprovals.count = async (...a) => { asked += 1; return real(...a); };
  try {
    queuePerson('R-WORKER2', ABDUL, { type: 'worker' });
    await controller.handleCallbackQuery(createFakeBot(), cb('approve:R-WORKER2', KRISHNA));
    assert.equal(rows['R-WORKER2'].status, 'approved');
    assert.equal(asked, 0, 'a phonebook entry is approved without reading the switch');

    queuePerson('R-CUST2', ABDUL);
    await controller.handleCallbackQuery(createFakeBot(), cb('approve:R-CUST2', KRISHNA));
    assert.ok(asked >= 1, 'a customer entry reads it fresh');
  } finally { customerApprovals.count = real; }
});

test('an unreadable sheet is asked once per window, not by every card', async () => {
  reset(2);
  const stub = settingsRepository.getAllStrict;
  let reads = 0;
  settingsRepository.getAllStrict = async () => { reads += 1; throw new Error('Sheets is down'); };
  try {
    for (let i = 0; i < 8; i += 1) customerApprovals.countNow();
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 8; i += 1) customerApprovals.countNow();
    await new Promise((r) => setImmediate(r));
    assert.equal(reads, 1, 'sixteen card renders, one read attempt');
    assert.equal(customerApprovals.countNow(), 2, 'and still the strict reading');
  } finally { settingsRepository.getAllStrict = stub; }
});

test('a first signature that cannot be SAVED leaves no routing on the row', async () => {
  reset(2);
  queuePerson('R-NOSAVE', ABDUL, { type: 'other' });
  const realUpdate = approvalQueueRepository.updateActionJSON;
  approvalQueueRepository.updateActionJSON = async (id, patch) => {
    if (patch && Array.isArray(patch.approvals)) throw new Error('quota');
    return realUpdate(id, patch);
  };
  try {
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('ctg:R-NOSAVE:c', KRISHNA));
    assert.ok(answers(bot).some((t) => /Could not record your approval — nothing was approved/.test(t)));
    assert.equal(rows['R-NOSAVE'].status, 'pending');
    assert.ok(!rows['R-NOSAVE'].actionJSON.destination, 'the 🛒 routing nobody signed is gone');
    assert.ok(!rows['R-NOSAVE'].actionJSON.approvals);
  } finally { approvalQueueRepository.updateActionJSON = realUpdate; }
});

test('the inbox / reminder card is drawn from a reading at most one window old', async () => {
  reset(2);
  const aj = { action: 'add_contact', name: 'Amib', type: 'customer' };
  assert.match(await approvalCards.buildCardFromActionJSON(aj), /needs two admins/);
  switchCell = 1;               // the owner types 1 — nobody has tapped since
  customerApprovals._expire();  // …and the 30 s window has passed
  assert.match(approvalCards.buildAddContactCard(aj), /needs two admins/, 'the synchronous builder alone would still say two');
  customerApprovals._expire();
  assert.doesNotMatch(await approvalCards.buildCardFromActionJSON(aj), /needs two admins/, 'the awaited card reads the cell');
});

test('twenty cards drawn while the sheet is unreadable ask it once', async () => {
  reset(2);
  const stub = settingsRepository.getAllStrict;
  let reads = 0;
  settingsRepository.getAllStrict = async () => { reads += 1; throw new Error('Sheets is down'); };
  try {
    const aj = { action: 'add_contact', name: 'Amib', type: 'customer' };
    for (let i = 0; i < 20; i += 1) {
      assert.match(await approvalCards.buildCardFromActionJSON(aj), /needs two admins/, 'unread = the strict reading');
    }
    assert.equal(reads, 1);
  } finally { settingsRepository.getAllStrict = stub; }
});

test('Quick Add closed by an UNREAD switch says the sheet could not be read, not "two admins"', async () => {
  reset(1);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:add_customer', KRISHNA));
  await controller.handleCallbackQuery(bot, cb('actype:customer', KRISHNA));
  assert.ok(screen(bot).kb.some((b) => b.callback_data === 'acquick:1'));

  customerApprovals._reset(); // a restart…
  const stub = settingsRepository.getAllStrict;
  settingsRepository.getAllStrict = async () => { throw new Error('Sheets is down'); }; // …with the sheet unreadable
  try {
    await controller.handleCallbackQuery(bot, cb('acquick:1', KRISHNA));
    assert.match(screen(bot).text, /Settings sheet could not be read just now, so Quick Add is closed until it can be/);
    assert.doesNotMatch(screen(bot).text, /two admins/);
  } finally { settingsRepository.getAllStrict = stub; }
});

test('TWO: either admin may still file the person as a 📒 Contact — that takes one admin, and creates no customer', async () => {
  reset(2);
  queuePerson('R-REROUTE', ABDUL);
  await controller.handleCallbackQuery(createFakeBot(), cb('ctg:R-REROUTE:c', KRISHNA));
  assert.deepEqual(rows['R-REROUTE'].actionJSON.approvals, [KRISHNA]);
  await controller.handleCallbackQuery(createFakeBot(), cb('ctg:R-REROUTE:p', KRISHNA));
  assert.equal(rows['R-REROUTE'].status, 'approved');
  assert.equal(customersAdded.length, 0, 'no customer was created on one admin');
  assert.equal(contactsAdded.length, 1, 'a phonebook entry, which one admin may always file');
});
