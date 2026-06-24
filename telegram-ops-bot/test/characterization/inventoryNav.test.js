'use strict';

/**
 * Characterization suite — Inventory report navigation (NAV-1).
 *
 * Pins the Back/Menu footers added to the Check Stock and List Packages
 * report screens so a user is never stranded on a stock card:
 *   - the stock report carries [⬅ Back to designs][🏠 Menu]
 *   - tapping "Back to designs" re-opens the design picker in place
 *   - the picker itself carries [⬅ Back to Inventory][🏠 Menu]
 *
 * Drives the real controller; only sheetsClient / intentParser / bot are faked.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController } = require('../helpers/controllerHarness');

const INV_HEADER = [
  'PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs',
  'NetWeight', 'UpdatedAt', 'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location',
];
function invRow(pkg, than, design, shade, status, wh) {
  const r = new Array(21).fill('');
  r[0] = pkg; r[3] = design; r[4] = shade; r[5] = String(than); r[6] = '100';
  r[7] = status; r[8] = wh; r[9] = '1000'; r[16] = 'fabric'; r[17] = `BAL-${pkg}`;
  return r;
}

installFakeSheets(createFakeSheets({
  Inventory: [
    INV_HEADER,
    invRow('P1', 1, 'TESTD', 'Red', 'available', 'Lagos'),
    invRow('P2', 1, 'TESTD', 'Red', 'available', 'Lagos'),
  ],
  Users: [['user_id', 'name', 'role', 'status'], ['777', 'Admin', 'admin', 'active']],
}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();

function cbq(data, fromId = 777) {
  return { id: 'c1', data, from: { id: fromId, first_name: 'A' }, message: { chat: { id: fromId }, message_id: 42 } };
}
function flatKb(opts) {
  const kb = opts && opts.reply_markup && opts.reply_markup.inline_keyboard;
  return kb ? kb.flat() : [];
}

test('Check Stock report carries Back-to-designs + Menu nav', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cbq('cks:TESTD'));
  const report = bot.callsTo('sendMessage')
    .find((m) => flatKb(m.args.opts).some((b) => b.callback_data === 'cks:__designs__'));
  assert.ok(report, 'stock report should carry a Back-to-designs button');
  assert.ok(flatKb(report.args.opts).some((b) => b.callback_data === 'act:__back__'), 'and a Menu button');
});

test('cks:__designs__ re-opens the design picker in place with Inventory footer', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cbq('cks:__designs__'));
  const picker = bot.callsTo('editMessageText')
    .find((e) => flatKb(e.args.opts).some((b) => b.callback_data === 'act:__hub__:inventory'));
  assert.ok(picker, 'picker should be re-rendered with a Back-to-Inventory button');
  assert.ok(flatKb(picker.args.opts).some((b) => b.callback_data === 'act:__back__'), 'and a Menu button');
});

test('List Packages report carries Back-to-designs + Menu nav', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cbq('lpk:TESTD'));
  const report = bot.callsTo('sendMessage')
    .find((m) => flatKb(m.args.opts).some((b) => b.callback_data === 'lpk:__designs__'));
  assert.ok(report, 'bales report should carry a Back-to-designs button');
  assert.ok(flatKb(report.args.opts).some((b) => b.callback_data === 'act:__back__'), 'and a Menu button');
});
