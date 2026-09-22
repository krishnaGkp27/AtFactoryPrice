'use strict';

/**
 * SFS-1 — 🏬 Store Sales through the REAL controller: the Reporting-hub
 * tile opens the place picker, the `sfs:` prefix is routed to the flow,
 * and a non-admin tapping the tile is refused in one line.
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

const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));

unitDisplayService.getThanVisibilityWarehouses = async () => new Set(['kano office']);

const ROWS = [
  { packageNo: '5804', design: '202/201', shade: '1', thanNo: 1, yards: 30, status: 'sold', soldTo: 'ABBA', soldDate: '2026-08-19', warehouse: 'IDUMOTA', baleUid: 'U-5804' },
  { packageNo: '5804', design: '202/201', shade: '1', thanNo: 2, yards: 30, status: 'available', soldTo: '', soldDate: '', warehouse: 'IDUMOTA', baleUid: 'U-5804' },
  { packageNo: '9001', design: '9037', shade: '', thanNo: 1, yards: 25, status: 'sold', soldTo: 'Musa', soldDate: '2026-07-30', warehouse: 'Kano office', baleUid: 'U-9001' },
];
inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(ROWS));
inventoryRepository.getSoldRows = async () => JSON.parse(JSON.stringify(ROWS.filter((r) => r.status === 'sold')));

function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}
function kbTexts(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup);
  const kb = c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => `${b.text}|${b.callback_data}`);
}
function cq(uid, data) {
  return { id: `cq-${data}`, data, from: { id: uid }, message: { chat: { id: 500 }, message_id: 77 } };
}

test.beforeEach(() => { sessionStore.clear('777'); sessionStore.clear('4242'); });

test('registry: 🏬 Store Sales sits in the Reporting hub next to Customer Supplies', () => {
  const a = activityRegistry.getActivity('store_sales');
  assert.ok(a);
  assert.equal(a.label, 'Store Sales');
  assert.equal(a.icon, '🏬');
  assert.equal(a.callback, 'act:store_sales');
  assert.equal(a.hub, 'reporting');
  assert.equal(activityRegistry.getByCallback('act:store_sales').code, 'store_sales');
});

test('tile → places → days → day card, every tap routed by the controller', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('777', 'act:store_sales'));
  assert.match(lastText(bot), /🏬 \*Store Sales\*\n\nTap a place to see its sales\./);
  assert.deepEqual(kbTexts(bot), ['IDUMOTA|sfs:w:0', 'Kano office|sfs:w:1', '🏠 Back to menu|act:__back__']);
  assert.equal(sessionStore.get('777').type, 'store_sales_flow');

  await controller.handleCallbackQuery(bot, cq('777', 'sfs:w:0'));
  assert.match(lastText(bot), /🏬 \*Sales — IDUMOTA\*\n\nTotal: \*1t\* · \*30\* yds\nacross \*1\* sale day · first: 19 Aug 2026/);
  assert.deepEqual(kbTexts(bot), ['19 Aug 2026 — 1t (30 yds)|sfs:d:0', '🏬 Change place|sfs:back', '❌ Close|sfs:close']);

  await controller.handleCallbackQuery(bot, cq('777', 'sfs:d:0'));
  assert.equal(lastText(bot), '🧾 *IDUMOTA* · 19 Aug 2026\n_1t sold · 30 yds_\n\n👤 *ABBA*\n 🧵 *202/201*\n  • Shade 1 ×1t (5804)');
  assert.deepEqual(kbTexts(bot), ['⬅ Dates|sfs:back', '❌ Close|sfs:close']);

  await controller.handleCallbackQuery(bot, cq('777', 'sfs:close'));
  assert.match(lastText(bot), /🏬 Closed\./);
  assert.equal(sessionStore.get('777'), null);
});

test('a non-admin tapping the tile is refused in one line and gets no session', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('4242', 'act:store_sales'));
  assert.match(lastText(bot), /🏬 Store Sales is admin-only\./);
  assert.equal(sessionStore.get('4242'), null);
});
