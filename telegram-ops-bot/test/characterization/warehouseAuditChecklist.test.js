'use strict';

/**
 * WAU-3 — blind-count audit (owner 20-Jul-2026):
 * location → warehouse → BLIND design list (no book quantities anywhere)
 * → tap-pad count entry → match/recount/flag pipeline → admin flag clear
 * → offline AUDIT batch template (stateless).
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
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));

// 9032 in IDUMOTA: bale P1 sealed (2/2 available), bale P2 opened (1/2) →
// book = 1 full bale + 1 loose bundle. 9037: one sealed bale (1+0).
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
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `U${id}` });
usersRepository.getAll = async () => [];

// StockTakes stubs share one in-memory `takes` array, mirroring the real
// repo semantics (minted ids, result filter in latestFor, day filter).
let takes = [];
stockTakesRepository.appendMany = async (records) => {
  const minted = records.map((r, i) => ({
    audited_at: new Date().toISOString(), ...r,
    stocktake_id: r.stocktake_id || `ST-${takes.length + i}`,
    result: r.result || 'reconciled',
  }));
  takes.push(...minted);
  return minted;
};
stockTakesRepository.latestFor = async (warehouse) => {
  const map = new Map();
  for (const r of takes) {
    if (r.warehouse.toLowerCase() !== warehouse.toLowerCase() || r.result !== 'reconciled') continue;
    const k = r.design.toUpperCase();
    const prev = map.get(k);
    if (!prev || r.audited_at > prev.audited_at) map.set(k, r);
  }
  return map;
};
stockTakesRepository.rowsForDay = async (warehouse, day) =>
  takes.filter((r) => r.warehouse.toLowerCase() === warehouse.toLowerCase() && String(r.audited_at).startsWith(day));
stockTakesRepository.getById = async (id) => takes.find((r) => r.stocktake_id === id) || null;

function cb(data, uid = '4242') {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 5 } };
}
function kbTexts(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}
async function openChecklist(bot, uid = '4242') {
  await controller.handleCallbackQuery(bot, cb('act:warehouse_audit', uid));
  // Lagos (locations sorted Kano,Lagos) — holds only IDUMOTA, so the
  // warehouse picker auto-skips straight to the checklist.
  await controller.handleCallbackQuery(bot, cb('wai:loc:1', uid));
}
async function pad(bot, keys, uid = '4242') {
  for (const k of keys) await controller.handleCallbackQuery(bot, cb(`wai:k:${k}`, uid));
  await controller.handleCallbackQuery(bot, cb('wai:padok', uid));
}

test('employee sees a BLIND list (no quantities) and a matching count reconciles with counted_*', async () => {
  const bot = createFakeBot();
  await openChecklist(bot);
  const buttons = kbTexts(bot).map((b) => b.text).join(' | ');
  assert.match(buttons, /⬜ 9032/);
  assert.ok(!/bls|bnd|yds|\d+ ?y\b/.test(buttons), `no quantities on the blind list: ${buttons}`);
  // 9032 book = 1 full + 1 loose → enter 1+1.
  const d = kbTexts(bot).find((b) => b.text === '⬜ 9032');
  await controller.handleCallbackQuery(bot, cb(d.callback_data));
  assert.match(bot.allText(), /Your count: —/);
  await pad(bot, ['1', 'p', '1']);
  const rec = takes.find((t) => t.design === '9032' && t.result === 'reconciled');
  assert.ok(rec, 'reconciled row written');
  assert.equal(rec.counted_bales, 1);
  assert.equal(rec.counted_bundles, 1);
  assert.match(kbTexts(bot).map((b) => b.text).join(' '), /✅ 9032/);
  sessionStore.clear('4242');
});

test('two mismatched counts → recount (no numbers leaked) then flag + admin card + lock', async () => {
  const bot = createFakeBot();
  await openChecklist(bot);
  const d = kbTexts(bot).find((b) => b.text === '⬜ 9037'); // book = 1+0
  await controller.handleCallbackQuery(bot, cb(d.callback_data));
  await pad(bot, ['3']);
  assert.match(bot.allText(), /does not match the book\. Recount CAREFULLY/);
  const empView = bot.allText();
  assert.ok(!/1 bale|book: 1|expects/i.test(empView), 'book figure never shown to the employee');
  await pad(bot, ['3']); // second miss
  assert.match(bot.allText(), /flagged for admin review/i);
  const adminMsgs = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777').map((c) => c.args.text).join('\n');
  assert.match(adminMsgs, /🚩 Stock audit flag — IDUMOTA/);
  assert.match(adminMsgs, /Counted: 3 bales \+ 0 bundles/);
  assert.match(adminMsgs, /Book: 1 bale \+ 0 bundles/, 'admin card DOES show both figures');
  assert.ok(takes.some((t) => t.design === '9037' && t.result === 'flagged'));
  // Locked: back on the list, 9037 shows 🚩 and the pad refuses to open.
  await controller.handleCallbackQuery(bot, cb('wai:padcx'));
  const lockBtn = kbTexts(bot).find((b) => b.text.includes('9037'));
  assert.match(lockBtn.text, /🚩 9037 — locked/);
  sessionStore.clear('4242');
});

test('admin clears the flag from the DM card (session-free) and the design re-opens', async () => {
  const bot = createFakeBot();
  const flag = takes.find((t) => t.design === '9037' && t.result === 'flagged');
  // Non-admin tap is refused.
  await controller.handleCallbackQuery(bot, cb(`wai:aclr:${flag.stocktake_id}`, '4242'));
  assert.ok(!takes.some((t) => t.result === 'flag_cleared'), 'employee cannot clear');
  await controller.handleCallbackQuery(bot, cb(`wai:aclr:${flag.stocktake_id}`, '777'));
  assert.ok(takes.some((t) => t.design === '9037' && t.result === 'flag_cleared'), 'clear row appended');
  const bot2 = createFakeBot();
  await openChecklist(bot2);
  assert.match(kbTexts(bot2).map((b) => b.text).join(' '), /🔁 9037/, 're-opened (recount icon from earlier misses)');
  sessionStore.clear('4242');
});

test('offline template lists open designs without quantities; batch message reconciles statelessly', async () => {
  const bot = createFakeBot();
  await openChecklist(bot);
  await controller.handleCallbackQuery(bot, cb('wai:tmpl'));
  const tmpl = bot.calls.filter((c) => c.method === 'sendMessage').map((c) => c.args.text).find((t) => /^AUDIT IDUMOTA/.test(t));
  assert.ok(tmpl, 'template message sent');
  assert.match(tmpl, /9037 =/);
  assert.ok(!/9032 =/.test(tmpl), 'reconciled design excluded from the sheet');
  assert.ok(!/\d+\s*(bls|bnd|yds)/.test(tmpl), 'no quantities in the template');
  sessionStore.clear('4242');

  // Batch arrives later — NO session. 9037 book = 1+0 → "1" matches now.
  const bot2 = createFakeBot();
  await controller.handleMessage(bot2, { from: { id: '4242' }, chat: { id: '4242' }, text: 'AUDIT idumota\n9037 = 1\nMYSTERY = 2\n9032 =' });
  const reply = bot2.calls.filter((c) => c.method === 'sendMessage').map((c) => c.args.text).join('\n');
  assert.match(reply, /✅ Reconciled \(1\): 9037/);
  assert.match(reply, /❓ Not found in IDUMOTA: MYSTERY/);
  assert.match(reply, /⬜ Left blank \(1\): 9032/);
  assert.ok(takes.some((t) => t.design === '9037' && t.result === 'reconciled' && t.counted_bales === 1));
});

test('deep inspect is admin-only in the blind flow', async () => {
  const bot = createFakeBot();
  await openChecklist(bot, '4242');
  assert.ok(!kbTexts(bot).some((b) => b.callback_data === 'wai:inspect'), 'no inspect button for employees');
  sessionStore.clear('4242');
  const bot2 = createFakeBot();
  await openChecklist(bot2, '777');
  assert.ok(kbTexts(bot2).some((b) => b.callback_data === 'wai:inspect'), 'admins keep deep inspect');
  sessionStore.clear('777');
});
