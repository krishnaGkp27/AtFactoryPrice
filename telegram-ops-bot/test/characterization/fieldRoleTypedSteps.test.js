'use strict';

/**
 * MKT-1 keeps a marketer / salesman view-only: every typed line is ignored.
 * PAY-1 gives them 💳 Payments all the same ("a field-role user can ask to
 * be paid too") — and its steps are TYPED: the account number, the amount,
 * the reason. The view-only guard sat in front of those steps, so a
 * marketer who opened Payments could not finish a request.
 *
 * The guard now hands a typed line to the flow the person opened from one
 * of their own tiles (Payments, 🆕 Add Prospect) and to nothing else.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({
  Users: [['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs'],
    ['4242', 'Bala', 'marketer', '', 'basic', 'active', '', 'Marketing', 'Kano office', '', ''],
  ],
}));
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return { action: 'unknown', confidence: 0 }; });
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
auditLogRepository.append = async () => {};

const BALA = '4242';
const msg = (text) => ({ message_id: 5, text, from: { id: Number(BALA) }, chat: { id: Number(BALA), type: 'private' } });
const texts = (bot) => bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => String(c.args.text || ''));

test.beforeEach(() => { sessionStore.clear(BALA); intentCalls = 0; });

test('a marketer in the payment flow: the typed step reaches the flow', async () => {
  const bot = createFakeBot();
  sessionStore.set(BALA, { type: 'payment_flow', step: 'reg_name', reg: { owner_type: 'contractor' }, req: {} });
  await controller.handleMessage(bot, msg('Sani Loader'));
  const s = sessionStore.get(BALA);
  assert.equal(s.reg.owner_name, 'Sani Loader', 'the flow took the name');
  assert.equal(s.step, 'reg_number');
  assert.ok(!texts(bot).some((t) => /My Collection/.test(t)), 'not answered as an ignored line');
});

test('a marketer with no flow open: a typed line is still ignored (MKT-1)', async () => {
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Sell 1111, 1112 to Abba'));
  assert.ok(texts(bot).some((t) => /Tap \*🧵 My Collection\*/.test(t)));
  assert.equal(sessionStore.get(BALA), null, 'no sale card was opened');
  assert.equal(intentCalls, 0);
});

test('a marketer in the payment flow at a TAP step: words the flow does not take are still ignored', async () => {
  const bot = createFakeBot();
  sessionStore.set(BALA, { type: 'payment_flow', step: 'home', reg: {}, req: {} });
  await controller.handleMessage(bot, msg('Sell 1111, 1112 to Abba'));
  assert.ok(texts(bot).some((t) => /Tap \*🧵 My Collection\*/.test(t)));
  assert.equal(sessionStore.get(BALA).type, 'payment_flow', 'nothing else was opened');
  assert.equal(intentCalls, 0);
});

test('a marketer holding some other session: its typed handler is NOT reached', async () => {
  const bot = createFakeBot();
  // a session a field role cannot open from their own tiles
  sessionStore.set(BALA, { type: 'add_customer_flow', step: 'name', personType: 'customer' });
  await controller.handleMessage(bot, msg('Mariam Salisu'));
  assert.equal(sessionStore.get(BALA).name, undefined, 'the full Add Contact form did not take the name');
  assert.ok(texts(bot).some((t) => /Tap \*🧵 My Collection\*/.test(t)));
});
