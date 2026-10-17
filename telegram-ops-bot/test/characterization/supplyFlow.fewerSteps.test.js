'use strict';

/**
 * SRF-5 — Supply Request opens on the STORE, every container and category
 * in; container and category are two filter chips on the design screen,
 * never steps (owner, 15/17-Oct-2026: "Is there any chance of minimising
 * the drill-down steps?"). Supersedes the SRF-CAT category-step test.
 */

process.env.ADMIN_IDS = '777';

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

productTypesRepo.getLabels = async () => ({
  container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards',
});
designAssetsRepo.findActive = async () => null;
designAssetsRepo.findActivePages = async () => [];
settingsRepository.getAll = async () => ({});

/** One available Inventory row (= one than). */
function row(design, warehouse, packageNo, designCategory, arrivalBatch = 'Mar26') {
  return {
    design, shade: 'cream', warehouse, status: 'available', packageNo,
    arrivalBatch, designCategory: designCategory || '',
    productType: 'fabric', yards: 50, pricePerYard: 100,
  };
}

/** Two stores, two containers: Lagos holds Cashmere (Mar26) + an uncategorised design (Jul26); Kano holds Senator (Jul26). */
function rows() {
  return [
    row('44200', 'Lagos', 'C1', 'Cashmere', 'Mar26'),
    row('44200', 'Lagos', 'C2', 'Cashmere', 'Mar26'),
    row('9006', 'Lagos', 'U1', '', 'Jul26'),
    row('80045', 'Kano office', 'S1', 'Senator', 'Jul26'),
  ];
}

function useRows(r) {
  inventoryRepository.getAll = async () => r;
  designCategoriesRepo.invalidateCache();
}

/** Flattened button labels of the LAST rendered keyboard. */
function lastKeyboard(bot) {
  const withKb = bot.calls.filter((c) => {
    const opts = c.args && c.args.opts;
    return ['sendMessage', 'editMessageText'].includes(c.method)
      && opts && opts.reply_markup && opts.reply_markup.inline_keyboard;
  });
  if (!withKb.length) return [];
  return withKb[withKb.length - 1].args.opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
}
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text;

test('the tile opens on the STORE — no container screen, every store chip says what it holds', async () => {
  useRows(rows());
  sessionStore.clear('777');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:supply_request', '777', 5));
  const text = bot.allText();
  assert.ok(!/Select container/.test(text), `container step must be gone: ${text}`);
  assert.match(lastText(bot), /^📦 \*Supply Request\*\nTotal: 4 bls · 200 yds\n\nSelect warehouse:$/);
  const buttons = lastKeyboard(bot);
  assert.ok(buttons.some((t) => /^🏭 Lagos · 3B$/.test(t)), `Lagos chip with its holding: ${buttons}`);
  assert.ok(buttons.some((t) => /^🏭 Kano office · 1[Bt]$/.test(t)), `Kano chip with its holding: ${buttons}`);
  assert.ok(buttons.includes('🏠 Back to menu'), `the way back is the menu: ${buttons}`);
  const s = sessionStore.get('777');
  assert.equal(s.step, 'warehouse');
  assert.equal(s.arrivalBatch, '', 'all containers in');
});

test('the design screen: header says All containers, the two filter chips sit on top, every design of every container is listed', async () => {
  useRows(rows());
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_wh:Lagos', '777', 5));
  assert.match(lastText(bot), /^🏭 \*Lagos\* · 🚢 All containers\n/);
  const buttons = lastKeyboard(bot);
  assert.equal(buttons[0], '🚢 Container ▾');
  assert.equal(buttons[1], '🏷 Category ▾');
  assert.ok(buttons.some((t) => /^44200/.test(t)) && buttons.some((t) => /^9006/.test(t)), `both containers' designs: ${buttons}`);
  assert.ok(buttons.includes('⬅️ Back to warehouses'), `back to the store list: ${buttons}`);
  assert.ok(!buttons.some((t) => /containers|categories/.test(t)), `no Back to containers / categories: ${buttons}`);
});

test('🏷 Category ▾ → chips with counts, All ticked; a pick narrows the list in place and shows on the chip; All restores', async () => {
  useRows(rows());
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_fc:cg', '777', 5));
  assert.match(lastText(bot), /^🏭 \*Lagos\* · 🚢 All containers\n\nWhich category\?$/);
  let buttons = lastKeyboard(bot);
  assert.deepEqual(buttons.slice(0, 3), ['All ✓', '🧶 Cashmere (2 bls)', '📦 Others (1 bls)'].map((t) => t.replace('🧶 ', buttons[1].slice(0, buttons[1].indexOf(' ') + 1))));
  assert.equal(buttons[buttons.length - 1], '⬅️ Back to designs');

  await controller.handleCallbackQuery(bot, cb('srf_cg:Cashmere', '777', 5));
  assert.match(lastText(bot), /^🏭 \*Lagos\* · 🚢 All containers · Cashmere\n/);
  buttons = lastKeyboard(bot);
  assert.equal(buttons[1], '🏷 Cashmere ▾');
  assert.ok(buttons.some((t) => /^44200/.test(t)) && !buttons.some((t) => /^9006/.test(t)), `Cashmere only: ${buttons}`);
  assert.equal(sessionStore.get('777').step, 'design');

  await controller.handleCallbackQuery(bot, cb('srf_fc:cg', '777', 5));
  assert.ok(lastKeyboard(bot).some((t) => /Cashmere \(2 bls\) ✓$/.test(t)), 'the live pick is ticked');
  await controller.handleCallbackQuery(bot, cb('srf_cg:*', '777', 5));
  buttons = lastKeyboard(bot);
  assert.equal(buttons[1], '🏷 Category ▾');
  assert.ok(buttons.some((t) => /^9006/.test(t)), `everything back: ${buttons}`);
  assert.equal(sessionStore.get('777').category, undefined);
});

test('🚢 Container ▾ → the admin value block, All ticked; a pick narrows and names itself in the header; All restores', async () => {
  useRows(rows());
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_fc:ct', '777', 5));
  const text = lastText(bot);
  assert.match(text, /^🏭 \*Lagos\* · 🚢 All containers\n💰 \*Total: 150 yds · 15,000\*\n· Mar26: 100 yds · 10,000\n· Jul26: 50 yds · 5,000\n\nWhich container\?$/, text);
  let buttons = lastKeyboard(bot);
  assert.equal(buttons[0], '🌐 All ✓');
  assert.ok(buttons.includes('🚢 Mar26 (2 bls · 2 thans)') && buttons.includes('🚢 Jul26 (1 bls · 1 thans)'), String(buttons));

  await controller.handleCallbackQuery(bot, cb('srf_ct:Jul26', '777', 5));
  assert.match(lastText(bot), /^🏭 \*Lagos\* · 🚢 Jul26\n/);
  buttons = lastKeyboard(bot);
  assert.equal(buttons[0], '🚢 Jul26 ▾');
  assert.ok(buttons.some((t) => /^9006/.test(t)) && !buttons.some((t) => /^44200/.test(t)), `Jul26 only: ${buttons}`);
  assert.ok(!buttons.includes('🏷 Category ▾'), `one category under Jul26 at Lagos → no category chip: ${buttons}`);

  await controller.handleCallbackQuery(bot, cb('srf_ct:*', '777', 5));
  assert.match(lastText(bot), /^🏭 \*Lagos\* · 🚢 All containers\n/);
  assert.ok(lastKeyboard(bot).some((t) => /^44200/.test(t)));
  assert.equal(sessionStore.get('777').arrivalBatch, '');
});

test('a Cashmere pick is dropped when the container chosen next has no Cashmere', async () => {
  useRows(rows());
  const s = sessionStore.get('777');
  s.category = 'Cashmere'; sessionStore.set('777', s);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_ct:Jul26', '777', 5));
  assert.equal(sessionStore.get('777').category, undefined, 'no empty list behind a stale filter');
  assert.ok(lastKeyboard(bot).some((t) => /^9006/.test(t)));
});

test('a single-store seller lands straight on designs; the way back is the menu; an old Back to containers tap lands on the store step', async () => {
  useRows(rows());
  sessionStore.set('777', { type: 'supply_req_flow', step: 'warehouse', arrivalBatch: '', cart: [], _scopeWarehouses: ['Lagos'], flowMessageId: 50 });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:container', '777', 50));
  assert.match(lastText(bot), /^🏭 \*Lagos\* · 🚢 All containers\n/, 'auto-skipped the one-store list');
  const buttons = lastKeyboard(bot);
  assert.ok(buttons.includes('🏠 Back to menu') && buttons.includes('❌ Cancel'), String(buttons));
  assert.equal(sessionStore.get('777').multiWarehouse, false);
});

test('a container tap from a card sent before SRF-5 (no store yet) lands on the store step with the container as a filter', async () => {
  useRows(rows());
  sessionStore.set('777', { type: 'supply_req_flow', step: 'container', arrivalBatch: '', cart: [], _scopeWarehouses: [], flowMessageId: 50 });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_ct:Mar26', '777', 50));
  // Only Lagos holds Mar26, so the store step auto-skips to its designs,
  // with the old tap's container kept as the filter.
  assert.match(lastText(bot), /^🏭 \*Lagos\* · 🚢 Mar26\n/, lastText(bot));
  assert.ok(lastKeyboard(bot).some((t) => /^44200/.test(t)) && !lastKeyboard(bot).some((t) => /^9006/.test(t)), String(lastKeyboard(bot)));
  assert.equal(sessionStore.get('777').arrivalBatch, 'Mar26');
  assert.equal(sessionStore.get('777').step, 'design');
});
