'use strict';

/**
 * WAU-2 — location → warehouse → design checklist → submit reconciled:
 * persistence to StockTakes, holding semantics, and auto-invalidation
 * when stock changes after a reconciliation.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const stockTakesRepository = require(path.join(SRC, 'repositories/stockTakesRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

// 9032 in IDUMOTA: bale P1 sealed (2/2 available), bale P2 opened (1/2) →
// 1 full bale + 1 loose bundle. 9037: one sealed bale. Kano office: 44200.
let rows = [
  { packageNo: 'P1', design: '9032', shade: '1', warehouse: 'IDUMOTA', status: 'available', yards: 60 },
  { packageNo: 'P1', design: '9032', shade: '1', warehouse: 'IDUMOTA', status: 'available', yards: 60 },
  { packageNo: 'P2', design: '9032', shade: '2', warehouse: 'IDUMOTA', status: 'available', yards: 55 },
  { packageNo: 'P2', design: '9032', shade: '2', warehouse: 'IDUMOTA', status: 'sold', yards: 55, soldTo: 'CJE' },
  { packageNo: 'P3', design: '9037', shade: '8', warehouse: 'IDUMOTA', status: 'available', yards: 58 },
  { packageNo: 'P9', design: '44200', shade: '1', warehouse: 'Kano office', status: 'available', yards: 50 },
];
inventoryRepository.getAll = async () => [...rows];
inventoryRepository.getWarehouses = async () => ['IDUMOTA', 'Kano office'];
settingsRepository.getAll = async () => ({});
auditLogRepository.append = async () => {};

let takes = [];
stockTakesRepository.getAll = async () => [...takes];
stockTakesRepository.appendMany = async (records) => {
  records.forEach((r, i) => takes.push({ stocktake_id: `ST-${takes.length + i}`, result: 'reconciled', ...r }));
  return records;
};
stockTakesRepository.latestFor = async (warehouse) => {
  const map = new Map();
  for (const r of takes) {
    if (r.warehouse.toLowerCase() !== warehouse.toLowerCase()) continue;
    const k = r.design.toUpperCase();
    const prev = map.get(k);
    if (!prev || r.audited_at > prev.audited_at) map.set(k, r);
  }
  return map;
};

function cb(data, uid = '777') {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 61 } };
}
function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}

test('location → warehouse → checklist with full-bale/bundle quantities', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:warehouse_audit'));
  let kb = lastKb(bot);
  const lagos = kb.find((b) => /📍 Lagos/.test(b.text));
  assert.ok(lagos, 'location chips rendered');
  assert.ok(kb.some((b) => /📍 Kano \(1 warehouse\)/.test(b.text)), 'Kano office grouped under Kano');

  await controller.handleCallbackQuery(bot, cb(lagos.callback_data));
  // Lagos has one warehouse (IDUMOTA) → auto-advance to the checklist.
  assert.match(bot.allText(), /IDUMOTA — Lagos/);
  kb = lastKb(bot);
  const d9032 = kb.find((b) => /9032/.test(b.text));
  assert.match(d9032.text, /⬜ 9032 — 1 bls · 1 bnd/, 'sealed bale + loose bundle split');
  assert.ok(kb.some((b) => /⬜ 9037 — 1 bls/.test(b.text)), 'second design holding');
});

test('tick + submit persists reconciled rows; unticked stays holding', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:warehouse_audit'));
  const lagos = lastKb(bot).find((b) => /📍 Lagos/.test(b.text));
  await controller.handleCallbackQuery(bot, cb(lagos.callback_data));
  let kb = lastKb(bot);
  const d9032 = kb.find((b) => /⬜ 9032/.test(b.text));
  assert.ok(d9032, 'checklist row present');
  await controller.handleCallbackQuery(bot, cb(d9032.callback_data));
  kb = lastKb(bot);
  assert.ok(kb.some((b) => /☑️ 9032/.test(b.text)), 'checkbox ticked');
  const submit = kb.find((b) => b.callback_data === 'wai:submit');
  assert.match(submit.text, /mark 1 design reconciled/);
  await controller.handleCallbackQuery(bot, cb('wai:submit'));
  assert.equal(takes.length, 1, 'one StockTakes row persisted');
  assert.equal(takes[0].design, '9032');
  assert.equal(takes[0].sheet_bales, 1);
  assert.equal(takes[0].sheet_bundles, 1);
  assert.equal(takes[0].location, 'Lagos');
  kb = lastKb(bot);
  assert.ok(kb.some((b) => /✅ 9032 — 1 bls · 1 bnd \(done /.test(b.text)), 'reconciled with date');
  assert.ok(kb.some((b) => /⬜ 9037/.test(b.text)), '9037 still holding');
  assert.match(bot.allText(), /Reconciled 1\/2 designs · holding 1/);
});

test('stock change after reconciliation flips the design back to holding', async () => {
  // A than of sealed bale P1 sells → 9032 becomes 0 full bales + 2 loose.
  rows[0] = { ...rows[0], status: 'sold', soldTo: 'OKSON' };
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:warehouse_audit'));
  const lagos = lastKb(bot).find((b) => /📍 Lagos/.test(b.text));
  await controller.handleCallbackQuery(bot, cb(lagos.callback_data));
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => /⬜ 9032 — 0 bls · 2 bnd/.test(b.text)),
    'reconciliation invalidated: quantities changed → holding again');
  sessionStore.clear('777');
});
