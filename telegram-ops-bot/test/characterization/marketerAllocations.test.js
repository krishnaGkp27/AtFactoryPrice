'use strict';

/**
 * MKT-2 — marketer allocations + category-first My Products.
 *
 *   admin: 🧑‍💼 Allocate to Marketer → marketer → design → qty → Save
 *          → MarketerAllocations row + DM to the marketer.
 *   marketer: 📦 My Products → tappable category chips (from allocated
 *          designs only) → tap → designs with allocated qty.
 *   salesman: keeps the classic warehouse catalog (unchanged path).
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = 'mkt1,sal1';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, kbTexts: lastKb } = require('../helpers/charFixture');

/** 23-column Inventory row (A..W); design [3], status [7], warehouse [8], category [22]. */
function invRow(pkg, design, category = '', wh = 'Lagos') {
  return [pkg, '', '', design, '1', '1', '100', 'available', wh, '0', '2026-07-01',
    '', '', '', '', '', 'fabric', `UID-${pkg}`, '2026-07-01', '', '', '', category];
}

const fakeSheets = createFakeSheets({
  Inventory: [
    ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
      'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
      'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'],
    invRow('P1', '44200', 'Cashmere'),
    invRow('P2', '44200', 'Cashmere'),
    invRow('P3', '9006', ''),
  ],
  MarketerAllocations: [
    ['marketer_id', 'marketer_name', 'design', 'allocated_qty', 'updated_by', 'updated_at', 'notes'],
  ],
});
installFakeSheets(fakeSheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const marketerAllocationsRepository = require(path.join(SRC, 'repositories/marketerAllocationsRepository'));

auditLogRepository.append = async () => {};
usersRepository.getAll = async () => [
  { user_id: 'mkt1', name: 'Musa Marketer', role: 'marketer', status: 'active', warehouses: [] },
  { user_id: 'sal1', name: 'Sani Salesman', role: 'salesman', status: 'active', warehouses: ['Lagos'] },
];
usersRepository.findByUserId = async (id) => (await usersRepository.getAll())
  .find((u) => u.user_id === String(id)) || { user_id: String(id), name: String(id) };


test('admin allocates 44200 — ×10 is REFUSED by the §16 cap, ×2 saves with sheet row + DM', async () => {
  sessionStore.clear('777');
  let bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:allocate_marketer', 777));
  assert.ok(lastKb(bot).some((b) => b.includes('Musa Marketer|mal:mk:0')), 'marketer chip listed');

  await controller.handleCallbackQuery(bot, cb('mal:mk:0', 777));   // Musa
  const designChips = lastKb(bot);
  assert.ok(designChips.some((b) => b.startsWith('44200 · Cashmere|')), 'design chip carries category');

  await controller.handleCallbackQuery(bot, cb('mal:dg:0', 777));   // 44200
  assert.match(bot.allText(), /In stock: 2 bales/);

  // MYP-1 §16 (owner, 23-Aug-2026): the allocation can never exceed what
  // the warehouse actually holds at write time. 10 > 2 → refused, live
  // number named, nothing written, no DM.
  await controller.handleCallbackQuery(bot, cb('mal:q:10', 777));
  await controller.handleCallbackQuery(bot, cb('mal:save', 777));
  assert.match(bot.allText(), /Only 2 bales/);
  assert.equal(fakeSheets._store.get('MarketerAllocations').slice(1).length, 0, 'refused write never reached the sheet');

  // Within the cap it lands: sheet row + the category-labelled DM.
  sessionStore.clear('777');
  bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:allocate_marketer', 777));
  await controller.handleCallbackQuery(bot, cb('mal:mk:0', 777));
  await controller.handleCallbackQuery(bot, cb('mal:dg:0', 777));
  await controller.handleCallbackQuery(bot, cb('mal:q:2', 777));
  await controller.handleCallbackQuery(bot, cb('mal:save', 777));
  assert.match(bot.allText(), /Saved/);

  const rows = fakeSheets._store.get('MarketerAllocations').slice(1);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0][0], rows[0][2], rows[0][3]], ['mkt1', '44200', 2]);

  const dm = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === 'mkt1');
  assert.ok(dm && /allocated.*2 bales.*44200 \(Cashmere\)/s.test(dm.args.text), 'marketer DM sent');
  sessionStore.clear('777');
});

test("marketer's My Products opens with tappable category chips, then designs + quantities", async () => {
  marketerAllocationsRepository.invalidateCache();
  await marketerAllocationsRepository.setAllocation({
    marketerId: 'mkt1', marketerName: 'Musa Marketer', design: '9006', qty: 4, updatedBy: '777',
  });

  sessionStore.clear('mkt1');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:my_products', 'mkt1'));
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b.startsWith('🧣 Cashmere (1)|mkp:c:')), 'Cashmere chip');
  assert.ok(kb.some((b) => b.includes('Others (1)|mkp:c:')), '9006 is uncategorized → Others chip');

  const cashmereIdx = kb.findIndex((b) => b.startsWith('🧣 Cashmere'));
  const cashmereCb = kb[cashmereIdx].split('|')[1];
  await controller.handleCallbackQuery(bot, cb(cashmereCb, 'mkt1'));
  const text = bot.allText();
  assert.match(text, /\*44200\*/);
  assert.match(text, /Allocated to you: \*2 bales\*/);
  assert.match(text, /Available now: 2 bales/);
  sessionStore.clear('mkt1');
});

test('marketer with no allocations sees the ask-your-admin empty state', async () => {
  const restore = marketerAllocationsRepository.listForMarketer;
  marketerAllocationsRepository.listForMarketer = async () => [];
  sessionStore.clear('mkt1');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:my_products', 'mkt1'));
  assert.match(bot.allText(), /No products have been allocated to you yet/);
  marketerAllocationsRepository.listForMarketer = restore;
  sessionStore.clear('mkt1');
});

test('salesman keeps the classic warehouse catalog (price-visible path unchanged)', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:my_products', 'sal1'));
  const text = bot.allText();
  assert.match(text, /My Products — Lagos/);
  assert.ok(!/Pick a category/.test(text), 'no category screen for salesman');
});

test('employee cannot open the allocation flow', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:allocate_marketer', 'mkt1'));
  assert.match(bot.allText(), /Admin only/);
});
