'use strict';

/**
 * SRF-PAY (owner, 11-Sep-2026) — the supply request's payment chips are
 * 💵 Cash · ⏳ Not yet paid (credit) · 🏦 <each Settings BANK_LIST bank>.
 * The label says "credit" so the field reads it at a glance; the callback
 * and the session carry the VALUE 'Not yet paid' — the approval wizard's
 * own word — so the requester's choice and the admin's decision are one
 * vocabulary. No chip is labelled or valued 'Credit' any more.
 *
 * Drives the REAL controller: srf_sp: → showSupplyPaymentPicker → srf_pm: →
 * the date step, plus the srf_back:payment fallback.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));

const UID = '4242';
const FLOW_MSG = 50;

let settings = {};
settingsRepository.getAll = async () => ({ ...settingsRepository.DEFAULTS, ...settings });

function seedAtSalesperson() {
  sessionStore.set(UID, {
    type: 'supply_req_flow', warehouse: 'Lagos', productType: 'fabric', step: 'salesperson',
    cart: [{ design: '202/201', shade: '1', quantity: 2 }], customer: 'Chima', flowMessageId: FLOW_MSG,
  });
}
const cards = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
const lastText = (bot) => cards(bot).at(-1).args.text;
const lastRows = (bot) => cards(bot).filter((c) => c.args.opts && c.args.opts.reply_markup).at(-1).args.opts.reply_markup.inline_keyboard;

test.beforeEach(() => {
  settings = { BANK_LIST: 'GTBank,ZENITH BANK' };
  sessionStore.clear(UID);
});

test('picking the salesperson lands on the payment picker: Cash · Not yet paid (credit) · banks, three per row, Back kept', async () => {
  seedAtSalesperson();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sp:Musa'));
  assert.equal(sessionStore.get(UID).step, 'payment');
  assert.match(lastText(bot), /Select payment mode/);
  const rows = lastRows(bot);
  assert.deepEqual(rows.map((r) => r.map((b) => b.text)), [
    ['💵 Cash', '⏳ Not yet paid (credit)', '🏦 GTBank'],
    ['🏦 ZENITH BANK'],
    ['⬅️ Back to salesperson'],
  ]);
  assert.deepEqual(rows.flat().map((b) => b.callback_data), [
    'srf_pm:Cash', 'srf_pm:Not yet paid', 'srf_pm:GTBank', 'srf_pm:ZENITH BANK', 'srf_back:salesperson',
  ]);
  for (const b of rows.flat()) assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${b.callback_data} fits Telegram's 64 bytes`);
  assert.ok(!rows.flat().some((b) => /credit/i.test(b.callback_data)), 'no chip carries a Credit VALUE');
  assert.ok(!rows.flat().some((b) => /^(💳 )?Credit$/.test(b.text)), 'no chip is labelled Credit');
});

test('no banks registered: just the two fixed chips on one row', async () => {
  settings = { BANK_LIST: '' };
  seedAtSalesperson();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sp:Musa'));
  assert.deepEqual(lastRows(bot).map((r) => r.map((b) => `${b.text}|${b.callback_data}`)), [
    ['💵 Cash|srf_pm:Cash', '⏳ Not yet paid (credit)|srf_pm:Not yet paid'],
    ['⬅️ Back to salesperson|srf_back:salesperson'],
  ]);
});

test('tapping ⏳ Not yet paid (credit) stores the VALUE "Not yet paid" and moves to the date step', async () => {
  seedAtSalesperson();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sp:Musa'));
  await controller.handleCallbackQuery(bot, cb('srf_pm:Not yet paid'));
  const s = sessionStore.get(UID);
  assert.equal(s.paymentMode, 'Not yet paid', 'the value, never the label');
  assert.equal(s.step, 'date');
  assert.match(lastText(bot), /Select supply date/);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'srf_back:payment'), 'the date card keeps Back to payment');
});

test('Cash and a bank chip store their own value the same way', async () => {
  for (const [data, value] of [['srf_pm:Cash', 'Cash'], ['srf_pm:GTBank', 'GTBank']]) {
    seedAtSalesperson();
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('srf_sp:Musa'));
    await controller.handleCallbackQuery(bot, cb(data));
    assert.equal(sessionStore.get(UID).paymentMode, value);
    assert.equal(sessionStore.get(UID).step, 'date');
  }
});

test('Back to payment from the date card re-shows the same vocabulary', async () => {
  seedAtSalesperson();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sp:Musa'));
  await controller.handleCallbackQuery(bot, cb('srf_pm:Not yet paid'));
  await controller.handleCallbackQuery(bot, cb('srf_back:payment'));
  assert.equal(sessionStore.get(UID).step, 'payment');
  assert.equal(sessionStore.get(UID).supplyDate, undefined);
  const chips = lastRows(bot).flat();
  assert.ok(chips.some((b) => b.text === '⏳ Not yet paid (credit)' && b.callback_data === 'srf_pm:Not yet paid'));
  assert.ok(!chips.some((b) => /credit/i.test(b.callback_data)));
});

test('a srf_pm: tap with no supply session is ignored (nothing stored, nothing sent)', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_pm:Not yet paid'));
  assert.equal(sessionStore.get(UID), null);
  assert.equal(cards(bot).length, 0);
});
