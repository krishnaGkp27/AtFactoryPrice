'use strict';

/**
 * CON-2 (owner's go, 19-Nov-2026) — ONE door for every customer entry,
 * through the REAL controller, the real approval pipeline and the real
 * `add_contact` executor on fake sheets.
 *
 * Samples, Orders and the receipt upload each had a private "➕ New
 * customer" form and a private request (`new_customer`). Each button now
 * opens the ➕ Add Contact door with the kind set and the live flow held:
 *
 *   · the door shows what is on hold; ⬅️ Back and ❌ Cancel return to the
 *     flow's own customer picker with nothing lost;
 *   · the name is checked at the name step (already a customer → refused);
 *   · Submit raises the SAME `add_contact` request every entry raises, with
 *     `resume: { flow }`, writes NO Customers row, and leaves the flow
 *     waiting on that request;
 *   · approved as customer → the Customers row and the network node are
 *     written by the usual executor and the flow continues;
 *   · routed to 📒 Contact, or rejected → the flow returns to its picker.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const fake = createFakeSheets({
  // the bootstrap writes this header in production; the reader skips row 1
  Contacts: [['contact_id', 'name', 'phone', 'type', 'address', 'notes', 'created_at', 'whatsapp', 'customer_id', 'status', 'updated_by', 'updated_at']],
});
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const contactsRepository = require(path.join(SRC, 'repositories/contactsRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalGate = require(path.join(SRC, 'services/approvalGate'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));

let settings = {};
settingsRepository.getAll = async () => ({ ...settingsRepository.DEFAULTS, ...settings });
auditLogRepository.append = async () => {};

const EMP = '4242';
const ADMIN = '777';
const cq = (uid, data) => ({ id: `cq-${data}`, data, from: { id: Number(uid) }, message: { chat: { id: Number(uid) }, message_id: 77 } });
const msg = (uid, text) => ({ message_id: 5, text, from: { id: Number(uid) }, chat: { id: Number(uid), type: 'private' } });
const to = (bot, uid) => bot.calls.filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText')
  && String(c.args.chatId ?? (c.args.opts && c.args.opts.chat_id)) === String(uid));
const lastTo = (bot, uid) => to(bot, uid).at(-1);
const textOf = (c) => String((c && c.args.text) || '');
const kbOf = (c) => (((c && c.args.opts && c.args.opts.reply_markup) || {}).inline_keyboard || []).flat().map((b) => `${b.text}|${b.callback_data}`);
const pending = async () => (await approvalQueueRepository.getAllPending()).filter((r) => r.actionJSON && r.actionJSON.action === 'add_contact');

const SEEDS = {
  sample_flow: { type: 'sample_flow', step: 'customer', design: '9006', shade: '3' },
  order_flow: { type: 'order_flow', step: 'customer', design: '9006', shade: '' },
  receipt_flow: { type: 'receipt_flow', step: 'customer', createdBy: EMP },
};
const BUTTON = { sample_flow: 'smcu:__new__', order_flow: 'oc:__new__', receipt_flow: 'rcc:__new__' };

/** A session without the store's own bookkeeping and the card anchor. */
function core(session) {
  if (!session) return session;
  const { _setAt, expiresAt, flowMessageId, ...rest } = session; // eslint-disable-line no-unused-vars
  return rest;
}

function reset() {
  // keep each sheet's header row: the repositories write a header once per process
  for (const [name, rows] of [...fake._store.entries()]) fake._store.set(name, rows.slice(0, 1));
  settings = {};
  [EMP, ADMIN, '888'].forEach((u) => sessionStore.clear(u));
  approvalGate._internals.recent.clear();
  if (typeof customersRepository.invalidateCache === 'function') customersRepository.invalidateCache();
}

/** Open the door from a flow, type the name, fill the rest, submit. Returns the request row. */
async function raiseFrom(bot, flow, name = 'Mariam Salisu') {
  sessionStore.set(EMP, { ...SEEDS[flow] });
  await controller.handleCallbackQuery(bot, cq(EMP, BUTTON[flow]));
  await controller.handleMessage(bot, msg(EMP, name));
  const door = sessionStore.get(EMP);
  Object.assign(door, { phone: '0803 555 7777', address: 'Kano', category: 'Retail', credit_limit: 0, payment_terms: 'COD', notes: '', step: 'confirm' });
  sessionStore.set(EMP, door);
  await controller.handleCallbackQuery(bot, cq(EMP, 'acconf:1'));
  const rows = await pending();
  return rows.at(-1);
}

test.beforeEach(reset);

/* ── the door, opened from a flow ────────────────────────────────────── */

test('each button opens the one door with the kind set, the flow held, and says what is on hold', async () => {
  const want = {
    sample_flow: ['🧪 Your sample request is on hold until this customer is approved.', '⬅️ Back to sample|acb:held'],
    order_flow: ['📋 Your order is on hold until this customer is approved.', '⬅️ Back to order|acb:held'],
    receipt_flow: ['🧾 Your receipt upload is on hold until this customer is approved.', '⬅️ Back to receipt|acb:held'],
  };
  for (const flow of Object.keys(SEEDS)) {
    reset();
    const bot = createFakeBot();
    sessionStore.set(EMP, { ...SEEDS[flow] });
    await controller.handleCallbackQuery(bot, cq(EMP, BUTTON[flow]));
    const s = sessionStore.get(EMP);
    assert.deepEqual([s.type, s.step, s.personType, s.held.flow], ['add_customer_flow', 'name', 'customer', flow], flow);
    assert.deepEqual(core(s.held.session), SEEDS[flow], 'the flow is kept whole inside the door');
    const card = lastTo(bot, EMP);
    assert.equal(textOf(card), `➕ *Add contact*\n✓ Type: *🛒 Customer*\n${want[flow][0]}\n\nEnter the *full name* (reply in chat):`, flow);
    assert.deepEqual(kbOf(card), [want[flow][1], '❌ Cancel|accanc:0'], `${flow}: no kind step to go back to, no Quick Add`);
  }
});

test('⬅️ Back and ❌ Cancel return to the flow\'s own customer picker, nothing lost', async () => {
  for (const [flow, exit] of [['sample_flow', 'acb:held'], ['order_flow', 'accanc:0'], ['receipt_flow', 'acb:held'], ['sample_flow', 'accanc:0']]) {
    reset();
    const bot = createFakeBot();
    sessionStore.set(EMP, { ...SEEDS[flow] });
    await controller.handleCallbackQuery(bot, cq(EMP, BUTTON[flow]));
    await controller.handleCallbackQuery(bot, cq(EMP, exit));
    assert.deepEqual(core(sessionStore.get(EMP)), SEEDS[flow], `${flow} via ${exit}: the flow is live again, exactly as it was`);
    const kb = kbOf(lastTo(bot, EMP));
    assert.ok(kb.some((b) => b.endsWith(`|${BUTTON[flow]}`)), `${flow}: its picker is on screen again`);
    assert.equal((await pending()).length, 0);
  }
});

test('typed "cancel" inside a held door also returns to the flow', async () => {
  const bot = createFakeBot();
  sessionStore.set(EMP, { ...SEEDS.sample_flow });
  await controller.handleCallbackQuery(bot, cq(EMP, 'smcu:__new__'));
  await controller.handleMessage(bot, msg(EMP, 'cancel'));
  assert.deepEqual(core(sessionStore.get(EMP)), SEEDS.sample_flow);
});

test('the name is checked at the name step: a name that is already a customer is refused there', async () => {
  fake._store.set('Customers', [
    ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases'],
    ['CUST-1', 'ABBA', '0801', '', 'Retail', '0', '0', 'COD', '', 'Active', '', '', ''],
  ]);
  const bot = createFakeBot();
  sessionStore.set(EMP, { ...SEEDS.order_flow });
  await controller.handleCallbackQuery(bot, cq(EMP, 'oc:__new__'));
  await controller.handleMessage(bot, msg(EMP, 'abba'));
  assert.match(textOf(lastTo(bot, EMP)), /\*abba\* already exists \(as \*ABBA\*\) — CUST-1/);
  assert.equal(sessionStore.get(EMP).step, 'name', 'still at the name step');
  assert.equal(sessionStore.get(EMP).name, undefined);

  await controller.handleMessage(bot, msg(EMP, 'Mariam Salisu'));
  assert.equal(sessionStore.get(EMP).step, 'phone');
});

test('the CRM door checks a customer name at the name step too', async () => {
  fake._store.set('Customers', [
    ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases'],
    ['CUST-1', 'ABBA', '0801', '', 'Retail', '0', '0', 'COD', '', 'Active', '', '', ''],
  ]);
  const bot = createFakeBot();
  sessionStore.set(EMP, { type: 'add_customer_flow', step: 'name', requestedBy: EMP, flowMessageId: null, personType: 'customer' });
  await controller.handleMessage(bot, msg(EMP, 'ABBA'));
  assert.equal(sessionStore.get(EMP).step, 'name');
  // a worker of the same name is not a customer: no check
  sessionStore.set(EMP, { type: 'add_customer_flow', step: 'name', requestedBy: EMP, flowMessageId: null, personType: 'worker' });
  await controller.handleMessage(bot, msg(EMP, 'ABBA'));
  assert.equal(sessionStore.get(EMP).step, 'phone');
});

test('with customer creation frozen the button says so and the flow stays at its picker', async () => {
  settings = { CUSTOMER_CREATION_ENABLED: 0 };
  const bot = createFakeBot();
  sessionStore.set(EMP, { ...SEEDS.sample_flow });
  await controller.handleCallbackQuery(bot, cq(EMP, 'smcu:__new__'));
  assert.deepEqual(core(sessionStore.get(EMP)), SEEDS.sample_flow);
  assert.ok(to(bot, EMP).some((c) => /🔒 Adding customers is paused for now/.test(textOf(c))));
});

/* ── submit ──────────────────────────────────────────────────────────── */

test('Submit raises ONE add_contact with the resume mark, writes no customer, and leaves the flow waiting', async () => {
  const bot = createFakeBot();
  const row = await raiseFrom(bot, 'sample_flow');
  assert.equal((await pending()).length, 1);
  const aj = row.actionJSON;
  assert.deepEqual([aj.action, aj.type, aj.name, aj.phone, aj.address, aj.category, aj.payment_terms, aj.resume],
    ['add_contact', 'customer', 'Mariam Salisu', '0803 555 7777', 'Kano', 'Retail', 'COD', { flow: 'sample_flow' }]);
  assert.ok(!(fake._store.get('Customers') || []).some((r) => r[1] === 'Mariam Salisu'), 'no Pending row before approval');

  const s = sessionStore.get(EMP);
  assert.deepEqual([s.type, s.step, s.design, s.pendingCustomerName, s.customerApprovalId],
    ['sample_flow', 'awaiting_customer_approval', '9006', 'Mariam Salisu', row.requestId]);
  assert.equal(textOf(lastTo(bot, EMP)),
    '⏳ Customer "Mariam Salisu" sent for admin approval.\nYour sample request is paused. It resumes automatically once an admin approves the new customer.');

  // the admins' card says where it came from — on the DM and on every rebuild
  assert.ok(to(bot, ADMIN).some((c) => /🧪 Raised from a sample request · on hold until approved/.test(textOf(c))));
  assert.match(await approvalCards.buildCardFromActionJSON(aj), /\n🧪 Raised from a sample request · on hold until approved/);
});

test('an entry from the CRM tile carries no resume mark and no hold line', async () => {
  const bot = createFakeBot();
  sessionStore.set(EMP, { type: 'add_customer_flow', step: 'confirm', requestedBy: EMP, flowMessageId: null, personType: 'customer', name: 'Plain Entry', phone: '0801' });
  await controller.handleCallbackQuery(bot, cq(EMP, 'acconf:1'));
  const row = (await pending()).at(-1);
  assert.equal(row.actionJSON.resume, undefined);
  assert.ok(!/on hold until approved/.test(await approvalCards.buildCardFromActionJSON(row.actionJSON)));
  assert.ok(!sessionStore.get(EMP), 'the door simply closes');
});

/* ── the decision ────────────────────────────────────────────────────── */

test('approved as 🛒 Customer: the customer AND its network node are written, and each flow continues', async () => {
  const next = {
    sample_flow: ['quantity', /✅ Customer "Mariam Salisu" approved\.\nContinuing your sample request\./],
    order_flow: ['quantity', /✅ Customer "Mariam Salisu" approved\. Continuing your order\.\n\nPick quantity:/],
    receipt_flow: ['amount', /✅ Customer "Mariam Salisu" approved\. Continuing your receipt upload\.\n\nEnter the payment amount received \(NGN\):/],
  };
  for (const flow of Object.keys(SEEDS)) {
    reset();
    const bot = createFakeBot();
    const row = await raiseFrom(bot, flow);
    await controller.handleCallbackQuery(bot, cq(ADMIN, `ctg:${row.requestId}:c`));

    const cust = (await customersRepository.getAll()).find((c) => c.name === 'Mariam Salisu');
    assert.ok(cust, `${flow}: the Customers row exists`);
    assert.equal(String(cust.status).toLowerCase(), 'active', 'written Active, never Pending');
    const node = (await contactsRepository.getAll()).find((c) => c.name === 'Mariam Salisu');
    assert.ok(node && node.customer_id === cust.customer_id, `${flow}: the network node is bound to the customer`);

    const s = sessionStore.get(EMP);
    assert.deepEqual([s.type, s.step, s.customer, s.customerId], [flow, next[flow][0], 'Mariam Salisu', cust.customer_id], flow);
    assert.equal(s.customerApprovalId, undefined);
    assert.ok(to(bot, EMP).some((c) => next[flow][1].test(textOf(c))), `${flow}: told and continued`);
  }
});

test('a plain ✅ Approve honours the requested kind and resumes the same way', async () => {
  const bot = createFakeBot();
  const row = await raiseFrom(bot, 'order_flow');
  await controller.handleCallbackQuery(bot, cq(ADMIN, `approve:${row.requestId}`));
  const s = sessionStore.get(EMP);
  assert.deepEqual([s.type, s.step, s.customer], ['order_flow', 'quantity', 'Mariam Salisu']);
});

test('routed to 📒 Contact: no customer is created; the flow is told and returns to its picker', async () => {
  for (const flow of Object.keys(SEEDS)) {
    reset();
    const bot = createFakeBot();
    const row = await raiseFrom(bot, flow);
    await controller.handleCallbackQuery(bot, cq(ADMIN, `ctg:${row.requestId}:p`));
    assert.ok(!(await customersRepository.getAll()).some((c) => c.name === 'Mariam Salisu'), `${flow}: not a customer`);
    const s = sessionStore.get(EMP);
    assert.deepEqual([s.type, s.step, s.customer], [flow, 'customer', SEEDS[flow].customer], flow);
    assert.ok(to(bot, EMP).some((c) => /ℹ️ "Mariam Salisu" was filed as a contact, not a customer\.\nPick a customer for your /.test(textOf(c))), flow);
    assert.ok(kbOf(lastTo(bot, EMP)).some((b) => b.endsWith(`|${BUTTON[flow]}`)), `${flow}: the picker is back`);
  }
});

test('rejected: nothing is written anywhere; every flow returns to its picker — none is thrown away', async () => {
  for (const flow of Object.keys(SEEDS)) {
    reset();
    const bot = createFakeBot();
    const row = await raiseFrom(bot, flow);
    await controller.handleCallbackQuery(bot, cq(ADMIN, `reject:${row.requestId}`));
    assert.ok(!(fake._store.get('Customers') || []).some((r) => r[1] === 'Mariam Salisu'), `${flow}: no Rejected row left behind`);
    const s = sessionStore.get(EMP);
    assert.deepEqual([s.type, s.step], [flow, 'customer'], `${flow}: still alive, at its picker`);
    assert.equal(s.design, SEEDS[flow].design, 'what was picked before is kept');
    assert.ok(to(bot, EMP).some((c) => /❌ Customer "Mariam Salisu" was not approved\.\nPick a different customer for your /.test(textOf(c))), flow);
  }
});

test('the person moved on before the decision: nothing is resumed and nothing is disturbed', async () => {
  const bot = createFakeBot();
  const row = await raiseFrom(bot, 'sample_flow');
  sessionStore.set(EMP, { type: 'order_flow', step: 'quantity', design: '44200', customer: 'ABBA' });
  await controller.handleCallbackQuery(bot, cq(ADMIN, `ctg:${row.requestId}:c`));
  assert.deepEqual(core(sessionStore.get(EMP)), { type: 'order_flow', step: 'quantity', design: '44200', customer: 'ABBA' });
  assert.ok((await customersRepository.getAll()).some((c) => c.name === 'Mariam Salisu'), 'the customer is still created');
});

test('a flow waiting on a DIFFERENT request is not resumed by this one', async () => {
  const session = { type: 'sample_flow', step: 'awaiting_customer_approval', design: '9006', customerApprovalId: 'OTHER', pendingCustomerName: 'Someone' };
  sessionStore.set(EMP, { ...session });
  const moved = await approvalEvents.resumeHeldFlowAfterContact(createFakeBot(), 'THIS', { name: 'Mariam', resume: { flow: 'sample_flow' } }, EMP, 'customer');
  assert.equal(moved, false);
  assert.deepEqual(core(sessionStore.get(EMP)), session);
  // and a request with no resume mark is never a resume
  assert.equal(await approvalEvents.resumeHeldFlowAfterContact(createFakeBot(), 'OTHER', { name: 'Mariam' }, EMP, 'customer'), false);
});

/* ── what is retired ─────────────────────────────────────────────────── */

test('the private forms and their request are gone from the controller', () => {
  const src = require('fs').readFileSync(path.join(SRC, 'controllers/telegramController.js'), 'utf8');
  for (const gone of ['sample_new_cust_name', 'new_order_customer_name', 'receipt_new_cust_name', "action: 'new_customer'", 'new customer name* (will be sent for 2-admin approval)']) {
    assert.ok(!src.includes(gone), `${gone} is no longer in the controller`);
  }
});
