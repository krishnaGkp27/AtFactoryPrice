'use strict';
/**
 * TXT-3 — the whole script through the REAL controller: a typed verb lands on
 * its existing branch with no AI call in mode 0; a bad body gets the verb's
 * line; `help` the card; a tile word one button; an unknown line is counted
 * with its first 40 characters.
 */
process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { lastKb } = require('../helpers/charFixture');

const INV_HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt', 'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
const row = (pkg, than, design, shade, wh) => [pkg, '', '', design, shade, than, 150, 'available', wh, 0, '2026-07-01', '', '', 0, 0, '', 'fabric', `U-${pkg}-${than}`, '2026-07-01', '', '', 'Jul26', ''];
installFakeSheets(createFakeSheets({
  Inventory: [INV_HEADER, row('832', 1, '9006', 'black', 'Lagos'), row('832', 2, '9006', 'black', 'Lagos'), row('900', 1, '44200', 'BLACK', 'Kano office')],
}));
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return { action: 'check', confidence: 0.9, clarification: null }; });
const controller = loadController();
const typedRouter = require(path.join(SRC, 'utils/typedRouter'));
const usageTracker = require(path.join(SRC, 'services/usageTracker'));
const tracked = [];
usageTracker.track = (e) => { tracked.push(e); };

const msg = (text, uid = '4242') => ({ chat: { id: uid }, from: { id: uid, first_name: 'T' }, text });
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text;
async function send(text, uid) {
  const bot = createFakeBot();
  intentCalls = 0;
  await controller.handleMessage(bot, msg(text, uid));
  return bot;
}
test.beforeEach(() => { typedRouter.forceMode('0'); tracked.length = 0; });
test.after(() => typedRouter.forceMode(null));

test('Stock 9006 black answers from the sheet, no AI; Stock at Kano office too', async () => {
  let bot = await send('Stock 9006 black');
  assert.equal(intentCalls, 0);
  assert.match(lastText(bot), /Design: 9006, Shade: black/);
  bot = await send('stock at Kano office');
  assert.match(lastText(bot), /Warehouse: Kano office/);
});

test('Balance for an employee hits the admin gate; Price for an employee the admin gate; both without AI', async () => {
  let bot = await send('Balance Abba');
  assert.equal(intentCalls, 0);
  assert.match(lastText(bot), /admins only/);
  bot = await send('Price 9006 black 1500');
  assert.match(lastText(bot), /Only admin can update prices/);
});

test('a known verb with a bad body gets its own line, the AI never called; Payment points at the tap door', async () => {
  let bot = await send('Transfer to kano');
  assert.equal(intentCalls, 0);
  assert.match(lastText(bot), /^✍️ Transfer needs its line:\n {2}Transfer 832, 1186, 786 to kano/);
  assert.deepEqual(lastKb(bot).map((b) => b.callback_data), ['act:__back__']);
  bot = await send('Payment Abba 250000 cash');
  assert.match(lastText(bot), /recorded by tap, never by a typed line/);
  assert.equal(tracked.filter((e) => e.event === 'nlp_hint').length, 2);
});

test('help and /help show the whole script; Report alone is one button to the hub; Tasks opens My Tasks', async () => {
  for (const line of ['help', '/help', 'Help me']) {
    const bot = await send(line);
    assert.match(lastText(bot), /I work with the chips[\s\S]*Stock 9006 black · Stock at Lagos[\s\S]*Help — this card/, line);
  }
  const bot = await send('Report');
  assert.match(lastText(bot), /Every report is a tap away/);
  assert.deepEqual(lastKb(bot).map((b) => [b.text, b.callback_data]), [['📊 Reporting', 'act:__hub__:reporting']]);
  const tbot = await send('Tasks');
  assert.ok(tbot.calls.some((c) => c.method === 'sendMessage' && /Loading your tasks/.test(c.args.text)));
  assert.equal(intentCalls, 0);
});

test('an unknown line is counted with its first 40 characters and gets the chips card', async () => {
  const bot = await send('kindly let me know what is left of 9006 in lagos store today');
  assert.match(lastText(bot), /I work with the chips/);
  assert.equal(intentCalls, 0);
  const off = tracked.find((e) => e.event === 'nlp_off');
  assert.equal(off.meta.head, 'kindly let me know what is left of 9006 ');
});
