'use strict';

/**
 * TV-1/TV-3/TV-4/TV-5 — "remaining / opening" browse display (Supply Request).
 *
 * Warehouses listed in Settings THAN_VISIBILITY_WAREHOUSES (default
 * "Kano office") show the "remaining / opening" pair (TV-4) — each side in
 * the TV-4b COMPACT "<N>B=<M>t" format (no spaces around "=") — in the
 * design list, the header Total and the shade buttons. TV-5: every OTHER
 * warehouse shows the same pair in its own unit, bales only — "<N>B / <M>B"
 * — with identical behavior. One design/shade per keyboard row everywhere;
 * a composed label over 34 chars drops the pair from the button and parks
 * it as a body line instead (TV-4b safety net, all warehouses).
 * Opening counts EVERY inventory row for the slice regardless of status,
 * so fully-sold designs/shades stay on screen as tappable "(0B=0t / NB=Mt)"
 * (than-visible) / "(0B / NB)" (bales-only) info buttons that can never add
 * to the cart. The "Take ALL" shortcut keeps the remaining-only formats:
 * SPACED TV-3 "NB = Mt" (than-visible), "N bales" (bales-only).
 * Display-only: srf_sh callback payloads stay in bales.
 *
 * Fixture (per warehouse):
 *   9043B available: cream P1 (3 thans) + P2 (2 thans) → 2B = 5t
 *                    ash   P3 (4 thans)                → 1B = 4t
 *   9043B sold:      cream P4 (3 thans)   → cream opening 3B = 8t
 *   9006  sold-out:  black P9 (3 thans, sold) + gold P10 (2 thans, in_transit)
 *                    → design opening 2B = 5t, remaining 0
 *
 * Drives the real controller; sheets/intent/bot are faked.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

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
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const designAssetsRepo = require(path.join(SRC, 'repositories/designAssetsRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));

const UID = '4242';

productTypesRepo.getLabels = async () => ({
  container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards',
});
designAssetsRepo.findActive = async () => null;
settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
unitDisplayService.invalidateCache();

/** One row per than; thans of the same bale share a packageNo. */
function fixtureRows(warehouse) {
  const mk = (design, pkg, shade, n, status) => Array.from({ length: n }, () => ({
    design, shade, warehouse, status, packageNo: pkg, productType: 'fabric',
  }));
  return [
    ...mk('9043B', 'P1', 'cream', 3, 'available'),
    ...mk('9043B', 'P2', 'cream', 2, 'available'),
    ...mk('9043B', 'P3', 'ash', 4, 'available'),
    // Sold history for 9043B cream → opening 3B = 8t vs remaining 2B = 5t.
    ...mk('9043B', 'P4', 'cream', 3, 'sold'),
    // 9006 is fully out (mixed non-available statuses) → 0 remaining,
    // opening 2B = 5t. Must stay tappable on than-visible warehouses only.
    ...mk('9006', 'P9', 'black', 3, 'sold'),
    ...mk('9006', 'P10', 'gold', 2, 'in_transit'),
  ];
}
function seed(warehouse) {
  sessionStore.set(UID, { type: 'supply_req_flow', warehouse, cart: [], step: 'design', productType: 'fabric', flowMessageId: 50 });
}
function lastRender(bot) {
  const withKb = bot.calls.filter((c) => ['sendPhoto', 'sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  return withKb[withKb.length - 1] || null;
}
function lastKeyboardRows(bot) {
  const last = lastRender(bot);
  return last ? last.args.opts.reply_markup.inline_keyboard : [];
}
function lastKeyboardButtons(bot) {
  return lastKeyboardRows(bot).flat();
}
function lastKeyboardTexts(bot) {
  return lastKeyboardButtons(bot).map((b) => b.text);
}
function lastKeyboardCallbacks(bot) {
  return lastKeyboardButtons(bot).map((b) => b.callback_data);
}
function lastText(bot) {
  const last = lastRender(bot);
  return last ? (last.args.text || last.args.opts.caption || '') : '';
}

test('Kano office: shade buttons show remaining / opening; Take ALL stays remaining-only', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Kano office');
  seed('Kano office');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9043B'));
  const texts = lastKeyboardTexts(bot);
  assert.ok(texts.some((t) => t.includes('cream (2B=5t / 3B=8t)')), `cream shows 2B=5t / 3B=8t, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('ash (1B=4t / 1B=4t)')), `ash shows 1B=4t / 1B=4t, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('Take ALL 2 shades (3B = 9t)')), `Take ALL keeps remaining-only SPACED 3B = 9t, got: ${texts}`);
  // Display-only: the shade callback payload still carries the BALE count.
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(cbs.includes('srf_sh:9043B|cream|2'), 'cream callback still carries 2 bales');
  assert.ok(cbs.includes('srf_sh:9043B|ash|1'), 'ash callback still carries 1 bale');
  // TV-4b — pair-carrying shade buttons are ONE per row (full width).
  const shadeRows = lastKeyboardRows(bot).filter((r) => r.some((b) => b.callback_data.startsWith('srf_sh:')));
  assert.ok(shadeRows.length >= 2, `expected at least 2 shade rows, got: ${shadeRows.length}`);
  assert.ok(shadeRows.every((r) => r.length === 1), `each pair-carrying shade row has exactly 1 button, got: ${shadeRows.map((r) => r.length)}`);
});

test('Kano office: design list shows remaining / opening, legend, and a tappable sold-out design', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Kano office');
  seed('Kano office');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));
  const texts = lastKeyboardTexts(bot);
  assert.ok(texts.some((t) => t.includes('9043B (3B=9t / 4B=12t)')), `design tile shows 3B=9t / 4B=12t, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('9006 (0B=0t / 2B=5t)')), `sold-out design stays listed as 0B=0t / 2B=5t, got: ${texts}`);
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(cbs.includes('srf_dg:9006'), 'sold-out design button is TAPPABLE (srf_dg:9006)');
  // Sold-out designs sort AFTER in-stock designs.
  assert.ok(cbs.indexOf('srf_dg:9006') > cbs.indexOf('srf_dg:9043B'), `9006 listed after 9043B, got: ${cbs}`);
  // TV-4b — ONE design per row: every keyboard row up to the nav/back rows
  // holds exactly one (srf_dg:) button.
  const dgRows = lastKeyboardRows(bot).filter((r) => r.some((b) => b.callback_data.startsWith('srf_dg:')));
  assert.equal(dgRows.length, 2, `two design rows (9043B + 9006), got: ${dgRows.length}`);
  assert.ok(dgRows.every((r) => r.length === 1), `each design row has exactly 1 button, got: ${dgRows.map((r) => r.length)}`);
  // Header + legend.
  const text = lastText(bot);
  assert.match(text, /Total: 3B=9t \/ 6B=17t/, `header Total is remaining / opening, got: ${text}`);
  assert.match(text, /_\(remaining \/ opening\)_/, `legend under Select design:, got: ${text}`);
});

test('Kano office: >34-char design label — bare button, pair moves to the body (TV-4b)', async () => {
  const LONG = '9043-VERY-LONG-DESIGN-NAME';
  inventoryRepository.getAll = async () => [
    ...fixtureRows('Kano office'),
    // 1 bale / 3 thans, all available → pair "1B=3t / 1B=3t"; composed label
    // is 42 chars (> 34) so the button carries the bare design name only.
    ...Array.from({ length: 3 }, () => ({
      design: LONG, shade: 'cream', warehouse: 'Kano office', status: 'available', packageNo: 'PL1', productType: 'fabric',
    })),
  ];
  seed('Kano office');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));
  const buttons = lastKeyboardButtons(bot);
  const longBtn = buttons.find((b) => b.callback_data === `srf_dg:${LONG}`);
  assert.ok(longBtn, `long design still tappable, got: ${buttons.map((b) => b.callback_data)}`);
  assert.equal(longBtn.text, LONG, `overflowing button shows the bare design name, got: ${longBtn.text}`);
  // The full pair line lands in the card body instead (wraps, never clips).
  const text = lastText(bot);
  assert.ok(text.includes(`${LONG}: 1B=3t / 1B=3t`), `body carries the pair line, got: ${text}`);
  // Short labels keep the pair ON the button.
  assert.ok(buttons.some((b) => b.text === '9043B (3B=9t / 4B=12t)'), 'short design label keeps its inline pair');
});

test('Kano office: tapping the sold-out design renders an info shade screen, nothing addable', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Kano office');
  seed('Kano office');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9006'));
  const texts = lastKeyboardTexts(bot);
  assert.ok(texts.some((t) => t.includes('black (0B=0t / 1B=3t)')), `black shows 0B=0t / 1B=3t, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('gold (0B=0t / 1B=2t)')), `gold shows 0B=0t / 1B=2t, got: ${texts}`);
  const text = lastText(bot);
  assert.match(text, /Sold out — nothing available to add/, `sold-out note shown, got: ${text}`);
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(!cbs.some((c) => c && c.startsWith('srf_all:')), `no Take ALL on a sold-out design, got: ${cbs}`);
  assert.ok(cbs.includes('srf_back:design'), 'back button present');
});

test('Kano office: tapping a sold-out shade lands on the sold-out guard — no qty chips, no custom', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Kano office');
  seed('Kano office');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sh:9006|black|0'));
  const text = lastText(bot);
  assert.match(text, /Sold out — nothing available to add/, `guard note shown, got: ${text}`);
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(!cbs.some((c) => c && c.startsWith('srf_qty:')), `no qty chips (incl. Custom) offered at 0 available, got: ${cbs}`);
  assert.ok(cbs.includes('srf_back:shade'), 'back to shades offered');
});

test('Lagos (bales-only, TV-5): shade buttons show "remaining / opening" in BALES, one per row', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Lagos');
  seed('Lagos');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9043B'));
  const texts = lastKeyboardTexts(bot);
  assert.ok(texts.some((t) => t.includes('cream (2B / 3B)')), `cream shows 2B / 3B, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('ash (1B / 1B)')), `ash shows 1B / 1B, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('Take ALL 2 shades (3 bales)')), `Take ALL keeps remaining-only bales, got: ${texts}`);
  // Display-only: the shade callback payload still carries the BALE count.
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(cbs.includes('srf_sh:9043B|cream|2'), 'cream callback still carries 2 bales');
  assert.ok(cbs.includes('srf_sh:9043B|ash|1'), 'ash callback still carries 1 bale');
  // TV-5 — pair-carrying shade buttons are ONE per row here too.
  const shadeRows = lastKeyboardRows(bot).filter((r) => r.some((b) => b.callback_data.startsWith('srf_sh:')));
  assert.ok(shadeRows.length >= 2, `expected at least 2 shade rows, got: ${shadeRows.length}`);
  assert.ok(shadeRows.every((r) => r.length === 1), `each shade row has exactly 1 button, got: ${shadeRows.map((r) => r.length)}`);
});

test('Lagos (bales-only, TV-5): design list shows bales pair, legend, and a tappable sold-out design', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Lagos');
  seed('Lagos');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));
  const texts = lastKeyboardTexts(bot);
  assert.ok(texts.some((t) => t.includes('9043B (3B / 4B)')), `design tile shows 3B / 4B, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('9006 (0B / 2B)')), `sold-out design stays listed as 0B / 2B, got: ${texts}`);
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(cbs.includes('srf_dg:9006'), 'sold-out design button is TAPPABLE (srf_dg:9006)');
  assert.ok(cbs.indexOf('srf_dg:9006') > cbs.indexOf('srf_dg:9043B'), `9006 listed after 9043B, got: ${cbs}`);
  // TV-5 — ONE design per row on bales-only warehouses too.
  const dgRows = lastKeyboardRows(bot).filter((r) => r.some((b) => b.callback_data.startsWith('srf_dg:')));
  assert.equal(dgRows.length, 2, `two design rows (9043B + 9006), got: ${dgRows.length}`);
  assert.ok(dgRows.every((r) => r.length === 1), `each design row has exactly 1 button, got: ${dgRows.map((r) => r.length)}`);
  // Header + legend, bales-only pair.
  const text = lastText(bot);
  assert.match(text, /Total: 3B \/ 6B/, `header Total is remaining / opening in bales, got: ${text}`);
  assert.match(text, /_\(remaining \/ opening\)_/, `legend shown on bales-only warehouse, got: ${text}`);
});

test('Lagos (bales-only, TV-5): >34-char design label — bare button, pair moves to the body', async () => {
  const LONG = '9043-VERY-LONG-DESIGN-NAME';
  inventoryRepository.getAll = async () => [
    ...fixtureRows('Lagos'),
    // 1 bale available → pair "1B / 1B"; composed label is 36 chars (> 34)
    // so the button carries the bare design name only.
    ...Array.from({ length: 3 }, () => ({
      design: LONG, shade: 'cream', warehouse: 'Lagos', status: 'available', packageNo: 'PL1', productType: 'fabric',
    })),
  ];
  seed('Lagos');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));
  const buttons = lastKeyboardButtons(bot);
  const longBtn = buttons.find((b) => b.callback_data === `srf_dg:${LONG}`);
  assert.ok(longBtn, `long design still tappable, got: ${buttons.map((b) => b.callback_data)}`);
  assert.equal(longBtn.text, LONG, `overflowing button shows the bare design name, got: ${longBtn.text}`);
  const text = lastText(bot);
  assert.ok(text.includes(`${LONG}: 1B / 1B`), `body carries the bales pair line, got: ${text}`);
  // Short labels keep the pair ON the button.
  assert.ok(buttons.some((b) => b.text === '9043B (3B / 4B)'), 'short design label keeps its inline pair');
});

test('Lagos (bales-only, TV-5): sold-out design → info shade screen, sold-out shade → quantity guard', async () => {
  inventoryRepository.getAll = async () => fixtureRows('Lagos');
  seed('Lagos');
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9006'));
  const texts = lastKeyboardTexts(bot);
  assert.ok(texts.some((t) => t.includes('black (0B / 1B)')), `black shows 0B / 1B, got: ${texts}`);
  assert.ok(texts.some((t) => t.includes('gold (0B / 1B)')), `gold shows 0B / 1B, got: ${texts}`);
  assert.match(lastText(bot), /Sold out — nothing available to add/, `sold-out note shown, got: ${lastText(bot)}`);
  const cbs = lastKeyboardCallbacks(bot);
  assert.ok(!cbs.some((c) => c && c.startsWith('srf_all:')), `no Take ALL on a sold-out design, got: ${cbs}`);
  assert.ok(cbs.includes('srf_back:design'), 'back button present');

  // Tapping a sold-out shade lands on the same guard as than-visible warehouses.
  seed('Lagos');
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('srf_sh:9006|black|0'));
  assert.match(lastText(bot2), /Sold out — nothing available to add/, `guard note shown, got: ${lastText(bot2)}`);
  const cbs2 = lastKeyboardCallbacks(bot2);
  assert.ok(!cbs2.some((c) => c && c.startsWith('srf_qty:')), `no qty chips (incl. Custom) at 0 available, got: ${cbs2}`);
  assert.ok(cbs2.includes('srf_back:shade'), 'back to shades offered');
});
