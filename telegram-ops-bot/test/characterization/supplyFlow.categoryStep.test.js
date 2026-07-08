'use strict';

/**
 * SRF-CAT — Supply Request category step (container → CATEGORY → warehouse).
 *
 * After picking a container the user now gets tappable category chips
 * (Cashmere, Senator, … from Inventory column W) — but only categories that
 * actually have available stock in that container. Uncategorized designs
 * group under "Others" (last). One category = the step auto-skips so the
 * flow feels exactly like before. Everything downstream (warehouse list,
 * design list) is filtered to the chosen category.
 */

process.env.ADMIN_IDS = '777';

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
const designCategoriesRepo = require(path.join(SRC, 'repositories/designCategoriesRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const designAssetsRepo = require(path.join(SRC, 'repositories/designAssetsRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));

productTypesRepo.getLabels = async () => ({
  container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards',
});
designAssetsRepo.findActive = async () => null;
settingsRepository.getAll = async () => ({});

/** One available Inventory row (= one than). */
function row(design, warehouse, packageNo, designCategory) {
  return {
    design, shade: 'cream', warehouse, status: 'available', packageNo,
    arrivalBatch: 'Mar26', designCategory: designCategory || '',
    productType: 'fabric', yards: 50, pricePerYard: 100,
  };
}

/** Mixed container: 2 Cashmere bales + 1 Senator bale + 1 uncategorized. */
function mixedRows() {
  return [
    row('44200', 'Lagos', 'C1', 'Cashmere'),
    row('44200', 'Lagos', 'C2', 'Cashmere'),
    row('80045', 'Kano office', 'S1', 'Senator'),
    row('9006', 'Lagos', 'U1', ''),
  ];
}

function useRows(rows) {
  inventoryRepository.getAll = async () => rows;
  designCategoriesRepo.invalidateCache();
}

function seedContainerStep(uid) {
  sessionStore.set(uid, {
    type: 'supply_req_flow', step: 'container', arrivalBatch: '', cart: [],
    _scopeWarehouses: [], flowMessageId: 50,
  });
}

function cb(data, uid) {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 50 } };
}

/** Flattened button labels of the LAST rendered keyboard. */
function lastKeyboard(bot) {
  const withKb = bot.calls.filter((c) => {
    const opts = c.method === 'editMessageText' ? c.args.opts : (c.args && c.args.opts);
    return ['sendMessage', 'editMessageText'].includes(c.method)
      && opts && opts.reply_markup && opts.reply_markup.inline_keyboard;
  });
  if (!withKb.length) return [];
  const last = withKb[withKb.length - 1];
  const opts = last.method === 'editMessageText' ? last.args.opts : last.args.opts;
  return opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
}

test('mixed container: category chips render with counts, defaults order, Others last', async () => {
  useRows(mixedRows());
  seedContainerStep('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_ct:Mar26', 777));

  assert.match(bot.allText(), /Select category:/);
  const buttons = lastKeyboard(bot);
  const cashmereIdx = buttons.findIndex((t) => /Cashmere \(2 bls\)/.test(t));
  const senatorIdx = buttons.findIndex((t) => /Senator \(1 bls\)/.test(t));
  const othersIdx = buttons.findIndex((t) => /Others \(1 bls\)/.test(t));
  assert.ok(cashmereIdx !== -1, `Cashmere chip missing: ${buttons}`);
  assert.ok(senatorIdx !== -1, `Senator chip missing: ${buttons}`);
  assert.ok(othersIdx !== -1, `Others chip missing: ${buttons}`);
  assert.ok(cashmereIdx < senatorIdx && senatorIdx < othersIdx, `order wrong: ${buttons}`);
  assert.ok(buttons.some((t) => /Back to containers/.test(t)), `back button missing: ${buttons}`);

  const s = sessionStore.get('777');
  assert.equal(s.step, 'category');
});

test('picking Cashmere filters downstream: single warehouse auto-skip, design list Cashmere-only', async () => {
  useRows(mixedRows());
  sessionStore.set('777', {
    type: 'supply_req_flow', step: 'category', arrivalBatch: 'Mar26', cart: [],
    _scopeWarehouses: [], categoryStepShown: true, flowMessageId: 50,
  });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cg:Cashmere', 777));

  // Cashmere lives only in Lagos → warehouse step auto-skips to designs.
  const text = bot.allText();
  assert.match(text, /Warehouse: Lagos/, `got: ${text}`);
  assert.match(text, /Cashmere/, `category missing from header: ${text}`);
  const buttons = lastKeyboard(bot);
  assert.ok(buttons.some((t) => /44200/.test(t)), `44200 missing: ${buttons}`);
  assert.ok(!buttons.some((t) => /9006/.test(t)), `uncategorized 9006 leaked in: ${buttons}`);
  // Single-warehouse + category step shown → back goes to categories.
  assert.ok(buttons.some((t) => /Back to categories/.test(t)), `back target wrong: ${buttons}`);
  assert.equal(sessionStore.get('777').category, 'Cashmere');
});

test('picking Others shows only uncategorized designs', async () => {
  useRows(mixedRows());
  sessionStore.set('777', {
    type: 'supply_req_flow', step: 'category', arrivalBatch: 'Mar26', cart: [],
    _scopeWarehouses: [], categoryStepShown: true, flowMessageId: 50,
  });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cg:__others__', 777));

  const buttons = lastKeyboard(bot);
  assert.ok(buttons.some((t) => /9006/.test(t)), `9006 missing: ${buttons}`);
  assert.ok(!buttons.some((t) => /44200|80045/.test(t)), `categorized designs leaked in: ${buttons}`);
  assert.match(bot.allText(), /Others/, 'header should show the Others label');
});

test('single-category container auto-skips the category step', async () => {
  useRows([row('44200', 'Lagos', 'C1', 'Cashmere'), row('44201', 'Lagos', 'C2', 'Cashmere')]);
  seedContainerStep('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_ct:Mar26', 777));

  const text = bot.allText();
  assert.ok(!/Select category:/.test(text), `category step should be skipped: ${text}`);
  assert.match(text, /Warehouse: Lagos/, `should land on designs: ${text}`);
  const s = sessionStore.get('777');
  assert.equal(s.category, 'Cashmere');
  assert.equal(s.categoryStepShown, false);
});

test('multi-warehouse category: warehouse picker filtered + Back to categories', async () => {
  useRows([
    row('44200', 'Lagos', 'C1', 'Cashmere'),
    row('44300', 'Kano office', 'C2', 'Cashmere'),
    row('80045', 'Idumota', 'S1', 'Senator'),
  ]);
  sessionStore.set('777', {
    type: 'supply_req_flow', step: 'category', arrivalBatch: 'Mar26', cart: [],
    _scopeWarehouses: [], categoryStepShown: true, flowMessageId: 50,
  });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_cg:Cashmere', 777));

  const buttons = lastKeyboard(bot);
  assert.ok(buttons.some((t) => /Lagos/.test(t)), `Lagos missing: ${buttons}`);
  assert.ok(buttons.some((t) => /Kano office/.test(t)), `Kano office missing: ${buttons}`);
  assert.ok(!buttons.some((t) => /Idumota/.test(t)), `Senator-only warehouse leaked in: ${buttons}`);
  assert.ok(buttons.some((t) => /Back to categories/.test(t)), `back target wrong: ${buttons}`);
  assert.match(bot.allText(), /Category: \*?Cashmere/, 'warehouse header should show the category');
});

test('srf_back:category returns to the chip screen and clears the pick', async () => {
  useRows(mixedRows());
  sessionStore.set('777', {
    type: 'supply_req_flow', step: 'warehouse', arrivalBatch: 'Mar26', cart: [],
    _scopeWarehouses: [], category: 'Cashmere', categoryStepShown: true, flowMessageId: 50,
  });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:category', 777));

  assert.match(bot.allText(), /Select category:/);
  const s = sessionStore.get('777');
  assert.equal(s.category, undefined);
  assert.equal(s.step, 'category');
});
