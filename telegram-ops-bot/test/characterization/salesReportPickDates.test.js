'use strict';
// SRP-1 — 📊 Sales Report: the period card is Weekly · Pick dates · Back; a
// picked range titles the Group by card and the report, both ends inclusive.
process.env.ADMIN_IDS = '777';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts } = require('../helpers/charFixture');

const HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
const row = (than, soldTo, soldDate) => ['6061', 'ST/1321', '', '9043-A', '6', String(than), '60', 'sold', 'Kano office',
  '3500', '2026-02-10', soldTo, soldDate, '', '', '', 'fabric', `BAL-20260210-6061-${than}`, '2026-02-10', '', '', 'Feb26', ''];
installFakeSheets(createFakeSheets({
  Inventory: [HEADER, row(1, 'ABBA', '2026-09-11'), row(2, 'ABBA', '2026-09-12'), row(3, 'Qaribullah', '2026-10-03'), row(4, 'Qaribullah', '2026-10-04')],
}));
installFakeIntent(() => null);
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text;

test('tile → Pick dates → start → end → Group by → report titled with the inclusive range', async () => {
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:sales_report', '777', 5));
  assert.deepEqual(kbTexts(bot), ['📅 Weekly (7 days)|sr:7', '📆 Pick dates|srd:start', '⬅ Back to menu|act:__back__']);

  await controller.handleCallbackQuery(bot, cb('srd:start', '777', 5));
  assert.match(bot.allText(), /From which date\? Tap a day\./);
  await controller.handleCallbackQuery(bot, cb('srd:dm:2026-09', '777', 5));
  await controller.handleCallbackQuery(bot, cb('srd:dd:2026-09-12', '777', 5));
  assert.match(bot.allText(), /From 12 Sep 2026 — to which date\?/);
  assert.ok(!kbTexts(bot).some((t) => t.startsWith('11|')), 'days before the start are inert');
  await controller.handleCallbackQuery(bot, cb('srd:dm:2026-10', '777', 5));
  await controller.handleCallbackQuery(bot, cb('srd:dd:2026-10-03', '777', 5));
  assert.match(bot.allText(), /📊 \*12 Sep – 03 Oct 2026 Sales Report\*\n\nGroup by:/);
  assert.equal(sessionStore.get('777').key, 'D7iv.7jg');

  await controller.handleCallbackQuery(bot, cb('srg:customer', '777', 5));
  const text = bot.allText();
  assert.match(text, /12 Sep – 03 Oct 2026/);
  assert.match(text, /ABBA\* — 1 Bales · 1 thans · 60 yds/, 'the 11-Sep than is outside, the 12-Sep one inside');
  assert.match(text, /Qaribullah\* — 1 Bales · 1 thans · 60 yds/, 'the 04-Oct than is outside, the 03-Oct one inside');
  assert.equal(sessionStore.get('777'), null);
});

test('Back from the end grid returns to the start grid; Back from the start grid returns to the period card; Weekly still works', async () => {
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srd:start', '777', 5));
  await controller.handleCallbackQuery(bot, cb('srd:dd:2026-10-01', '777', 5));
  await controller.handleCallbackQuery(bot, cb('srd:back', '777', 5));
  assert.match(lastText(bot), /From which date\?/);
  await controller.handleCallbackQuery(bot, cb('srd:back', '777', 5));
  assert.deepEqual(kbTexts(bot).map((t) => t.split('|')[0]), ['📅 Weekly (7 days)', '📆 Pick dates', '⬅ Back to menu']);
  assert.equal(sessionStore.get('777'), null);

  await controller.handleCallbackQuery(bot, cb('sr:7', '777', 5));
  assert.match(lastText(bot), /📊 \*Weekly Sales Report\*/);
  assert.equal(sessionStore.get('777').key, '7');
  sessionStore.clear('777');
});

test('a non-admin is refused', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srd:start', '4242', 5));
  assert.ok(!bot.calls.some((c) => ['editMessageText', 'sendMessage'].includes(c.method) && /Tap a day/.test(c.args.text)), JSON.stringify(bot.calls.map((c) => [c.method, c.args.text || (c.args.opts && c.args.opts.text)])));
});
