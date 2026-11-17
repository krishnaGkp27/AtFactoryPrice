'use strict';

/**
 * CUS-4 — the typed customer line through the REAL controller.
 *
 * Owner, 17-Nov-2026, on three typed lines answered by the chips card:
 * "My office employees aren't able to add customer by direct typing."
 *
 * Pinned:
 *  - the three lines open the ➕ Add Contact confirm card already filled in,
 *    with no AI call; nothing is queued before Submit;
 *  - Submit raises the SAME `add_contact` request the door raises, kind
 *    customer, with the door's defaults (Retail · 0 · COD) and the store by
 *    the door's own rule;
 *  - the freeze and the duplicate-name check still stand in front of it;
 *  - no phone number, no customer: `Customer Abba` is still a lookup;
 *  - an admin (no single store) is asked the store first;
 *  - ✏️ Change details walks the full form;
 *  - the Settings switch turns the line off;
 *  - a live typed step is never hijacked.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return { action: 'unknown', confidence: 0 }; });
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));
const locationService = require(path.join(SRC, 'services/locationService'));
const approvalGate = require(path.join(SRC, 'services/approvalGate'));

const STAFF = '888';
const ADMIN = '777';
let QUEUE = [];
let NOTIFIED = [];
let SETTINGS = {};
let TAKEN = {};
approvalQueueRepository.append = async (rec) => { QUEUE.push(rec); };
approvalQueueRepository.getByRequestId = async (id) => QUEUE.find((q) => q.requestId === id) || null;
approvalQueueRepository.getAllPending = async () => QUEUE;
auditLogRepository.append = async () => {};
approvalEvents.notifyAdminsApprovalRequest = async (bot, requestId, label, summary) => { NOTIFIED.push({ requestId, label, summary }); return { sent: 1, failed: 0 }; };
settingsRepository.getAll = async () => ({ ...settingsRepository.DEFAULTS, ...SETTINGS });
usersRepository.findByUserId = async (id) => (String(id) === STAFF
  ? { user_id: STAFF, name: 'Abdul', status: 'active', warehouses: ['Kano office'] }
  : { user_id: String(id), name: 'Krishna', status: 'active', warehouses: [] });
customerEntity.assertNameFree = async (name) => (TAKEN[String(name).toLowerCase()]
  ? { ok: false, existing: TAKEN[String(name).toLowerCase()] } : { ok: true });
locationService.allPlaces = async () => [{ name: 'Lagos', status: 'open' }, { name: 'Kano office', status: 'open' }, { name: 'IDUMOTA', status: 'open' }];

const msg = (text, uid = STAFF) => ({ from: { id: uid }, chat: { id: uid }, text });
const cb = (data, uid = STAFF) => ({ data, id: `q-${data}`, from: { id: uid }, message: { message_id: 9, chat: { id: uid } } });
function lastScreen(bot) { return bot.calls.filter((x) => x.method === 'editMessageText' || x.method === 'sendMessage').pop(); }
function screenText(bot) { const c = lastScreen(bot); return c ? String(c.args.text || '') : ''; }
function screenKb(bot) {
  const c = lastScreen(bot);
  const kb = c && c.args.opts && c.args.opts.reply_markup;
  return kb ? kb.inline_keyboard.flat().filter((b) => !String(b.callback_data).startsWith('act:')).map((b) => `${b.text}|${b.callback_data}`) : [];
}

test.beforeEach(() => {
  QUEUE = []; NOTIFIED = []; SETTINGS = {}; TAKEN = {}; intentCalls = 0;
  sessionStore.clear(STAFF); sessionStore.clear(ADMIN);
  approvalGate._internals.recent.clear();
});

const THREE_LINES = 'Amib international\n0806 256 2752\nKano';

test('the owner\'s three lines open the Add Contact confirm card, filled in — no AI, nothing queued', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg(THREE_LINES));
  assert.equal(intentCalls, 0, 'read locally');
  assert.equal(screenText(bot),
    '➕ *Add contact*\n'
    + '✓ Type: *🛒 Customer*\n'
    + '✓ Name: *Amib international*\n'
    + '✓ Phone: *0806 256 2752*\n'
    + '✓ Address: *Kano*\n'
    + '✓ Store: *Kano office* _(provisional)_\n\n'
    + '*Confirm and submit for admin approval?*');
  assert.deepEqual(screenKb(bot), ['✅ Submit for Approval|acconf:1', '❌ Cancel|accanc:0', '✏️ Change details|acb:name']);
  assert.equal(QUEUE.length, 0, 'a typed line saves nothing');
  assert.equal(NOTIFIED.length, 0);
  assert.equal(sessionStore.get(STAFF).type, 'add_customer_flow');
});

test('Submit raises the door\'s own add_contact request: customer, the defaults, the employee\'s store', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg(THREE_LINES));
  await controller.handleCallbackQuery(bot, cb('acconf:1'));
  assert.equal(QUEUE.length, 1);
  const aj = QUEUE[0].actionJSON;
  assert.equal(QUEUE[0].user, STAFF);
  assert.deepEqual(
    { action: aj.action, type: aj.type, name: aj.name, phone: aj.phone, address: aj.address, category: aj.category, credit_limit: aj.credit_limit, payment_terms: aj.payment_terms, stores: aj.stores },
    { action: 'add_contact', type: 'customer', name: 'Amib international', phone: '0806 256 2752', address: 'Kano', category: 'Retail', credit_limit: 0, payment_terms: 'COD', stores: ['Kano office'] });
  assert.equal(NOTIFIED.length, 1, 'one card to the admins');
  assert.match(NOTIFIED[0].summary, /^Add contact: Amib international \(customer\)\nPhone: 0806 256 2752\nAddress: Kano\nCategory: Retail/);
  assert.match(screenText(bot), /Add contact — submitted/);
  assert.ok(!sessionStore.get(STAFF), 'the flow is over');
});

test('the worded forms open the same card', async () => {
  for (const line of ['Customer Amib international, 0806 256 2752, Kano', 'Add customer Amib international 0806 256 2752 Kano', 'Amib international, 0806 256 2752, Kano']) {
    sessionStore.clear(STAFF);
    const bot = createFakeBot();
    await controller.handleMessage(bot, msg(line));
    assert.match(screenText(bot), /✓ Name: \*Amib international\*\n✓ Phone: \*0806 256 2752\*\n✓ Address: \*Kano\*/, line);
  }
});

test('no phone number, no customer: Customer Abba is not an add, and a sentence with a number is not a person', async () => {
  for (const line of ['Customer Abba', 'call me on 08062562752', 'Amib international\nKano']) {
    const bot = createFakeBot();
    await controller.handleMessage(bot, msg(line));
    assert.ok(!sessionStore.get(STAFF) || sessionStore.get(STAFF).type !== 'add_customer_flow', line);
    assert.doesNotMatch(screenText(bot), /Add contact/, line);
  }
});

test('a name already on the list opens nothing and says who it is', async () => {
  TAKEN['amib international'] = { name: 'AMIB INTL', customer_id: 'C-012' };
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg(THREE_LINES));
  assert.equal(screenText(bot), '⚠️ Amib international is already on the customer list as AMIB INTL (C-012).\nNothing was opened. Pick them from the customer list instead.');
  assert.ok(!sessionStore.get(STAFF));
});

test('the freeze still stands in front of the typed line; the switch turns the line off', async () => {
  SETTINGS = { CUSTOMER_CREATION_ENABLED: 0 };
  let bot = createFakeBot();
  await controller.handleMessage(bot, msg(THREE_LINES));
  assert.match(screenText(bot), /Adding customers is paused for now/);
  assert.ok(!sessionStore.get(STAFF));

  SETTINGS = { TYPED_CUSTOMER_LINE: 0 };
  bot = createFakeBot();
  await controller.handleMessage(bot, msg(THREE_LINES));
  assert.ok(!sessionStore.get(STAFF), 'switched off: not read, as before');
  assert.doesNotMatch(screenText(bot), /Add contact/);
});

test('an admin has no single store: the store is asked first, then the same confirm card', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg(THREE_LINES, ADMIN));
  assert.match(screenText(bot), /✓ Address: \*Kano\*\n\nWhich store does this customer belong to\?/);
  assert.ok(screenKb(bot).includes('🏙 Kano office|acst:1'));
  assert.ok(screenKb(bot).includes('❔ Place later|acst:__later__'));
  await controller.handleCallbackQuery(bot, cb('acst:1', ADMIN));
  assert.match(screenText(bot), /✓ Store: \*Kano office\* _\(provisional\)_\n\n\*Confirm and submit for admin approval\?\*/);
  assert.ok(screenKb(bot).includes('✏️ Change details|acb:name'));
});

test('✏️ Change details walks the full form from the name; the card is then an ordinary one', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg(THREE_LINES));
  await controller.handleCallbackQuery(bot, cb('acb:name'));
  assert.match(screenText(bot), /Enter the \*full name\*/);
  const s = sessionStore.get(STAFF);
  assert.equal(s.step, 'name');
  assert.equal(s.personType, 'customer', 'the kind is kept');
  assert.equal(s.name, undefined);
  assert.equal(s.fromTypedLine, undefined);
});

test('a second number on the line is kept as a note', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Amib international\n0806 256 2752\n0703 111 2222\nKano'));
  assert.match(screenText(bot), /✓ Notes: \*Other phone: 0703 111 2222\*/);
  await controller.handleCallbackQuery(bot, cb('acconf:1'));
  assert.equal(QUEUE[0].actionJSON.notes, 'Other phone: 0703 111 2222');
});

test('a live typed step is never hijacked: inside the form, the same lines are the name being asked for', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:add_customer'));
  await controller.handleCallbackQuery(bot, cb('actype:worker'));
  await controller.handleMessage(bot, msg(THREE_LINES));
  const s = sessionStore.get(STAFF);
  assert.equal(s.personType, 'worker', 'still the form the person opened');
  assert.equal(s.step, 'phone');
  assert.equal(s.fromTypedLine, undefined);
});
