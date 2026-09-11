'use strict';

/**
 * SRF-SP2 (owner, 11-Sep-2026) — the Order flow's "Who sold it?" picker
 * carries the same chip set as every sale door: "🙋 Me · name" first when
 * the submitter is an admin or in Sales, then "👤 Customer direct" for the
 * order with no seller, then the Sales/admin list without repeating the
 * submitter. Rule 9b: the seller is picked, never assumed.
 *
 * Stored shape: a picked user keeps {salesperson_id, salesperson_name} as
 * before; Customer direct stores the exact NAME with the SUBMITTER's id —
 * the whole order lifecycle (Accept card, oacc:, odel:, delivery picker,
 * reminder) is keyed on salesperson_id, so the one who raised it fulfils
 * it; an admin without a Users row taps os:__me__ and gets their own id
 * with their Telegram name.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts, lastKb } = require('../helpers/charFixture');

const USERS_HEADER = ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs'];
const USERS = [
  USERS_HEADER,
  ['777', 'Boss', 'admin', '', '', 'active', '', 'Management', '', '', ''],
  ['901', 'Abdul', 'employee', '', '', 'active', '', 'Sales', '', '', ''],
  ['902', 'Kabir', 'employee', '', '', 'active', '', 'Sales', '', '', ''],
  ['903', 'Store guy', 'employee', '', '', 'active', '', 'Warehouse', '', '', ''],
  ['4242', 'Sani', 'employee', '', '', 'active', '', 'Warehouse', '', '', ''],
];

const ORDERS_HEADER = [
  'order_id', 'design', 'shade', 'customer', 'quantity',
  'salesperson_id', 'salesperson_name', 'payment_status', 'scheduled_date',
  'status', 'created_by', 'created_at', 'accepted_at', 'delivered_at', 'reminder_sent',
];
const freshSheets = (users = USERS) => createFakeSheets({ Users: users, Orders: [ORDERS_HEADER] });

let sheets = freshSheets();
const restoreSheets = installFakeSheets(sheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));

function seedAtQuantity(uid) {
  sessionStore.set(uid, { type: 'order_flow', step: 'quantity', createdBy: uid, design: '202/201', shade: '1', customer: 'Chima', customerId: 'C-1' });
}
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).at(-1).args.text;

test('admin submitter: Me first, Customer direct second, the Sales list without the submitter, header "Who sold it?"', async () => {
  usersRepository.invalidateCache();
  seedAtQuantity('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('oq:2', '777'));
  assert.equal(sessionStore.get('777').step, 'salesperson');
  assert.equal(lastText(bot), '🧑 *Who sold it?*');
  const k = kbTexts(bot);
  assert.deepEqual(k.slice(0, 4), [
    '🙋 Me · Boss|os:777',
    '👤 Customer direct|os:__direct__',
    '🧑 Abdul|os:901',
    '🧑 Kabir|os:902',
  ], `chip order: ${k}`);
  assert.equal(k.filter((t) => /Boss/.test(t)).length, 1, 'the submitter appears once — as Me, never again in the list');
  assert.ok(!k.some((t) => /Store guy|Sani/.test(t)), 'non-Sales, non-admin users are not sellers');
  assert.ok(k.includes('⬅️ Back|obb:quantity') && k.includes('❌ Cancel|ocanc:1'), 'nav row kept');
  assert.ok(lastKb(bot).every((b) => Buffer.byteLength(b.callback_data) <= 64));
  sessionStore.clear('777');
});

test('tapping Customer direct stores exactly "Customer direct" owned by the submitter and advances to payment', async () => {
  usersRepository.invalidateCache();
  seedAtQuantity('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('oq:2', '777'));
  await controller.handleCallbackQuery(bot, cb('os:__direct__', '777'));
  const s = sessionStore.get('777');
  assert.equal(s.salesperson_name, 'Customer direct');
  assert.equal(s.salesperson_id, '777', 'the submitter owns the lifecycle — a blank id would leave the order unacceptable forever');
  assert.equal(s.step, 'payment');
  assert.match(lastText(bot), /Salesperson: \*Customer direct\*/);
  assert.ok(kbTexts(bot).includes('💰 PAID|op:PAID'), 'the payment card follows as before');
  sessionStore.clear('777');
});

test('a non-seller submitter who taps Customer direct still owns the order (their own id, the exact name)', async () => {
  usersRepository.invalidateCache();
  seedAtQuantity('4242');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('oq:1', '4242'));
  await controller.handleCallbackQuery(bot, cb('os:__direct__', '4242'));
  const s = sessionStore.get('4242');
  assert.deepEqual([s.salesperson_id, s.salesperson_name, s.step], ['4242', 'Customer direct', 'payment']);
  sessionStore.clear('4242');
});

test('a Customer direct order completes its lifecycle: row keyed to the submitter, Accept card in their chat, oacc: by them accepts, nobody else can', async () => {
  usersRepository.invalidateCache();
  seedAtQuantity('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('oq:2', '777'));
  await controller.handleCallbackQuery(bot, cb('os:__direct__', '777'));
  // The payment and date steps are untouched by this item; fill them the way
  // op:/odate: do and confirm.
  const s = sessionStore.get('777');
  s.payment_status = 'PAID';
  s.scheduled_date = '2026-09-15';
  s.step = 'confirm';
  sessionStore.set('777', s);
  await controller.handleCallbackQuery(bot, cb('oconf:1', '777'));

  const rows = sheets._store.get('Orders').slice(1);
  assert.equal(rows.length, 1, 'one order row appended');
  const row = rows[0];
  const orderId = row[0];
  assert.match(orderId, /^ORD-/);
  assert.deepEqual(row.slice(5, 7), ['777', 'Customer direct'], 'salesperson_id = submitter, salesperson_name exact');
  assert.equal(row[9], 'pending_accept');
  assert.equal(row[10], '777', 'created_by');
  assert.ok(!sessionStore.get('777'), 'session cleared after confirm');

  assert.match(bot.allText(), new RegExp(`✅ Order \\*${orderId}\\* created and sent to Customer direct for acceptance\\.`));
  const acceptCard = bot.callsTo('sendMessage').find((c) => /New Supply Order Assigned/.test(c.args.text));
  assert.ok(acceptCard, 'the Accept card is sent');
  assert.equal(String(acceptCard.args.chatId), '777', 'it lands in the submitter\'s own chat, not on an empty chat id');
  assert.deepEqual(acceptCard.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), [`oacc:${orderId}`]);
  assert.doesNotMatch(bot.allText(), /Could not notify/, 'no failed-DM warning');

  // Someone else cannot accept it.
  const other = createFakeBot();
  await controller.handleCallbackQuery(other, cb(`oacc:${orderId}`, '901'));
  assert.equal(other.callsTo('answerCallbackQuery')[0].args.opts.text, 'This order is not assigned to you.');
  assert.equal(sheets._store.get('Orders')[1][9], 'pending_accept');

  // The submitter accepts it — the order is no longer stuck.
  const mine = createFakeBot();
  await controller.handleCallbackQuery(mine, cb(`oacc:${orderId}`, '777'));
  assert.equal(sheets._store.get('Orders')[1][9], 'accepted');
  assert.ok(sheets._store.get('Orders')[1][12], 'accepted_at stamped');
  assert.match(mine.allText(), new RegExp(`✅ You accepted order \\*${orderId}\\*`));
});

test('tapping Me (a submitter WITH a Users row) keeps the picked-user shape: id + sheet name', async () => {
  usersRepository.invalidateCache();
  seedAtQuantity('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('oq:2', '777'));
  await controller.handleCallbackQuery(bot, cb('os:777', '777'));
  const s = sessionStore.get('777');
  assert.deepEqual([s.salesperson_id, s.salesperson_name, s.step], ['777', 'Boss', 'payment']);
  sessionStore.clear('777');
});

test('a picked Sales user still stores id + name exactly as before', async () => {
  usersRepository.invalidateCache();
  seedAtQuantity('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('oq:2', '777'));
  await controller.handleCallbackQuery(bot, cb('os:902', '777'));
  const s = sessionStore.get('777');
  assert.deepEqual([s.salesperson_id, s.salesperson_name, s.step], ['902', 'Kabir', 'payment']);
  sessionStore.clear('777');
});

test('a submitter who is neither admin nor Sales gets no Me chip: Customer direct leads, the list is whole', async () => {
  usersRepository.invalidateCache();
  seedAtQuantity('4242');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('oq:1', '4242'));
  const k = kbTexts(bot);
  assert.equal(k[0], '👤 Customer direct|os:__direct__');
  assert.ok(!k.some((t) => t.startsWith('🙋')), 'no Me chip for a non-seller');
  assert.deepEqual(k.slice(1, 4), ['🧑 Boss|os:777', '🧑 Abdul|os:901', '🧑 Kabir|os:902']);
  assert.ok(!k.some((t) => /Sani/.test(t)), 'the submitter is not offered as a seller');
  sessionStore.clear('4242');
});

test('an admin WITHOUT a Users row: "🙋 Me" via os:__me__ resolves to their own id and Telegram name', async () => {
  // Swap the Users sheet for one that does not know 777 at all.
  const restoreNoRow = installFakeSheets(freshSheets(USERS.filter((r) => r[0] !== '777')));
  usersRepository.invalidateCache();
  try {
    seedAtQuantity('777');
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('oq:2', '777'));
    const k = kbTexts(bot);
    assert.deepEqual(k.slice(0, 3), ['🙋 Me|os:__me__', '👤 Customer direct|os:__direct__', '🧑 Abdul|os:901'], `chip order: ${k}`);
    const meTap = { id: 'cb', data: 'os:__me__', from: { id: '777', first_name: 'Musa' }, message: { chat: { id: '777' }, message_id: 5 } };
    await controller.handleCallbackQuery(bot, meTap);
    const s = sessionStore.get('777');
    assert.deepEqual([s.salesperson_id, s.salesperson_name, s.step], ['777', 'Musa', 'payment']);
    assert.match(lastText(bot), /Salesperson: \*Musa\*/);
  } finally {
    restoreNoRow();
    sheets = freshSheets();
    installFakeSheets(sheets);
    usersRepository.invalidateCache();
    sessionStore.clear('777');
  }
});

test('nobody to pick and the submitter cannot sell: the old "No salespersons found" bail is unchanged', async () => {
  const restoreEmpty = installFakeSheets(freshSheets([USERS_HEADER, ['4242', 'Sani', 'employee', '', '', 'active', '', 'Warehouse', '', '', '']]));
  usersRepository.invalidateCache();
  try {
    seedAtQuantity('4242');
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('oq:1', '4242'));
    assert.match(bot.allText(), /No salespersons found/);
    assert.ok(!sessionStore.get('4242'), 'session cleared as before');
  } finally {
    restoreEmpty();
    sheets = freshSheets();
    installFakeSheets(sheets);
    usersRepository.invalidateCache();
  }
});

test.after(() => restoreSheets());
