'use strict';

/**
 * CNET-2 (owner, 13-Aug-2026) — contact triage at approval.
 *
 * "Even after approving a contact requested by Abdul, I am not able to see
 * this customer when approving the sales bill." The approval card now routes
 * the contact: 🛒 Customer (CRM entity + bound buyer node), 📒 Contact
 * (phonebook, the old behaviour), or 🕸 Network (phonebook + a
 * subordinate_of edge under a buyer picked in place). Pinned:
 *
 *  - the card carries the FULL parsed detail and the three chips;
 *  - 🛒 creates the CRM entity AND a bound Contacts node — one person,
 *    both registers stitched;
 *  - a 🛒 name collision fails LOUD and the request stays pending;
 *  - 🕸 opens the buyer picker in place, and the placement creates the edge;
 *  - a plain approve: (old card, inbox delegate) = 📒 Contact, the
 *    pre-CNET-2 behaviour — never a surprise registration;
 *  - chips carry their requestId, so two pending contacts cannot cross-wire.
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

const ADMIN = '777';

/* ── fixture state ── */
let rows = {};            // requestId → queue row
let contactsAdded = [];
let linksAdded = [];
let customersAdded = [];
let existingContacts = [];

approvalQueueRepository.getByRequestId = async (id) => (rows[id] ? JSON.parse(JSON.stringify(rows[id])) : null);
approvalQueueRepository.getAllPending = async () => Object.values(rows).filter((r) => r.status === 'pending');
approvalQueueRepository.updateStatus = async (id, status) => { if (rows[id]) rows[id].status = status; return true; };
approvalQueueRepository.updateActionJSON = async (id, patch) => {
  if (rows[id]) rows[id].actionJSON = { ...rows[id].actionJSON, ...patch };
  return true;
};
auditLogRepository.append = async () => {};

contactsRepository.getAll = async () => existingContacts;
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
  rows = {}; contactsAdded = []; linksAdded = []; customersAdded = []; existingContacts = [];
}
function queueContact(requestId, aj = {}) {
  rows[requestId] = {
    requestId, user: '888', status: 'pending', createdAt: '2026-08-13T09:00:00.000Z',
    actionJSON: {
      action: 'add_contact', name: 'Mr femi', type: 'other',
      phone: '+2348012345678', address: 'Kano', notes: '', ...aj,
    },
    riskReason: 'contact creation',
  };
}
const cb = (data, uid = ADMIN) => ({ data, id: `q-${data}`, from: { id: uid }, message: { message_id: 9, chat: { id: uid } } });
function lastEdit(bot) {
  const c = bot.calls.filter((x) => x.method === 'editMessageText').pop();
  return c ? String(c.args.text || '') : '';
}
function lastEditKb(bot) {
  const c = bot.calls.filter((x) => x.method === 'editMessageText').pop();
  const kb = c && c.args.opts && c.args.opts.reply_markup;
  return kb ? kb.inline_keyboard.flat() : [];
}

/* ── the card ── */

test('the card shows every parsed detail and the keyboard carries the three chips', async () => {
  const aj = { action: 'add_contact', name: 'Mr femi', type: 'other', phone: '+2348012345678', address: 'Kano', notes: 'met at market' };
  const card = await approvalCards.buildCardFromActionJSON(aj);
  assert.match(card, /📇 New contact — Mr femi/);
  assert.match(card, /🏷 typed as: other/);
  assert.match(card, /📞 \+2348012345678/);
  assert.match(card, /🏠 Kano/);
  assert.match(card, /📝 met at market/);
  assert.match(card, /Where does this person belong\?/);

  const kb = approvalCards.keyboardForRequest('R-1', aj).inline_keyboard.flat();
  assert.deepEqual(kb.map((b) => b.callback_data),
    ['ctg:R-1:c', 'ctg:R-1:p', 'ctg:R-1:n', 'reject:R-1']);
  assert.equal(approvalCards.keyboardForRequest('R-1', { action: 'sale_bundle' }), null,
    'every other action keeps the standard pair');
});

/* ── the front door ── */

test('Abdul’s typed message queues with the chip card, not a bare Approve', async () => {
  reset();
  let queuedRow = null;
  approvalQueueRepository.append = async (row) => { queuedRow = row; rows[row.requestId] = row; return row; };
  const { installFakeIntent: setIntent } = require('../helpers/controllerHarness');
  setIntent(() => ({ action: 'add_contact', customer: 'Mr femi', confidence: 0.95 }));

  const bot = createFakeBot();
  await controller.handleMessage(bot, {
    from: { id: '888' }, chat: { id: '888' },
    text: 'Add contact Mr femi, other, phone +2348012345678, address Kano',
  });

  assert.ok(queuedRow, 'request queued');
  assert.equal(queuedRow.actionJSON.action, 'add_contact');
  assert.equal(queuedRow.actionJSON.name, 'Mr femi');
  assert.equal(queuedRow.actionJSON.phone, '+2348012345678');

  const adminMsgs = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === ADMIN);
  const card = adminMsgs.map((c) => String(c.args.text)).join('\n').replace(/\\/g, '');
  assert.match(card, /📇 New contact — Mr femi/, 'full detail card, not the two-line summary');
  assert.match(card, /Where does this person belong\?/);
  const kb = adminMsgs.flatMap((c) => ((c.args.opts || {}).reply_markup || { inline_keyboard: [] }).inline_keyboard.flat());
  const rid = queuedRow.requestId;
  assert.ok(kb.some((b) => b.callback_data === `ctg:${rid}:c`), 'Customer chip');
  assert.ok(kb.some((b) => b.callback_data === `ctg:${rid}:n`), 'Network chip');
  assert.ok(!kb.some((b) => b.callback_data === `approve:${rid}`), 'no bare Approve on a contact card');
  setIntent(() => ({ action: 'unknown', confidence: 0 }));
});

/* ── 🛒 Customer ── */

test('🛒 stitches both registers: CRM entity + a Contacts node bound to it', async () => {
  reset(); queueContact('R-C1');
  const bot = createFakeBot();
  await approvalEvents.handleContactTriageCallback(bot, cb('ctg:R-C1:c'));

  assert.equal(rows['R-C1'].status, 'approved', 'the full approve path ran');
  assert.equal(customersAdded.length, 1, 'CRM entity created');
  assert.equal(customersAdded[0].name, 'Mr femi');
  assert.equal(contactsAdded.length, 1, 'contact node created too');
  assert.equal(contactsAdded[0].type, 'customer');
  assert.equal(contactsAdded[0].customer_id, 'AFP-C-1', 'node bound to the entity — the stitch');
});

test('a 🛒 name collision fails LOUD and the request stays pending', async () => {
  reset(); queueContact('R-C2');
  customersAdded.push({ name: 'Mr femi', customer_id: 'AFP-C-9' });
  const bot = createFakeBot();
  await approvalEvents.handleContactTriageCallback(bot, cb('ctg:R-C2:c'));

  assert.equal(rows['R-C2'].status, 'pending', 'no silent no-op approval');
  assert.equal(contactsAdded.length, 0, 'no orphan contact node');
  const all = bot.callsTo('sendMessage').map((c) => String(c.args.text)).join('\n');
  assert.match(all, /already exists as customer/i);
});

/* ── 📒 Contact ── */

test('📒 keeps the exact old behaviour, and so does a PLAIN approve from any old card', async () => {
  reset(); queueContact('R-P1');
  const bot = createFakeBot();
  await approvalEvents.handleContactTriageCallback(bot, cb('ctg:R-P1:p'));
  assert.equal(rows['R-P1'].status, 'approved');
  assert.equal(contactsAdded.length, 1);
  assert.equal(contactsAdded[0].type, 'other', 'the typed type is kept');
  assert.equal(customersAdded.length, 0, 'no customer entity');
  assert.equal(linksAdded.length, 0, 'no network edge');

  // The safe default: approve: with NO destination chosen = phonebook only.
  reset(); queueContact('R-P2');
  const bot2 = createFakeBot();
  await approvalEvents.handleApprovalCallback(bot2, cb('approve:R-P2'), 'approve');
  assert.equal(rows['R-P2'].status, 'approved');
  assert.equal(contactsAdded.length, 1, 'phonebook row');
  assert.equal(customersAdded.length, 0, 'never a surprise registration');
});

/* ── 🕸 Network ── */

test('🕸 opens the buyer picker in place; placement creates contact + edge', async () => {
  reset(); queueContact('R-N1');
  existingContacts = [
    { contact_id: 'CON-B1', name: 'KARIBULLAH', type: 'customer', customer_id: 'AFP-C-7', status: 'active' },
    { contact_id: 'CON-B2', name: 'OKSON', type: 'customer', customer_id: '', status: 'active' },
    { contact_id: 'CON-W1', name: 'Ibrahim', type: 'worker', customer_id: '', status: 'active' },
  ];
  const bot = createFakeBot();
  await approvalEvents.handleContactTriageCallback(bot, cb('ctg:R-N1:n'));
  const picker = lastEditKb(bot);
  assert.ok(picker.some((b) => b.text.includes('KARIBULLAH')), 'buyers offered');
  assert.ok(!picker.some((b) => b.text.includes('Ibrahim')), 'a worker is not a buyer');

  const karib = picker.find((b) => b.text.includes('KARIBULLAH'));
  await approvalEvents.handleContactTriageCallback(bot, cb(karib.callback_data));
  assert.match(lastEdit(bot), /Confirm placement/);

  await approvalEvents.handleContactTriageCallback(bot, cb(`ctg:R-N1:ok`));
  assert.equal(rows['R-N1'].status, 'approved');
  assert.equal(contactsAdded.length, 1, 'phonebook row created');
  assert.equal(linksAdded.length, 1, 'edge created');
  assert.equal(linksAdded[0].to_contact_id, 'CON-B1', 'under the picked buyer');
  assert.equal(linksAdded[0].relation, 'subordinate_of');
});

test('⬅ Back from the picker restores the triage card with its chips', async () => {
  reset(); queueContact('R-N2');
  existingContacts = [{ contact_id: 'CON-B1', name: 'KARIBULLAH', type: 'customer', status: 'active' }];
  const bot = createFakeBot();
  await approvalEvents.handleContactTriageCallback(bot, cb('ctg:R-N2:n'));
  await approvalEvents.handleContactTriageCallback(bot, cb('ctg:R-N2:x'));
  const kb = lastEditKb(bot);
  assert.ok(kb.some((b) => b.callback_data === 'ctg:R-N2:c'), 'chips are back');
  assert.equal(rows['R-N2'].status, 'pending', 'nothing approved');
});

/* ── guards ── */

test('two pending contacts cannot cross-wire, and a resolved row answers dead', async () => {
  reset(); queueContact('R-X1', { name: 'Person A' }); queueContact('R-X2', { name: 'Person B' });
  existingContacts = [{ contact_id: 'CON-B1', name: 'KARIBULLAH', type: 'customer', status: 'active' }];
  const bot = createFakeBot();
  // Open B's picker, then approve A as customer — A must not inherit B's state.
  await approvalEvents.handleContactTriageCallback(bot, cb('ctg:R-X2:n'));
  await approvalEvents.handleContactTriageCallback(bot, cb('ctg:R-X1:c'));
  assert.equal(rows['R-X1'].status, 'approved');
  assert.equal(customersAdded[0].name, 'Person A');
  assert.equal(rows['R-X2'].status, 'pending', 'B untouched by A’s approval');

  // A stale tap on the now-approved A is dead.
  const bot2 = createFakeBot();
  await approvalEvents.handleContactTriageCallback(bot2, cb('ctg:R-X1:p'));
  assert.equal(contactsAdded.filter((c) => c.name === 'Person A').length, 1, 'no double write');
});

test('non-admins cannot touch the chips; self-approval guard still holds through the delegate', async () => {
  reset(); queueContact('R-G1');
  const bot = createFakeBot();
  await approvalEvents.handleContactTriageCallback(bot, cb('ctg:R-G1:p', '888'));
  assert.equal(rows['R-G1'].status, 'pending', 'requester (non-admin) refused');

  // An ADMIN's own request: chip delegates into the approve path, whose
  // self-approval guard refuses while a second admin exists.
  reset(); queueContact('R-G2'); rows['R-G2'].user = ADMIN;
  const bot2 = createFakeBot();
  await approvalEvents.handleContactTriageCallback(bot2, cb('ctg:R-G2:p', ADMIN));
  assert.equal(rows['R-G2'].status, 'pending', 'self-approval refused via the delegate');
  assert.equal(contactsAdded.length, 0);
});
