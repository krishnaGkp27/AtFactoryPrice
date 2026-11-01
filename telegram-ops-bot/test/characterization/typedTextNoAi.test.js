'use strict';

/**
 * TXT-1 (owner, 01-Nov-2026): "make all sheet read and write prohibited
 * through AI model API. It would either get through [the script lines] or
 * get message to open chips." Settings AI_TEXT_PARSER = 0 by default.
 *
 * Driven through the real controller. The fake intent parser COUNTS its
 * calls: in mode 0 it must never be consulted.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,abdul,musa';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { kbTexts } = require('../helpers/charFixture');

function bale(pkg, extra = {}) {
  return {
    packageNo: pkg, thanNo: 1, design: '9006', shade: '3', warehouse: extra.warehouse || 'Lagos',
    status: 'available', yards: 150, baleUid: `U-${pkg}`, arrivalBatch: 'Jul26', rowIndex: Number(pkg), soldTo: '',
  };
}
const ROWS = [bale('832'), bale('1186'), bale('786'), bale('900', { warehouse: 'Kano office' })];
const INV_HEADER = [
  'PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs',
  'NetWeight', 'UpdatedAt', 'ProductType', 'bale_uid', 'addedAt', 'grn_id',
  'bin_location', 'arrival_batch', 'design_category',
];
const invSheetRows = ROWS.map((r) => ([
  r.packageNo, '', '', r.design, r.shade, r.thanNo, r.yards, r.status,
  r.warehouse, 0, '2026-07-01', '', '', 0, 0, '', 'fabric', r.baleUid, '2026-07-01', '', '', r.arrivalBatch, '',
]));
installFakeSheets(createFakeSheets({ Inventory: [INV_HEADER, ...invSheetRows] }));

let intent = { action: 'check', confidence: 0.9, clarification: null };
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return intent; });

const controller = loadController();
const typedRouter = require(path.join(SRC, 'utils/typedRouter'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
auditLogRepository.append = async () => {};
inventoryRepository.getAll = async () => ROWS.map((r) => ({ ...r }));
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];

function msg(text, uid = '4242') { return { from: { id: uid }, chat: { id: uid }, text }; }
function lastText(bot) {
  const c = bot.calls.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)).pop();
  return String((c && c.args.text) || '');
}
function hasChip(bot, label) { return kbTexts(bot).some((t) => t.startsWith(`${label}|`)); }
async function send(text) {
  sessionStore.clear('4242');
  intentCalls = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg(text));
  return bot;
}

test('mode 0 (default): a question gets the chips card and the AI is never asked', async () => {
  typedRouter.forceMode('0');
  const bot = await send("What's in Lagos warehouse?");
  assert.equal(intentCalls, 0);
  assert.match(lastText(bot), /I work with the chips, not sentences/);
  assert.match(lastText(bot), /Transfer 832, 1186, 786 to kano/);
  assert.ok(hasChip(bot, '🏠 Menu'));
  assert.doesNotMatch(lastText(bot), /Need more info/);
});

test('mode 0: a greeting is still greeted (the existing door, before the router)', async () => {
  typedRouter.forceMode('0');
  const bot = await send('hi');
  assert.equal(intentCalls, 0);
  assert.match(lastText(bot), /Hi/);
});

test('mode 0: a would-be sale, payment or price sentence gets the chips card', async () => {
  typedRouter.forceMode('0');
  for (const line of ['Sell package 832 to Ibrahim', 'Record payment 50000 from Ibrahim via bank', 'Update price of 9006 to 1500']) {
    const bot = await send(line);
    assert.equal(intentCalls, 0, line);
    assert.match(lastText(bot), /I work with the chips/, line);
  }
});

test('mode 0: the three script lines are read locally, before the card', async () => {
  typedRouter.forceMode('0');
  const bot = await send('Transfer 832, 1186, 786 to kano');
  assert.equal(intentCalls, 0);
  assert.match(lastText(bot), /preloaded 3 of 3 typed bale\(s\)/);
  assert.match(lastText(bot), /Destination: \*Kano office\*/);
});

test('mode reads: the AI may answer a question', async () => {
  typedRouter.forceMode('reads');
  intent = { action: 'check', warehouse: 'Lagos', confidence: 0.9, clarification: null };
  const bot = await send("What's in Lagos warehouse?");
  assert.equal(intentCalls, 1);
  assert.doesNotMatch(lastText(bot), /I work with the chips/);
});

test('mode reads: an AI-named write is refused with the ✋ card — no sale flow, no queue', async () => {
  typedRouter.forceMode('reads');
  intent = { action: 'sell_package', packageNo: '832', customer: 'Ibrahim', confidence: 0.95, clarification: null };
  const bot = await send('Sell package 832 to Ibrahim');
  assert.equal(intentCalls, 1);
  assert.match(lastText(bot), /^✋ Typed words never change the sheet\./);
  assert.ok(!sessionStore.get('4242'), 'no sale session may open');
  intent = { action: 'record_payment', customer: 'Ibrahim', price: 50000, confidence: 0.95, clarification: null };
  const bot2 = await send('Record payment 50000 from Ibrahim');
  assert.match(lastText(bot2), /^✋ Typed words never change the sheet\./);
});

test('mode 1: the old behaviour — the AI drives the sale door', async () => {
  typedRouter.forceMode('1');
  intent = { action: 'sell_package', packageNo: null, customer: null, confidence: 0.95, clarification: null };
  const bot = await send('Sell package to Ibrahim');
  assert.equal(intentCalls, 1);
  assert.match(lastText(bot), /Which package\?/);
  typedRouter.forceMode(null);
});
