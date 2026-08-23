'use strict';

/**
 * MYP-1 §16 — THE FENCE. A linked customer/marketer owns exactly one
 * surface: 📦 My Products. This test drives the REAL controller and pins
 * the boundary from both sides:
 *  - text from a linked person → the My Products chip, never a stranger
 *    capture, never intent parsing;
 *  - their allowed taps work (act:my_products renders the chip list in
 *    the sdg grammar over THEIR purchase history);
 *  - every other callback answers "view-only" and DOES NOTHING;
 *  - a photo from them does nothing;
 *  - isAllowed itself still refuses them — the fence is an explicit
 *    pre-gate, not a hole in the staff allow-set.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return { action: 'unknown', confidence: 0 }; });
const controller = loadController();

const auth = require(path.join(SRC, 'middlewares/auth'));
const pendingUsersRepo = require(path.join(SRC, 'repositories/pendingUsersRepository'));
const pendingUserService = require(path.join(SRC, 'services/pendingUserService'));
const linkedAccessService = require(path.join(SRC, 'services/linkedAccessService'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const allocRepo = require(path.join(SRC, 'repositories/marketerAllocationsRepository'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));

const LINKED = '9001112223';

pendingUsersRepo.getAll = async () => ([
  { telegram_id: LINKED, status: 'linked', link_type: 'marketer', link_id: 'MK-1', link_name: 'Owaibula' },
  { telegram_id: '555', status: 'pending', link_type: '', link_id: '', link_name: '' },
]);
let captured = 0;
pendingUserService.captureStranger = async () => { captured += 1; };

inventoryRepository.getSoldRows = async () => ([
  { packageNo: '601', design: '9037', warehouse: 'Kano office', status: 'sold', soldTo: 'Owaibula', soldDate: '2026-07-10' },
]);
inventoryRepository.getAll = async () => ([
  { packageNo: '601', design: '9037', warehouse: 'Kano office', status: 'sold', soldTo: 'Owaibula', soldDate: '2026-07-10' },
  { packageNo: '701', design: '9037', warehouse: 'Kano office', status: 'available' },
  { packageNo: '702', design: '9037', warehouse: 'Kano office', status: 'available' },
]);
allocRepo.getAll = async () => ([
  { marketer_id: LINKED, design: '9037', shade: '', allocated_qty: 94, notes: '' },
]);
customerEntity.resolve = async () => null;

const msgFrom = (id, text) => ({ chat: { id }, from: { id }, text });

test('linked text → the one chip; no capture, no intent parsing', async () => {
  linkedAccessService.invalidate();
  const bot = createFakeBot();
  captured = 0; intentCalls = 0;
  await controller.handleMessage(bot, msgFrom(LINKED, 'sell bale 100 to somebody'));
  const sent = bot.callsTo('sendMessage');
  assert.equal(sent.length, 1);
  assert.match(sent[0].args.text, /My Products|products/i);
  const kb = sent[0].args.opts.reply_markup.inline_keyboard.flat();
  assert.deepEqual(kb.map((b) => b.callback_data), ['act:my_products']);
  assert.equal(captured, 0, 'a linked person is never re-captured as a stranger');
  assert.equal(intentCalls, 0, 'their words never reach the intent parser');
});

test('act:my_products renders THEIR chips in the sdg grammar; isAllowed still refuses them', async () => {
  linkedAccessService.invalidate();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:my_products', LINKED));
  const out = [...bot.callsTo('sendMessage'), ...bot.callsTo('editMessageText')];
  assert.ok(out.length, 'a card rendered');
  const last = out[out.length - 1];
  const chips = (last.args.opts || last.args).reply_markup.inline_keyboard.flat();
  const chip = chips.find((b) => String(b.callback_data).startsWith('myp:d:'));
  assert.ok(chip, 'a design chip exists');
  // MYP-2 (owner, 23-Aug-2026): the recursive pair — supplied-to-them /
  // ALLOCATED-to-them. Both numbers are theirs; the live stock count (2
  // available in the fixture) must never appear.
  assert.match(chip.text, /^📦 9037 \(1B \/ 94B\)$/, 'supplied / allocated pair');
  assert.ok(!/2B/.test(chip.text), 'the live availability number must not leak');
  assert.equal(auth.isAllowed(LINKED), false, 'the fence is a pre-gate, not an allow-set hole');
});

test('every other callback answers view-only and does nothing', async () => {
  linkedAccessService.invalidate();
  const bot = createFakeBot();
  for (const data of ['approve:REQ-1', 'act:sell_bale', 'tsk:cancel', 'pay:start:req']) {
    await controller.handleCallbackQuery(bot, cb(data, LINKED));
  }
  const alerts = bot.callsTo('answerCallbackQuery').filter((c) => c.args.opts && /view-only/i.test(c.args.opts.text || ''));
  assert.equal(alerts.length, 4, 'all four refused with the view-only toast');
  assert.equal(bot.callsTo('sendMessage').length, 0, 'nothing else rendered, nothing executed');
});

test('a photo from a linked person does nothing but the polite line', async () => {
  linkedAccessService.invalidate();
  const bot = createFakeBot();
  await controller.handleFileMessage(bot, { chat: { id: LINKED }, from: { id: LINKED }, photo: [{ file_id: 'F1' }] });
  const sent = bot.callsTo('sendMessage');
  assert.equal(sent.length, 1);
  assert.match(sent[0].args.text, /view-only/i);
});

test('a genuinely unknown id still goes to the stranger capture, not the fence', async () => {
  linkedAccessService.invalidate();
  const bot = createFakeBot();
  captured = 0;
  await controller.handleMessage(bot, msgFrom('555', 'hello'));
  assert.equal(captured, 1);
});
