'use strict';

/**
 * TV-9 (owner, 23-Nov-2026) — what a store HOLDS NOW is counted in bales
 * AND thans, than-selling stores included:
 *
 *   "Make sure the bales which are open will always show in Thans plus the
 *    bales which are closed, showing all the Thans available in that will
 *    be treated as bales with suffix B. So please make this correction for
 *    Kano office, showing both in B and T."
 *
 * Driven through the REAL controller / flows on one fixture:
 *   Kano office (than-selling): 801 closed (5/5 available), 802 opened
 *     (3 of 5 left), 803 sold out (0 of 5);
 *   IDUMOTA: 901 closed (5/5), 902 opened (4 of 5);
 *   Lagos: 951 closed (5/5).
 * Every than 30 yd.
 *
 * Pinned: the three holding surfaces (📦 Supply Request store screen,
 * Check Stock, the Stock-by-shade card's ✅ Available section) switch; the
 * card's 💰 Sold section, 🏬 Store Sales and the Customer Supplies labeller
 * — goods a customer TOOK — do not (TV-8, "packaging wins").
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designCategoriesRepo = require(path.join(SRC, 'repositories/designCategoriesRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const designAssetsRepo = require(path.join(SRC, 'repositories/designAssetsRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));
const locationService = require(path.join(SRC, 'services/locationService'));
const stockByShadeFlow = require(path.join(SRC, 'flows/stockByShadeFlow'));

productTypesRepo.getLabels = async () => ({
  container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards',
});
designAssetsRepo.findActive = async () => null;
designAssetsRepo.findActivePages = async () => [];
settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
unitDisplayService.invalidateCache();

/** One Inventory than. */
function than(pkg, thanNo, warehouse, status, extra = {}) {
  const sold = status === 'sold';
  return {
    design: '9006', shade: 'BLACK', warehouse, status, packageNo: pkg, thanNo,
    arrivalBatch: 'Jul26', designCategory: '', productType: 'fabric',
    yards: 30, pricePerYard: 100, baleUid: `BAL-${pkg}-${thanNo}`,
    soldTo: sold ? (extra.soldTo || 'ABBA') : '', soldDate: sold ? (extra.soldDate || '2026-11-10') : '',
  };
}
const five = (pkg, wh, statusOf) => [1, 2, 3, 4, 5].map((t) => than(pkg, t, wh, statusOf(t)));

function fixture() {
  return [
    ...five('801', 'Kano office', () => 'available'),
    ...five('802', 'Kano office', (t) => (t <= 2 ? 'sold' : 'available')),
    ...five('803', 'Kano office', () => 'sold'),
    ...five('901', 'IDUMOTA', () => 'available'),
    ...five('902', 'IDUMOTA', (t) => (t === 1 ? 'sold' : 'available')),
    ...five('951', 'Lagos', () => 'available'),
  ];
}

function useRows(r) {
  inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(r));
  inventoryRepository.findAvailable = async (f = {}) => JSON.parse(JSON.stringify(
    r.filter((x) => x.status === 'available' && (!f.design || x.design === f.design))));
  inventoryRepository.getSoldRows = async () => JSON.parse(JSON.stringify(r.filter((x) => x.status === 'sold')));
  designCategoriesRepo.invalidateCache();
}

const shown = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
const lastText = (bot) => String(shown(bot).pop().args.text || '');
function lastKeyboard(bot) {
  const withKb = shown(bot).filter((c) => c.args.opts && c.args.opts.reply_markup && c.args.opts.reply_markup.inline_keyboard);
  return withKb.length ? withKb[withKb.length - 1].args.opts.reply_markup.inline_keyboard.flat().map((b) => b.text) : [];
}

/* ── 2a · 📦 Supply Request store screen ───────────────────────────── */

test('supply request store screen: each chip and the Total in bales + thans (Kano office included)', async () => {
  useRows(fixture());
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:supply_request', '777', 5));
  assert.equal(lastText(bot), '📦 *Supply Request*\nTotal: 3B + 7t · 660 yds\n\nSelect warehouse:');
  assert.deepEqual(lastKeyboard(bot), [
    '🏭 IDUMOTA · 1B + 4t',
    '🏭 Kano office · 1B + 3t',
    '🏭 Lagos · 1B',
    '🏠 Back to menu',
  ]);
});

test('supply request store screen: one bale available in two stores reads as thans in each, and the Total is the sum of the chips', async () => {
  // 951 split: thans 1-3 in Lagos, 4-5 in IDUMOTA — loose in each store.
  const rows = fixture().map((r) => (r.packageNo === '951' && r.thanNo >= 4 ? { ...r, warehouse: 'IDUMOTA' } : r));
  useRows(rows);
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:supply_request', '777', 5));
  assert.deepEqual(lastKeyboard(bot), [
    '🏭 IDUMOTA · 1B + 6t',
    '🏭 Kano office · 1B + 3t',
    '🏭 Lagos · 3t',
    '🏠 Back to menu',
  ]);
  // 1B+6t + 1B+3t + 3t = 2B + 12t — never "3B", which would count 951 whole.
  assert.equal(lastText(bot), '📦 *Supply Request*\nTotal: 2B + 12t · 660 yds\n\nSelect warehouse:');
});

/* ── 2b · Check Stock ──────────────────────────────────────────────── */

test('Check Stock: the Available Σ line and the By-shade line count closed bales as B, opened bales as t', async () => {
  useRows(fixture());
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('cks:9006', '777', 5));
  const text = bot.allText();
  assert.ok(text.includes('Available Σ 3B + 7t · 660 yds\n'), text);
  assert.ok(text.includes('  • BLACK · 3B + 7t · 660 yds · Kano office, IDUMOTA, Lagos\n'), text);
});

test('Check Stock: the in-transit line is unchanged', async () => {
  const rows = [
    ...fixture(),
    ...five('960', 'Kano office', () => 'in_transit'),
  ];
  useRows(rows);
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('cks:9006', '777', 5));
  assert.ok(bot.allText().includes('🚚 In transit 1B → Kano office\n'), bot.allText());
});

/* ── 2c · 🎨 Stock by shade card ───────────────────────────────────── */

async function shadeCard(kind) {
  const prev = locationService.kindOf;
  locationService.kindOf = async () => kind;
  try {
    sessionStore.clear('777');
    const bot = createFakeBot();
    await stockByShadeFlow.start(bot, '777', '777', null);
    const s = sessionStore.get('777');
    const wi = s._whs.indexOf('Kano office');
    await stockByShadeFlow.handleCallback(bot, { data: `sds:w:${wi}`, id: 'q', from: { id: '777' }, message: { message_id: 5, chat: { id: '777' } } });
    await stockByShadeFlow.handleCallback(bot, { data: 'sds:d:0', id: 'q', from: { id: '777' }, message: { message_id: 5, chat: { id: '777' } } });
    await stockByShadeFlow.handleCallback(bot, { data: 'sds:s:0', id: 'q', from: { id: '777' }, message: { message_id: 5, chat: { id: '777' } } });
    return lastText(bot);
  } finally {
    locationService.kindOf = prev;
  }
}

test('Stock by shade card at Kano office (a store): ✅ Available header and tags in bales + thans; 💰 Sold unchanged', async () => {
  useRows(fixture());
  const text = await shadeCard('store');
  assert.equal(text, [
    '📦 *9006 — Kano office*',
    'Shade *BLACK*',
    '',
    '✅ *Available — 1B + 3t*',
    '801, 802 (3t)',
    '',
    '💰 *Sold*',
    '10-Nov-26 — ABBA (7t)',
    '802 (2t), 803 (5t)',
  ].join('\n'));
});

test('Stock by shade card at Kano office (a warehouse kind): header still counts bales; tags in bales + thans', async () => {
  useRows(fixture());
  const text = await shadeCard('warehouse');
  assert.ok(text.includes('✅ *Available — 2 Bales*\n801, 802 (3t)\n'), text);
  assert.ok(text.includes('💰 *Sold — 2 Bales*\n10-Nov-26 — ABBA (2B)\n802 (2t), 803 (5t)'), text);
});

/* ── 3 · nothing a customer TOOK moved ─────────────────────────────── */

test('🏬 Store Sales for Kano office still counts the sold thans as 7t (bale 803 whole + 2 of 802)', async () => {
  useRows(fixture());
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:store_sales', '777', 5));
  const kb = shown(bot).pop().args.opts.reply_markup.inline_keyboard.flat();
  const kano = kb.find((b) => b.text === 'Kano office');
  assert.ok(kano, JSON.stringify(kb));
  await controller.handleCallbackQuery(bot, cb(kano.callback_data, '777', 5));
  assert.match(lastText(bot), /Total: \*7t\* · \*210\* yds/);
});

test('the Customer Supplies labeller (no holding option) still counts Kano sold thans as 7t; the same rows held would read 1B + 2t', async () => {
  const all = fixture();
  const label = await unitDisplayService.createQtyLabeller(all);
  const kanoSold = all.filter((r) => r.status === 'sold' && r.warehouse === 'Kano office');
  assert.equal(label(kanoSold), '7t');
  const kanoAvail = all.filter((r) => r.status === 'available' && r.warehouse === 'Kano office');
  assert.equal(label(kanoAvail), '8t', 'without holding: thans only, as before');
  assert.equal(label(kanoSold, { holding: true }), '1B + 2t', 'the holding reading exists, but no sold surface asks for it');
  assert.equal(label(kanoAvail, { holding: true }), '1B + 3t');
});
