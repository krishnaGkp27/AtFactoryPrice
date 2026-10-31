'use strict';

/**
 * TRF-23 (owner's Go, 31-Oct-2026) — the typed transfer line needs no AI.
 *
 * 31-Oct-2026, 10:38 and 10:55: Abdul typed
 *   "Transfer package 832,1186,786,812,828,1193,1202,802,1191,822,1111,1328 to kano"
 * four ways and got "Need more info: Please provide more details (Bale
 * number, than number, customer name, etc.)." every time — the intent
 * parser's OFFLINE fallback string, which only appears when the OpenAI
 * call never produced an answer, and which knows no "transfer". The sell
 * and return lines were parsed locally since SELL-T3 / RET-5; the
 * transfer line was the one typed door still riding the provider.
 *
 * Driven through the real controller with the AI stub returning exactly
 * that offline shape, so a regression here reproduces the incident.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,abdul,musa';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { kbTexts: lastKb } = require('../helpers/charFixture');

/** One bale row (a transfer counts bales, so one row per bale is enough). */
function bale(pkg, extra = {}) {
  return {
    packageNo: pkg, thanNo: 1, design: extra.design || '9006', shade: extra.shade || '3',
    warehouse: extra.warehouse || 'Lagos', status: extra.status || 'available',
    yards: 150, baleUid: `U-${pkg}`, arrivalBatch: 'Jul26', rowIndex: Number(pkg), soldTo: extra.soldTo || '',
  };
}

const ROWS = [
  bale('832'), bale('1186'), bale('786'), bale('812'), bale('828'),
  bale('1193', { status: 'sold', soldTo: 'CJE' }),      // gone
  bale('1202', { warehouse: 'Kano office' }),           // other store
  bale('775'),                                          // ends in 5 — must NOT load from "6189/5"
  bale('6189', { design: '44200', shade: '1' }), bale('6210', { design: '44200', shade: '1' }),
  bale('5801'),
];

const INV_HEADER = [
  'PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs',
  'NetWeight', 'UpdatedAt', 'ProductType', 'bale_uid', 'addedAt', 'grn_id',
  'bin_location', 'arrival_batch', 'design_category',
];
const invSheetRows = ROWS.map((r) => ([
  r.packageNo, '', '', r.design, r.shade, r.thanNo, r.yards, r.status,
  r.warehouse, 0, '2026-07-01', r.soldTo || '', '', 0, 0, '', 'fabric', r.baleUid,
  '2026-07-01', '', '', r.arrivalBatch, '',
]));

installFakeSheets(createFakeSheets({ Inventory: [INV_HEADER, ...invSheetRows] }));

/** The AI stub answers with the parser's OFFLINE fallback — the incident shape. */
const OFFLINE = {
  action: 'check', confidence: 0.5,
  clarification: 'Please provide more details (Bale number, than number, customer name, etc.).',
};
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return OFFLINE; });

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const transferFlow = require(path.join(SRC, 'flows/transferFlow'));

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards' });
auditLogRepository.append = async () => {};
inventoryRepository.getAll = async () => ROWS.map((r) => ({ ...r }));
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', role: 'employee', status: 'active', warehouses: ['Lagos'] },
  { user_id: 'musa', name: 'Musa', role: 'employee', status: 'active', warehouses: ['Kano office'] },
];

function msg(text, uid = '4242') {
  return { from: { id: uid }, chat: { id: uid }, text };
}
function lastText(bot) {
  const c = bot.calls.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)).pop();
  return String((c && c.args.text) || '');
}
function hasChip(texts, label) { return texts.some((t) => t.startsWith(`${label}|`)); }

const ABDUL_LINE = 'Transfer package 832,1186,786,812,828,1193,1202,802,1191,822,1111,1328 to kano';

test('Abdul’s exact line opens the preload card with NO AI call', async () => {
  sessionStore.clear('4242');
  intentCalls = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg(ABDUL_LINE));
  const text = lastText(bot);
  assert.equal(intentCalls, 0, 'the AI parser must not be consulted');
  assert.doesNotMatch(text, /Need more info/);
  assert.match(text, /preloaded 5 of 12 typed bale\(s\)/);
  assert.match(text, /From \*Lagos\*/);
  assert.match(text, /832, 1186, 786, 812, 828/);
  // Every number he typed that could not load is named with its reason.
  assert.match(text, /1193 — already sold to CJE/);
  assert.match(text, /1202 — in Kano office, not Lagos/);
  assert.match(text, /802 — not found in the sheet/);
  // "kano" in lower case matched the one store with that word.
  assert.match(text, /Destination: \*Kano office\*/);
  assert.ok(hasChip(lastKb(bot), '➡ Continue'));
  const s = sessionStore.get('4242');
  assert.equal(s && s.step, 'preload_review');
  assert.deepEqual(s.lines[0].bales, ['832', '1186', '786', '812', '828']);
});

test('the three other spellings he tried land on the same card', async () => {
  for (const line of [
    'Transfer 832,1186,786,812,828,1193,1202,802,1191,822,1111,1328 to kano',
    'Transfer 832, 1186, 786, 812, 828, 1193, 1202, 802, 1191, 822, 1111, 1328 to kano',
    'Transfer package 832, 1186, 786, 812, 828, 1193, 1202, 802, 1191, 822, 1111, 1328 to kano',
  ]) {
    sessionStore.clear('4242');
    intentCalls = 0;
    const bot = createFakeBot();
    await controller.handleMessage(bot, msg(line));
    assert.equal(intentCalls, 0, line);
    assert.match(lastText(bot), /preloaded 5 of 12 typed bale\(s\)/, line);
  }
});

test('the sell grammar out of habit: 6189/5 is bale 6189, never a bale ending in 5', async () => {
  sessionStore.clear('4242');
  intentCalls = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('transfer 6189/5, 6210/5 to kano'));
  const text = lastText(bot);
  assert.equal(intentCalls, 0);
  assert.match(text, /preloaded 2 of 2 typed bale\(s\)/);
  assert.match(text, /6189, 6210/);
  assert.doesNotMatch(text, /775/, 'the "/5" must not be looked up as a bale');
  assert.match(text, /Whole bales move — the than part of 2 number\(s\) was ignored/);
});

test('a worded than line is the whole bale; a trailing full stop does not break the store', async () => {
  const p = transferFlow._internals.parseTypedTransfer('Transfer than 3 from package 5801 to Kano office.');
  assert.deepEqual(p.numbers, ['5801']);
  assert.equal(p.destHint, 'Kano office');
  assert.equal(p.thanSuffixes, 1);
  const q = transferFlow._internals.parseTypedTransfer('Move 771 x3, 779 to kano');
  assert.deepEqual(q.numbers, ['771', '779']);
});

test('no number → not the local door: the AI is asked, as before', async () => {
  sessionStore.clear('4242');
  intentCalls = 0;
  const bot = createFakeBot();
  await controller.handleMessage(bot, msg('Transfer stock'));
  assert.equal(intentCalls, 1);
  assert.match(lastText(bot), /Need more info/);
});

test('a sell line and a return line keep their own doors', async () => {
  const { looksLikeTransferLine } = require(path.join(SRC, 'utils/thanListParser'));
  assert.equal(looksLikeTransferLine('sell 832/1, 1186/1 kano'), false);
  assert.equal(looksLikeTransferLine('Return 832, 1186'), false);
});
