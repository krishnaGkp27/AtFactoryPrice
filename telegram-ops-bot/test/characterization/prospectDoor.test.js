'use strict';

/**
 * PRS-1 (owner's go, 19-Nov-2026) — 🆕 Add Prospect, through the REAL
 * controller, the real approval pipeline and the real `add_contact`
 * executor on fake sheets.
 *
 * The prospect door is the SHORT path into the one ➕ Add Contact door
 * (§12b): name → phone → business card → store → confirm. It raises the
 * same `add_contact` request, the business card rides the request as
 * evidence, and the approved row is a 🆕 customer placed in the adder's
 * store.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242,4343,4444,4545';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const USERS_HEADER = ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs'];
const CUST_HEADER = ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases', 'stores', 'first_sale_at'];
const LOC_HEADER = ['name', 'location', 'kind', 'status', 'notes', 'updated_by', 'updated_at'];

const SEED = {
  Users: [USERS_HEADER,
    ['777', 'Krishna', 'admin', '', 'full', 'active', '', 'Admin', '', '', ''],
    ['888', 'Musa', 'admin', '', 'full', 'active', '', 'Admin', '', '', ''],
    ['4242', 'Bala', 'marketer', '', 'basic', 'active', '', 'Marketing', 'Kano office', '', ''],
    ['4343', 'Sani', 'employee', '', 'basic', 'Active', '', 'Sales', 'Lagos, IDUMOTA', '', ''],
    ['4444', 'Dauda', 'employee', '', 'basic', 'active', '', 'Dispatch', 'Kano office', '', ''],
    ['4545', 'Kafaya', 'employee', '', 'basic', 'active', '', 'Sales', 'IDUMOTA', '', ''],
  ],
  Departments: [['dept_id', 'dept_name', 'allowed_activities', 'status', 'created_at', 'parent_department', 'warehouses'],
    ['DEPT-001', 'Sales', 'supply_request,my_orders', 'active', '', '', ''],
    ['DEPT-002', 'Dispatch', 'my_orders', 'active', '', '', ''],
  ],
  Customers: [CUST_HEADER,
    ['c1', 'ABBA', '', '', 'Retail', 0, 0, 'COD', '', 'Active', '2026-07-01', '', '[]', 'Kano office', '2026-07-03'],
  ],
  Locations: [LOC_HEADER,
    ['Lagos', 'Lagos', 'warehouse', 'active', '', '', ''],
    ['IDUMOTA', 'Lagos', 'store', 'active', '', '', ''],
    ['Kano office', 'Kano', 'store', 'active', '', '', ''],
  ],
  // the bootstrap writes this header in production; the reader skips row 1
  Contacts: [['contact_id', 'name', 'phone', 'type', 'address', 'notes', 'created_at', 'whatsapp', 'customer_id', 'status', 'updated_by', 'updated_at']],
};
const fake = createFakeSheets(JSON.parse(JSON.stringify(SEED)));
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const contactsRepository = require(path.join(SRC, 'repositories/contactsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const approvalGate = require(path.join(SRC, 'services/approvalGate'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const region = require(path.join(SRC, 'services/customerRegion'));

let settings = {};
settingsRepository.getAll = async () => ({ ...settingsRepository.DEFAULTS, ...settings });
auditLogRepository.append = async () => {};
inventoryRepository.getAll = async () => [];
inventoryRepository.getSoldRows = async () => [];

const BALA = '4242'; // marketer, one store (Kano office)
const SANI = '4343'; // Sales, two stores
const DAUDA = '4444'; // Dispatch
const KAFAYA = '4545'; // Sales, Lagos region only
const ADMIN = '777';

const cq = (uid, data, mid = 77) => ({ id: `cq-${data}`, data, from: { id: Number(uid) }, message: { chat: { id: Number(uid) }, message_id: mid } });
const msg = (uid, text) => ({ message_id: 5, text, from: { id: Number(uid) }, chat: { id: Number(uid), type: 'private' } });
const photo = (uid, fileId = 'CARD-PHOTO') => ({ message_id: 6, from: { id: Number(uid) }, chat: { id: Number(uid), type: 'private' }, photo: [{ file_id: 'thumb' }, { file_id: fileId }] });
const fileImage = (uid, fileId = 'CARD-FILE') => ({ message_id: 7, from: { id: Number(uid) }, chat: { id: Number(uid), type: 'private' }, document: { file_id: fileId, mime_type: 'image/jpeg', file_name: 'card.jpg' } });
const to = (bot, uid) => bot.calls.filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText')
  && String(c.args.chatId ?? (c.args.opts && c.args.opts.chat_id)) === String(uid));
const lastTo = (bot, uid) => to(bot, uid).at(-1);
const textOf = (c) => String((c && c.args.text) || '');
const kbOf = (c) => (((c && c.args.opts && c.args.opts.reply_markup) || {}).inline_keyboard || []).flat().map((b) => `${b.text}|${b.callback_data}`);
const pending = async () => (await approvalQueueRepository.getAllPending()).filter((r) => r.actionJSON && r.actionJSON.action === 'add_contact');
const filesTo = (bot, uid) => bot.calls.filter((c) => (c.method === 'sendPhoto' || c.method === 'sendDocument') && String(c.args.chatId) === String(uid));

function reset() {
  for (const name of [...fake._store.keys()]) {
    fake._store.set(name, SEED[name] ? JSON.parse(JSON.stringify(SEED[name])) : fake._store.get(name).slice(0, 1));
  }
  settings = {};
  [BALA, SANI, DAUDA, KAFAYA, ADMIN, '888'].forEach((u) => sessionStore.clear(u));
  approvalGate._internals.recent.clear();
  region._resetForTests();
  if (typeof customersRepository.invalidateCache === 'function') customersRepository.invalidateCache();
  if (typeof usersRepository.invalidateCache === 'function') usersRepository.invalidateCache();
}

/** Every callback the menu offered this person. */
async function menuFor(uid) {
  const bot = createFakeBot();
  await controller.handleMessage(bot, { chat: { id: Number(uid), type: 'private' }, from: { id: Number(uid), first_name: 'X' }, text: 'hi' });
  return bot.calls.filter((c) => c.args && c.args.opts && c.args.opts.reply_markup)
    .flatMap((c) => (c.args.opts.reply_markup.inline_keyboard || []).flat()).map((b) => `${b.text}|${b.callback_data}`);
}

/** Walk the door to its confirm card: name, phone, then a card photo (or skip). */
async function walk(bot, uid, { name = 'Amib International', phone = '0806 256 2752', card = 'photo' } = {}) {
  await controller.handleCallbackQuery(bot, cq(uid, 'act:add_prospect'));
  await controller.handleMessage(bot, msg(uid, name));
  if (phone) await controller.handleMessage(bot, msg(uid, phone));
  else await controller.handleCallbackQuery(bot, cq(uid, 'acskip:phone'));
  if (card === 'photo') await controller.handleFileMessage(bot, photo(uid));
  else if (card === 'file') await controller.handleFileMessage(bot, fileImage(uid));
  else if (card === 'skip') await controller.handleCallbackQuery(bot, cq(uid, 'acskip:card'));
  // card 'none': stop at the card step
}

test.beforeEach(reset);

/* ── who is offered the tile ─────────────────────────────────────────── */

test('the tile is offered to a marketer and to Sales staff without a sheet edit; not to Dispatch', async () => {
  const bala = await menuFor(BALA);
  assert.ok(bala.includes('🆕 Add Prospect|act:add_prospect'), `marketer: ${bala.join(' · ')}`);
  const sani = await menuFor(SANI);
  assert.ok(sani.includes('🆕 Add Prospect|act:add_prospect') || sani.some((b) => b.endsWith('|act:__hub__:crm')), `Sales: ${sani.join(' · ')}`);
  const dauda = await menuFor(DAUDA);
  assert.ok(!dauda.some((b) => /add_prospect|__hub__:crm/.test(b)), `Dispatch: ${dauda.join(' · ')}`);
});

test('an admin finds it in the CRM hub beside ➕ Add Contact', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(ADMIN, 'act:__hub__:crm'));
  const kb = kbOf(lastTo(bot, ADMIN));
  assert.ok(kb.includes('➕ Add Contact|act:add_customer') && kb.includes('🆕 Add Prospect|act:add_prospect'), kb.join(' · '));
});

/* ── the short path ──────────────────────────────────────────────────── */

test('the tile opens the ONE door with the kind set: name first, Cancel only, no kind step', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(BALA, 'act:add_prospect'));
  const s = sessionStore.get(BALA);
  assert.deepEqual([s.type, s.step, s.personType, s.prospect], ['add_customer_flow', 'name', 'customer', true]);
  const card = lastTo(bot, BALA);
  assert.match(textOf(card), /^🆕 \*Add prospect\*\n✓ Type: \*🛒 Customer\* · no sale yet\n\nEnter the \*name\* of the shop or the person/);
  assert.deepEqual(kbOf(card), ['❌ Cancel|accanc:0']);
});

test('name → phone → business card → confirm: five answers, the store stamped, nothing else asked', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(BALA, 'act:add_prospect'));
  await controller.handleMessage(bot, msg(BALA, 'Amib International'));
  assert.match(textOf(lastTo(bot, BALA)), /Enter \*phone number\* \(or tap Skip\):/);

  await controller.handleMessage(bot, msg(BALA, '0806 256 2752'));
  let card = lastTo(bot, BALA);
  assert.equal(sessionStore.get(BALA).step, 'card', 'the address, category, credit and terms are not asked');
  assert.match(textOf(card), /📇 Send a \*photo of their business card\* \(or tap Skip\):/);
  assert.deepEqual(kbOf(card), ['⏭ Skip card|acskip:card', '⬅️ Back|acb:phone', '❌ Cancel|accanc:0']);

  await controller.handleFileMessage(bot, photo(BALA));
  card = lastTo(bot, BALA);
  const s = sessionStore.get(BALA);
  assert.equal(s.step, 'confirm');
  assert.deepEqual(s.card, { fileId: 'CARD-PHOTO', kind: 'photo' }, 'the largest size of the photo');
  assert.deepEqual(s.stores, ['Kano office'], 'a one-store person is not asked the store');
  assert.equal(textOf(card), [
    '🆕 *Add prospect*',
    '✓ Type: *🛒 Customer* · no sale yet',
    '✓ Name: *Amib International*',
    '✓ Phone: *0806 256 2752*',
    '✓ Business card: *attached*',
    '✓ Store: *Kano office* _(provisional)_',
    '',
    '*Confirm and submit for admin approval?*',
  ].join('\n'));
  assert.deepEqual(kbOf(card), ['✅ Submit for Approval|acconf:1', '❌ Cancel|accanc:0', '⬅️ Back|acb:card']);
});

test('Submit raises the SAME add_contact request, marked prospect, with the card as evidence', async () => {
  const bot = createFakeBot();
  await walk(bot, BALA);
  await controller.handleCallbackQuery(bot, cq(BALA, 'acconf:1'));
  const rows = await pending();
  assert.equal(rows.length, 1);
  const aj = rows[0].actionJSON;
  assert.deepEqual(aj, {
    action: 'add_contact', type: 'customer', name: 'Amib International', phone: '0806 256 2752', address: '', notes: '',
    category: 'Retail', credit_limit: 0, payment_terms: 'COD', stores: ['Kano office'],
    prospect: true, card_file_id: 'CARD-PHOTO', card_file_type: 'photo',
  });
  assert.equal(String(rows[0].user), BALA);
  assert.equal(sessionStore.get(BALA), null, 'the door is closed');
  assert.match(textOf(lastTo(bot, BALA)), /🆕 \*Add prospect — submitted\*/);

  // every admin gets the request card AND the business card under it
  const ref = approvalCards.shortRequestRef(rows[0].requestId);
  for (const admin of ['777', '888']) {
    const dm = to(bot, admin).map(textOf).join('\n');
    assert.match(dm, /Amib International/);
    assert.match(dm, /Prospect · no sale yet/);
    const files = filesTo(bot, admin);
    assert.equal(files.length, 1, `admin ${admin} got the card`);
    assert.equal(files[0].method, 'sendPhoto');
    assert.equal(files[0].args.photo, 'CARD-PHOTO');
    assert.equal(files[0].args.opts.caption, `📇 Business card · Amib International · request ${ref}`);
  }
  // no Customers row before an admin approves
  assert.equal(await customersRepository.findByName('Amib International'), null);
});

test('the approval card and the inbox name the prospect and carry the card', async () => {
  const aj = { action: 'add_contact', type: 'customer', name: 'Amib International', phone: '0806', prospect: true, card_file_id: 'F1', card_file_type: 'photo', stores: ['Kano office'] };
  const card = approvalCards.buildAddContactCard(aj);
  assert.match(card, /\n🆕 Prospect · no sale yet · 📇 business card attached\n/);
  assert.match(approvalCards.buildAddContactCard({ ...aj, card_file_id: undefined }), /\n🆕 Prospect · no sale yet\n/);
  assert.ok(!/Prospect/.test(approvalCards.buildAddContactCard({ action: 'add_contact', type: 'customer', name: 'X' })), 'the full form is unchanged');
});

test('an image sent as a File is the card too, and is forwarded as a document', async () => {
  const bot = createFakeBot();
  await walk(bot, BALA, { card: 'file' });
  assert.deepEqual(sessionStore.get(BALA).card, { fileId: 'CARD-FILE', kind: 'document' });
  await controller.handleCallbackQuery(bot, cq(BALA, 'acconf:1'));
  const aj = (await pending())[0].actionJSON;
  assert.deepEqual([aj.card_file_id, aj.card_file_type], ['CARD-FILE', 'document']);
  const files = filesTo(bot, '777');
  assert.deepEqual([files.length, files[0].method, files[0].args.doc], [1, 'sendDocument', 'CARD-FILE']);
});

test('a PDF is not a business card: the step stays, and says what to send', async () => {
  const bot = createFakeBot();
  await walk(bot, BALA, { card: 'none' });
  const pdf = { message_id: 8, from: { id: Number(BALA) }, chat: { id: Number(BALA), type: 'private' }, document: { file_id: 'PDF1', mime_type: 'application/pdf', file_name: 'card.pdf' } };
  await controller.handleFileMessage(bot, pdf);
  const s = sessionStore.get(BALA);
  assert.deepEqual([s.step, s.card], ['card', undefined]);
  assert.equal(textOf(lastTo(bot, BALA)), '📇 The business card must be a photo. Send it as a picture, or tap ⏭ Skip card.');
});

test('Skip card with a phone number: no card on the request, nothing forwarded', async () => {
  const bot = createFakeBot();
  await walk(bot, BALA, { card: 'skip' });
  assert.match(textOf(lastTo(bot, BALA)), /✓ Business card: _none_\n✓ Store: \*Kano office\*/);
  await controller.handleCallbackQuery(bot, cq(BALA, 'acconf:1'));
  const aj = (await pending())[0].actionJSON;
  assert.equal(aj.prospect, true);
  assert.ok(!('card_file_id' in aj) && !('card_file_type' in aj));
  assert.equal(filesTo(bot, '777').length, 0);
});

/* ── a prospect must be reachable ────────────────────────────────────── */

test('no phone number: the card is needed — no Skip chip, a crafted skip is refused, words are not a card', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(BALA, 'act:add_prospect'));
  await controller.handleMessage(bot, msg(BALA, 'Amib International'));
  await controller.handleCallbackQuery(bot, cq(BALA, 'acskip:phone'));
  let card = lastTo(bot, BALA);
  assert.match(textOf(card), /✓ Phone: _skipped_/);
  assert.match(textOf(card), /No phone number was given, so the card is needed\. Tap Back to enter the phone instead\./);
  assert.deepEqual(kbOf(card), ['⬅️ Back|acb:phone', '❌ Cancel|accanc:0'], 'no Skip chip');

  await controller.handleCallbackQuery(bot, cq(BALA, 'acskip:card'));
  card = lastTo(bot, BALA);
  assert.equal(sessionStore.get(BALA).step, 'card');
  assert.match(textOf(card), /⚠️ A prospect needs a phone number or a business card\./);

  await controller.handleMessage(bot, msg(BALA, 'no card with me'));
  assert.equal(textOf(lastTo(bot, BALA)), '📇 Send the business card as a photo, or tap ⬅️ Back to enter the phone number.');
  assert.equal(sessionStore.get(BALA).step, 'card');
  assert.equal((await pending()).length, 0);

  // the card alone is enough
  await controller.handleFileMessage(bot, photo(BALA));
  assert.equal(sessionStore.get(BALA).step, 'confirm');
});

/* ── the door's own protections still stand ──────────────────────────── */

test('a name already on the customer list is refused at the name step', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(BALA, 'act:add_prospect'));
  await controller.handleMessage(bot, msg(BALA, 'abba'));
  assert.equal(sessionStore.get(BALA).step, 'name', 'still at the name');
  assert.match(textOf(lastTo(bot, BALA)), /already/i);
});

test('creation frozen in Settings: the tile opens nothing', async () => {
  settings = { CUSTOMER_CREATION_ENABLED: 0 };
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(BALA, 'act:add_prospect'));
  assert.equal(sessionStore.get(BALA), null);
  assert.match(textOf(lastTo(bot, BALA)), /Adding customers is paused for now/);
});

/* ── back and the store step ─────────────────────────────────────────── */

test('Back walks the short path: confirm → card → phone → name, dropping what came after', async () => {
  const bot = createFakeBot();
  await walk(bot, BALA);
  await controller.handleCallbackQuery(bot, cq(BALA, 'acb:card'));
  let s = sessionStore.get(BALA);
  assert.deepEqual([s.step, s.card, s.stores, s.phone], ['card', undefined, undefined, '0806 256 2752']);
  await controller.handleCallbackQuery(bot, cq(BALA, 'acb:phone'));
  s = sessionStore.get(BALA);
  assert.deepEqual([s.step, s.phone, s.name], ['phone', undefined, 'Amib International']);
  await controller.handleCallbackQuery(bot, cq(BALA, 'acb:name'));
  s = sessionStore.get(BALA);
  assert.deepEqual([s.step, s.name, s.prospect, s.personType], ['name', undefined, true, 'customer']);
  // a stale Back-to-kind button cannot turn a prospect into another kind
  await controller.handleCallbackQuery(bot, cq(BALA, 'acb:type'));
  s = sessionStore.get(BALA);
  assert.deepEqual([s.step, s.prospect, s.personType], ['name', true, 'customer']);
  assert.deepEqual(kbOf(lastTo(bot, BALA)), ['❌ Cancel|accanc:0']);
});

test('several stores: the store is asked after the card, Back returns to the card', async () => {
  const bot = createFakeBot();
  await walk(bot, SANI);
  let card = lastTo(bot, SANI);
  assert.equal(sessionStore.get(SANI).step, 'store');
  assert.match(textOf(card), /Which store does this customer belong to\?/);
  assert.deepEqual(kbOf(card), ['🏙 Lagos|acst:0', '🏙 IDUMOTA|acst:1', '❔ Place later|acst:__later__', '⬅️ Back|acb:card', '❌ Cancel|accanc:0']);
  await controller.handleCallbackQuery(bot, cq(SANI, 'acst:1'));
  card = lastTo(bot, SANI);
  assert.match(textOf(card), /✓ Store: \*IDUMOTA\* _\(provisional\)_/);
  await controller.handleCallbackQuery(bot, cq(SANI, 'acconf:1'));
  assert.deepEqual((await pending())[0].actionJSON.stores, ['IDUMOTA']);
});

test('Cancel closes the door and raises nothing', async () => {
  const bot = createFakeBot();
  await walk(bot, BALA);
  await controller.handleCallbackQuery(bot, cq(BALA, 'accanc:0'));
  assert.equal(sessionStore.get(BALA), null);
  assert.equal((await pending()).length, 0);
});

/* ── after approval: a 🆕 customer, and the card kept ─────────────────── */

async function approved(bot) {
  await walk(bot, BALA);
  await controller.handleCallbackQuery(bot, cq(BALA, 'acconf:1'));
  const row = (await pending())[0];
  await controller.handleCallbackQuery(bot, cq(ADMIN, `ctg:${row.requestId}:c`));
  customersRepository.invalidateCache && customersRepository.invalidateCache();
  return row;
}

test('approved as Customer: a 🆕 customer in the adder\'s store, with its network node', async () => {
  const bot = createFakeBot();
  await approved(bot);
  const c = await customersRepository.findByName('Amib International');
  assert.ok(c, 'the customer exists');
  assert.deepEqual(c.stores, ['Kano office']);
  assert.ok(!c.first_sale_at, 'no first sale: a prospect');
  assert.equal(c.phone, '+2348062562752', 'the executor stores the number in international form');
  const nodes = (await contactsRepository.getAll()).filter((n) => n.name === 'Amib International');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].customer_id, c.customer_id);
});

test('the customer card names who added them and offers 📇 Business card; the tap shows it, ✖ Close takes it down', async () => {
  const bot = createFakeBot();
  await approved(bot);
  const view = createFakeBot();
  await controller.handleCallbackQuery(view, cq(ADMIN, 'cd:c:Amib International'));
  const card = lastTo(view, ADMIN);
  assert.match(textOf(card), /🏙 Kano office · provisional — added by Bala/);
  assert.ok(kbOf(card).includes('📇 Business card|cd:bc:Amib International'), kbOf(card).join(' · '));

  await controller.handleCallbackQuery(view, cq(ADMIN, 'cd:bc:Amib International'));
  const files = filesTo(view, ADMIN);
  assert.equal(files.length, 1);
  assert.deepEqual([files[0].method, files[0].args.photo], ['sendPhoto', 'CARD-PHOTO']);
  assert.match(files[0].args.opts.caption, /^📇 Business card · Amib International · added /);
  assert.deepEqual(files[0].args.opts.reply_markup.inline_keyboard.flat().map((b) => `${b.text}|${b.callback_data}`), ['✖ Close|cd:bcx']);

  await controller.handleCallbackQuery(view, cq(ADMIN, 'cd:bcx', 901));
  const del = view.calls.filter((c) => c.method === 'deleteMessage').at(-1);
  assert.equal(del.args.messageId, 901);
});

test('the business card is region-scoped like the customer; a customer with no card has no chip', async () => {
  const bot = createFakeBot();
  await approved(bot);
  // Kafaya's stores are in Lagos; the prospect sits in Kano
  const other = createFakeBot();
  await controller.handleCallbackQuery(other, cq(KAFAYA, 'cd:bc:Amib International'));
  assert.equal(filesTo(other, KAFAYA).length, 0);
  assert.equal(textOf(lastTo(other, KAFAYA)), 'That customer is not in your region.');
  // a buyer added long ago: no chip, and a crafted tap finds nothing
  const view = createFakeBot();
  await controller.handleCallbackQuery(view, cq(ADMIN, 'cd:c:ABBA'));
  assert.ok(!kbOf(lastTo(view, ADMIN)).some((b) => b.includes('cd:bc:')));
  await controller.handleCallbackQuery(view, cq(ADMIN, 'cd:bc:ABBA'));
  assert.equal(textOf(lastTo(view, ADMIN)), 'No business card is kept for ABBA.');
});

/* ── the full door is untouched ──────────────────────────────────────── */

test('➕ Add Contact still asks the kind, then the address after the phone', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq(ADMIN, 'act:add_customer'));
  assert.match(textOf(lastTo(bot, ADMIN)), /Who are you adding\?/);
  await controller.handleCallbackQuery(bot, cq(ADMIN, 'actype:customer'));
  await controller.handleMessage(bot, msg(ADMIN, 'Mariam Salisu'));
  await controller.handleMessage(bot, msg(ADMIN, '0803 555 7777'));
  const s = sessionStore.get(ADMIN);
  assert.deepEqual([s.step, s.prospect], ['address', undefined]);
  assert.match(textOf(lastTo(bot, ADMIN)), /^➕ \*Add contact\*\n✓ Type: \*🛒 Customer\*\n/);
});
