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
const { cb, lastKb: kbTexts } = require('../helpers/charFixture');

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
  // 9040 is never counted by any test — it stays OPEN so the AUD-X1 test
  // can prove system designs and hand-added extras share one sheet.
  { packageNo: 'P4', design: '9040', shade: '1', warehouse: 'IDUMOTA', status: 'available', yards: 62 },
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
    // TIME-1: the flow filters rows by todayInLagos(), so a UTC-stamped
    // fixture vanished from its own checklist between 23:00 and 00:00 UTC.
    audited_at: `${require('../../src/utils/dates').todayInLagos()}T${new Date().toISOString().slice(11)}`, ...r,
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

async function openChecklist(bot, uid = '4242') {
  await controller.handleCallbackQuery(bot, cb('act:warehouse_audit', uid));
  // Lagos (locations sorted Kano,Lagos). AUD-X2 widened the warehouse source
  // to Inventory ∪ Settings.WAREHOUSE_LIST ∪ the onboarding dataset, so Lagos
  // now offers several stores instead of auto-forwarding to the only one —
  // pick IDUMOTA explicitly.
  await controller.handleCallbackQuery(bot, cb('wai:loc:1', uid));
  const idumota = kbTexts(bot).find((b) => (b.text || '').includes('IDUMOTA')
    && /^wai:wh:/.test(b.callback_data || ''));
  if (idumota) await controller.handleCallbackQuery(bot, cb(idumota.callback_data, uid));
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
  // AUD-X1 — an unknown design's count is the onboarding audit's whole
  // point: RECORDED, never dismissed as "not found".
  assert.match(reply, /🆕 New designs recorded for onboarding \(1\): MYSTERY = 2/);
  assert.match(reply, /⬜ Left blank \(1\): 9032/);
  assert.ok(takes.some((t) => t.design === '9037' && t.result === 'reconciled' && t.counted_bales === 1));
  assert.ok(takes.some((t) => t.design === 'MYSTERY' && t.result === 'new_design' && t.counted_bales === 2),
    'the physical count for the not-yet-onboarded design lands in StockTakes');
});

test('AUD-X1: owner adds EXTRA designs; the copy-paste sheet carries them', async () => {
  const bot = createFakeBot();
  await openChecklist(bot);
  await controller.handleCallbackQuery(bot, cb('wai:xd'));
  await controller.handleMessage(bot, {
    from: { id: '4242' }, chat: { id: '4242' },
    text: '9037-E, 402/9059 (08)\n77008',
  });
  const msgs = bot.calls.filter((c) => c.method === 'sendMessage').map((c) => c.args.text);
  assert.ok(msgs.some((t) => /Added 3 design\(s\)/.test(t)), `confirmation with the count: ${msgs.slice(-3)}`);
  const tmpl = msgs.find((t) => /^AUDIT IDUMOTA/.test(t));
  assert.ok(tmpl, 'the updated sheet is re-sent immediately');
  assert.match(tmpl, /9037-E =/, 'extra design on the sheet');
  assert.match(tmpl, /402\/9059 \(08\) =/, 'codes with slashes and brackets survive');
  assert.match(tmpl, /77008 =/);
  assert.match(tmpl, /9040 =/, 'open system designs still listed first');
  assert.ok(!/^9037 =/m.test(tmpl), 'reconciled system designs stay off the sheet');
  sessionStore.clear('4242');
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
