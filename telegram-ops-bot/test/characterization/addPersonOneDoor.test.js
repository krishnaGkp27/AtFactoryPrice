'use strict';

/**
 * CON-1 (owner, 15-Aug-2026) — one door for adding a person on Telegram.
 *
 * "Adding a user/customer isn't asking the category under which it come like
 * we discussed before." Two doors created people and only one carried the
 * CNET-2 triage: the guided ➕ Add Customer tile queued `add_customer` (plain
 * Approve, Customers row, NO network node), while the typed "add contact …"
 * queued `add_contact` (chips, both registers stitched). Owner's ruling:
 * "Keep single entry of any user added in telegram. Add contact flow has
 * perfect build in this situation. For any other addition contact will have
 * sub-categories if-needed. All other employees still keep on added through
 * railway variables."
 *
 * Pinned here:
 *  - the tile opens the flow on a TYPE step, before anything else is asked;
 *  - Customer walks on to the sub-categories; every other kind skips them;
 *  - whatever kind was picked, the submission queues ONE shape: add_contact,
 *    carrying the type (and the customer extras only for a customer);
 *  - a plain Approve HONOURS that type — a Customer-typed request lands in
 *    both registers, not the phonebook (the split-brain is dead);
 *  - a Worker-typed request still lands in the phonebook, as it always did;
 *  - a chip override still beats the requested type;
 *  - the admin Quick Add one-liner also writes both registers;
 *  - a legacy `add_customer` row already sitting in the queue still approves.
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
const crmService = require(path.join(SRC, 'services/crmService'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

const ADMIN = '777';
const STAFF = '888';

/* ── fixture state ── */
let rows = {};
let contactsAdded = [];
let linksAdded = [];
let customersAdded = [];

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
contactLinksRepository.append = async (l) => { linksAdded.push(l); return { ...l, link_id: 'CL-1' }; };
crmService.addCustomer = async (c) => {
  const hit = customersAdded.find((x) => x.name.toLowerCase() === String(c.name).toLowerCase());
  if (hit) return { status: 'exists', customer: hit };
  const cust = { ...c, customer_id: `AFP-C-${customersAdded.length + 1}` };
  customersAdded.push(cust);
  return { status: 'created', customer: cust };
};
customerEntity.resolve = async () => null;

function reset() {
  rows = {}; contactsAdded = []; linksAdded = []; customersAdded = [];
  sessionStore.clear(ADMIN); sessionStore.clear(STAFF);
}
const cb = (data, uid = ADMIN) => ({
  data, id: `q-${data}`, from: { id: uid },
  message: { message_id: 9, chat: { id: uid } },
});
const msg = (text, uid = STAFF) => ({ from: { id: uid }, chat: { id: uid }, text });

/** Every button offered on the most recent screen the bot painted. */
function screenKb(bot) {
  const c = bot.calls.filter((x) => x.method === 'editMessageText' || x.method === 'sendMessage').pop();
  const kb = c && c.args.opts && c.args.opts.reply_markup;
  return kb ? kb.inline_keyboard.flat() : [];
}
function screenText(bot) {
  const c = bot.calls.filter((x) => x.method === 'editMessageText' || x.method === 'sendMessage').pop();
  return c ? String(c.args.text || '') : '';
}

/** Drive the flow from the tile up to (and including) the address answer. */
async function walkToAddress(bot, typeKey, uid = STAFF) {
  await controller.handleCallbackQuery(bot, cb('act:add_customer', uid));
  await controller.handleCallbackQuery(bot, cb(`actype:${typeKey}`, uid));
  await controller.handleMessage(bot, msg('Mr femi', uid));
  await controller.handleMessage(bot, msg('+2348012345678', uid));
  await controller.handleMessage(bot, msg('Kano', uid));
}

function queuePerson(requestId, aj = {}) {
  rows[requestId] = {
    requestId, user: STAFF, status: 'pending', createdAt: '2026-08-15T09:00:00.000Z',
    actionJSON: {
      action: 'add_contact', name: 'Mr femi', type: 'other',
      phone: '+2348012345678', address: 'Kano', notes: '', ...aj,
    },
    riskReason: 'contact creation',
  };
}

/* ── the door ── */

test('the tile opens on the TYPE step — the kind of person is asked first', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:add_customer', STAFF));

  assert.match(screenText(bot), /Who are you adding\?/,
    'the first question is what kind of person this is, not their name');
  const kb = screenKb(bot).map((b) => b.callback_data);
  assert.deepEqual(kb, [
    'actype:customer', 'actype:worker', 'actype:agent',
    'actype:supplier', 'actype:other', 'accanc:0',
  ], 'the five contact kinds, plus Cancel');
});

test('Customer is asked the sub-categories; a Worker walks straight past them', async () => {
  reset();
  const custBot = createFakeBot();
  await walkToAddress(custBot, 'customer');
  assert.match(screenText(custBot), /categor/i,
    'a customer carries a trade category — so it is asked');

  reset();
  const workerBot = createFakeBot();
  await walkToAddress(workerBot, 'worker');
  const after = screenText(workerBot);
  assert.doesNotMatch(after, /credit limit/i, 'a worker has no credit limit');
  assert.match(after, /note/i, 'a worker goes straight from address to notes');
});

/* ── one shape out of the door ── */

test('a Customer submission queues add_contact carrying the type AND the extras', async () => {
  reset();
  const bot = createFakeBot();
  await walkToAddress(bot, 'customer');
  await controller.handleCallbackQuery(bot, cb('accat:Wholesale', STAFF));
  await controller.handleCallbackQuery(bot, cb('accred:500000', STAFF));
  await controller.handleCallbackQuery(bot, cb('acpt:COD', STAFF));
  await controller.handleCallbackQuery(bot, cb('acskip:notes', STAFF));
  await controller.handleCallbackQuery(bot, cb('acconf:1', STAFF));

  const queued = Object.values(rows)[0];
  assert.ok(queued, 'request queued');
  const aj = queued.actionJSON;
  assert.equal(aj.action, 'add_contact', 'ONE pipeline — never the old add_customer');
  assert.equal(aj.type, 'customer', 'the kind the requester picked rides along');
  assert.equal(aj.name, 'Mr femi');
  assert.equal(aj.category, 'Wholesale');
  assert.equal(aj.credit_limit, 500000);
  assert.equal(aj.payment_terms, 'COD');

  const kb = approvalCards.keyboardForRequest(queued.requestId, aj).inline_keyboard.flat();
  assert.deepEqual(kb.map((b) => b.callback_data),
    [`ctg:${queued.requestId}:c`, `ctg:${queued.requestId}:p`, `ctg:${queued.requestId}:n`, `reject:${queued.requestId}`],
    'the guided door now gets the triage chips it never had');
});

test('a Worker submission queues the same shape, without the customer extras', async () => {
  reset();
  const bot = createFakeBot();
  await walkToAddress(bot, 'worker');
  await controller.handleCallbackQuery(bot, cb('acskip:notes', STAFF));
  await controller.handleCallbackQuery(bot, cb('acconf:1', STAFF));

  const aj = Object.values(rows)[0].actionJSON;
  assert.equal(aj.action, 'add_contact');
  assert.equal(aj.type, 'worker');
  assert.equal(aj.category, undefined, 'no padded trade category on a worker');
  assert.equal(aj.credit_limit, undefined);
  assert.equal(aj.payment_terms, undefined);
});

/* ── the card ── */

test('the card prints the customer extras, and only when there are any', async () => {
  const custCard = await approvalCards.buildCardFromActionJSON({
    action: 'add_contact', name: 'Mr femi', type: 'customer', phone: '+2348012345678',
    address: 'Kano', category: 'Wholesale', credit_limit: 500000, payment_terms: 'COD',
  });
  assert.match(custCard, /Wholesale/);
  assert.match(custCard, /COD/);
  assert.match(custCard, /registers them as a CUSTOMER/,
    'the admin is told what silence means on this card');

  const workerCard = await approvalCards.buildCardFromActionJSON({
    action: 'add_contact', name: 'Ibrahim', type: 'worker', phone: '', address: '',
  });
  assert.doesNotMatch(workerCard, /Credit limit/i, 'no empty trade lines on a worker card');
  assert.doesNotMatch(workerCard, /registers them as a CUSTOMER/,
    'and no customer promise on a worker card');
});

/* ── what a plain Approve means now ── */

test('plain Approve on a Customer-typed request writes BOTH registers — the split-brain is dead', async () => {
  reset();
  queuePerson('R-C1', { type: 'customer', category: 'Wholesale', credit_limit: 500000, payment_terms: 'COD' });
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cb('approve:R-C1'), 'approve');

  assert.equal(rows['R-C1'].status, 'approved');
  assert.equal(customersAdded.length, 1, 'the customer exists in the customer list');
  assert.equal(customersAdded[0].category, 'Wholesale', 'the sub-categories reached the CRM row');
  assert.equal(customersAdded[0].credit_limit, 500000);
  assert.equal(customersAdded[0].payment_terms, 'COD');
  assert.equal(contactsAdded.length, 1, 'and in the network');
  assert.equal(contactsAdded[0].customer_id, 'AFP-C-1', 'bound to the entity — one person, one identity');
});

test('plain Approve on a Worker-typed request is still the phonebook, exactly as before', async () => {
  reset();
  queuePerson('R-W1', { type: 'worker' });
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cb('approve:R-W1'), 'approve');

  assert.equal(rows['R-W1'].status, 'approved');
  assert.equal(customersAdded.length, 0, 'never a surprise registration');
  assert.equal(contactsAdded.length, 1);
  assert.equal(contactsAdded[0].type, 'worker');
});

test('a chip still overrides the requested type — the admin has the last word', async () => {
  reset();
  queuePerson('R-O1', { type: 'customer', category: 'Wholesale' });
  const bot = createFakeBot();
  await approvalEvents.handleContactTriageCallback(bot, cb('ctg:R-O1:p'));

  assert.equal(rows['R-O1'].status, 'approved');
  assert.equal(customersAdded.length, 0, '📒 Contact beats a Customer-typed request');
  assert.equal(contactsAdded.length, 1);
});

/* ── the admin one-liner ── */

test('Quick Add writes the CRM row AND the bound node, not a customer with no node', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:add_customer', ADMIN));
  await controller.handleCallbackQuery(bot, cb('actype:customer', ADMIN));
  await controller.handleCallbackQuery(bot, cb('acquick:1', ADMIN));
  await controller.handleMessage(bot, msg('Mariam Salisu, +2348035557777', ADMIN));

  assert.equal(customersAdded.length, 1, 'customer written');
  assert.equal(contactsAdded.length, 1, 'and the node beside it');
  assert.equal(contactsAdded[0].type, 'customer');
  assert.equal(contactsAdded[0].customer_id, customersAdded[0].customer_id, 'stitched');
});

/* ── nothing already in flight breaks ── */

test('a legacy add_customer row sitting in the queue still approves through its executor', async () => {
  reset();
  rows['R-L1'] = {
    requestId: 'R-L1', user: STAFF, status: 'pending', createdAt: '2026-08-14T09:00:00.000Z',
    actionJSON: {
      action: 'add_customer', name: 'Legacy Buyer', phone: '+2348000000000',
      address: 'Lagos', category: 'Retail', credit_limit: 0, payment_terms: 'COD',
    },
    riskReason: 'customer creation',
  };
  const bot = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot, cb('approve:R-L1'), 'approve');

  assert.equal(rows['R-L1'].status, 'approved', 'the retired action still executes');
  assert.equal(customersAdded.length, 1);
  assert.equal(customersAdded[0].name, 'Legacy Buyer');
  // …and it cannot deposit a split-brain on its way out: a row raised
  // before CON-1 and approved after it gets its node too.
  assert.equal(contactsAdded.length, 1, 'the retired door stitches both registers as well');
  assert.equal(contactsAdded[0].customer_id, customersAdded[0].customer_id);
});

test('typed "add customer …" is turned back to the one door instead of queueing', async () => {
  reset();
  const { installFakeIntent: setIntent } = require('../helpers/controllerHarness');
  setIntent(() => ({ action: 'add_customer', customer: 'Mr femi', confidence: 0.9 }));

  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Add customer Mr femi, wholesale'));

  assert.equal(Object.keys(rows).length, 0, 'no bare add_customer request is produced');
  const sent = bot.callsTo('sendMessage').map((c) => String(c.args.text)).join('\n');
  assert.match(sent, /Add Contact/, 'the typed path points at the one door');
  const kb = bot.callsTo('sendMessage')
    .flatMap((c) => (((c.args.opts || {}).reply_markup || {}).inline_keyboard || []).flat());
  assert.ok(kb.some((b) => b.callback_data === 'act:add_customer'), 'and offers it as a tap');
  setIntent(() => ({ action: 'unknown', confidence: 0 }));
});
