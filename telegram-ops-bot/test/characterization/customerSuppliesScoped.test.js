'use strict';

/**
 * SSA-1 — 📒 Customer Supplies obeys the admin-ticked places (owner ruling
 * 24-Sep-2026: "scope both the reports together", "nothing until you
 * tick"). Same fixture shape as soldBalesSupplyCard.test.js.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5151';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');

const SRC = path.join(__dirname, '..', '..', 'src');
const flow = require(path.join(SRC, 'flows/soldBalesFlow'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));
const ephemeralDocs = require(path.join(SRC, 'services/ephemeralDocs'));

designAssetsRepository.findActive = async () => null;
unitDisplayService.getThanVisibilityWarehouses = async () => new Set(['kano office']);
ephemeralDocs.sweep = async () => {};

const GRANTS = { 4242: ['Kano office'], 5151: [] };
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: 'X', status: 'active', store_sales_places: GRANTS[id] || [] });

function soldRow(pkg, design, shade, thanNo, opts = {}) {
  return {
    packageNo: String(pkg), design, shade: String(shade), thanNo,
    yards: opts.yards ?? 30, pricePerYard: 1250, status: 'sold',
    soldTo: opts.customer ?? 'OKESON', soldDate: opts.date ?? '2026-07-22',
    warehouse: opts.wh ?? 'IDUMOTA', baleUid: `U-${pkg}`,
  };
}

/**
 * OKESON bought from IDUMOTA (1057, 1062) AND from Kano office (846) on
 * 22 Jul; ABBA bought only at IDUMOTA; MUSA only at Kano office on 20 Jul.
 */
const WORLD = [
  soldRow('1057', '77008', '5', 1), soldRow('1057', '77008', '5', 2),
  soldRow('1062', '77008', '3', 1),
  soldRow('846', '77014', '3', 1, { wh: 'Kano office' }),
  soldRow('999', '9060-A', '', 1, { customer: 'ABBA' }),
  soldRow('555', '77008', '5', 1, { customer: 'MUSA', wh: 'kano office', date: '2026-07-20' }),
];
inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(WORLD));
inventoryRepository.getSoldRows = async () => JSON.parse(JSON.stringify(WORLD));
// Two bills for OKESON on 22 Jul: one raised at IDUMOTA, one at Kano office.
approvalQueueRepository.getResolved = async () => [
  { requestId: 'RQ-1', status: 'approved', actionJSON: { action: 'sale_bundle', customer: 'OKESON', salesDate: '2026-07-22', warehouse: 'IDUMOTA', sale_doc_file_id: 'DOC-IDU' } },
  { requestId: 'RQ-2', status: 'approved', actionJSON: { action: 'sale_bundle', customer: 'OKESON', salesDate: '2026-07-22', warehouse: 'Kano office', sale_doc_file_id: 'DOC-KANO' } },
];

function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}
function kbTexts(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup);
  const kb = c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => `${b.text}|${b.callback_data}`);
}
async function tap(bot, uid, data) {
  return flow.handleCallback(bot, { id: 'q', data, from: { id: uid }, message: { chat: { id: 1 }, message_id: 55 } });
}

test.beforeEach(() => { sessionStore.clear('777'); sessionStore.clear('4242'); sessionStore.clear('5151'); });

test('an admin still sees every customer across every warehouse', async () => {
  const bot = createFakeBot();
  await flow.start(bot, 1, '777', 55);
  const chips = kbTexts(bot).filter((t) => t.startsWith('👤'));
  // Newest buyer first, name breaks the tie; the Kano than reads as a than (TV-8).
  assert.deepEqual(chips.map((t) => t.split('|')[0]), ['👤 ABBA · 1B', '👤 OKESON · 2B + 1t', '👤 MUSA · 1t']);
  assert.equal(sessionStore.get('777')._scope, null);
});

test('a Kano-only employee sees only Kano buyers, Kano days, Kano goods — and only the Kano bill', async () => {
  const bot = createFakeBot();
  await flow.start(bot, 1, '4242', 55);
  const chips = kbTexts(bot).filter((t) => t.startsWith('👤'));
  assert.deepEqual(chips.map((t) => t.split('|')[0]), ['👤 OKESON · 1t', '👤 MUSA · 1t'], 'ABBA (IDUMOTA only) is absent; OKESON shows only the Kano than');
  assert.deepEqual(sessionStore.get('4242')._scope, ['KANO OFFICE']);

  await tap(bot, '4242', 'sbl:c:0');            // OKESON
  assert.match(lastText(bot), /Total: \*1t\* · \*30\* yds\nacross \*1\* supply day/);
  assert.equal(kbTexts(bot)[0], '22 Jul 2026 — 1t (30 yds)|sbl:d:0');

  await tap(bot, '4242', 'sbl:d:0');
  const card = lastText(bot);
  assert.match(card, /🧾 \*OKESON\* · 22 Jul 2026\n_1t supplied_/);
  assert.match(card, /🧵 \*77014\*\n • Shade 3 ×1t \(846\)/);
  assert.ok(!/77008|1057|1062/.test(card), 'the IDUMOTA bales never appear');
  assert.deepEqual(sessionStore.get('4242')._docs, [{ fileId: 'DOC-KANO', kind: 'document' }], 'the IDUMOTA bill is not offered');
  assert.equal(kbTexts(bot)[0], '📄 Sale doc|sbl:doc');

  await tap(bot, '4242', 'sbl:full');
  const detail = lastText(bot);
  assert.match(detail, /846/);
  assert.ok(!/1057|1062/.test(detail));
});

test('an employee with nothing ticked is refused in one line and gets no session', async () => {
  const bot = createFakeBot();
  await flow.start(bot, 1, '5151', 55);
  assert.equal(lastText(bot), '📒 No store is assigned to you — ask an admin.');
  assert.equal(sessionStore.get('5151'), null);
});

test('scopedSoldRows: no scope on the session = every row (the Supply Ledger\'s reuse of the day card)', async () => {
  const rows = await flow._internals.scopedSoldRows({ type: 'supply_ledger_flow' });
  assert.equal(rows.length, WORLD.length);
  const kano = await flow._internals.scopedSoldRows({ _scope: ['KANO OFFICE'] });
  assert.deepEqual(kano.map((r) => r.packageNo), ['846', '555']);
});
