'use strict';

/**
 * TV-9b (owner, 23-Nov-2026 — "Go with all your recommendations") — the 📦
 * Supply Request's DESIGN and SHADE screens of a than-selling store count
 * what the store holds the TV-9 way: a closed bale (every than of it still
 * available there) is 1B, an opened bale's remaining thans are t. The
 * opening half ("what was received for that slice") uses the same grammar:
 * a bale whose every than belongs to the slice is 1B, anything less its
 * thans — so one shade of a multi-colour bale reads 1t, never 1B.
 *
 *   header   📊 4B + 17t / 8B _(remaining / opening)_
 *   design   9006 (1B + 3t / 3B)
 *   shade    RED (1B / 1B) · BLUE (4t / 1B) · K6 shades (1t / 1t)
 *   Take ALL ✅ Take ALL 2 shades (1B + 4t)
 *
 * A store that is NOT than-selling keeps its bales pair (§6c: "2B / 2B").
 * The 🚚 In transit chip and the quantity card are not touched.
 *
 * Fixture (every than 30 yd, container Jul26, no GRN unless named):
 *   Kano office (than-selling)
 *     9006 BLACK  801 5/5 available · 802 3 of 5 (2 sold) · 803 0 of 5
 *     K6          810 six thans, six shades, one each — PINK + GREY sold
 *     9045        RED 820 5/5 · BLUE 821 4 of 5 (1 sold)
 *     T5          830 4/4 · 831 3 of 4 — GRN-received at Lagos, so Kano
 *                 has no opening for it (single figure)
 *     LONGDESIGN-ABCDEFGHIJ  840 5/5 · 841 3 of 5 (21-char name)
 *   IDUMOTA
 *     9006 BLACK  901 5/5 · 902 4 of 5
 *     9045        RED 920 3 of 5 · BLUE 921 5/5
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
const designAssetsService = require(path.join(SRC, 'services/designAssetsService'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const goodsReceiptsRepository = require(path.join(SRC, 'repositories/goodsReceiptsRepository'));
const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));

const UID = '4242';
const LONG = 'LONGDESIGN-ABCDEFGHIJ';

productTypesRepo.getLabels = async () => ({
  container_label: 'Bale', container_short: 'bls', subunit_label: 'Than', measure_unit: 'yards',
});
designAssetsRepo.findActive = async () => null;
designAssetsService.getPhotoForSend = async () => null;
designAssetsService.getPhotosForSend = async () => [];
designAssetsService.cacheTelegramFileId = async () => {};
settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });
goodsReceiptsRepository.getAll = async () => [{ grn_id: 'GRN-L', warehouse: 'Lagos' }];
unitDisplayService.invalidateCache();

/** One Inventory than. */
function than(design, shade, pkg, thanNo, warehouse, status, extra = {}) {
  return {
    design, shade, warehouse, status, packageNo: pkg, thanNo,
    arrivalBatch: 'Jul26', productType: 'fabric', yards: 30, pricePerYard: 100,
    baleUid: `BAL-${pkg}-${thanNo}`, ...extra,
  };
}
/** A bale of `n` thans of one shade; `soldOf(t)` says which are sold. */
function bale(design, shade, pkg, n, warehouse, soldOf = () => false, extra = {}) {
  return Array.from({ length: n }, (_, i) => than(design, shade, pkg, i + 1, warehouse, soldOf(i + 1) ? 'sold' : 'available', extra));
}
const K6_SHADES = ['RED', 'BLUE', 'GREEN', 'GOLD', 'PINK', 'GREY'];

function fixture() {
  return [
    ...bale('9006', 'BLACK', '801', 5, 'Kano office'),
    ...bale('9006', 'BLACK', '802', 5, 'Kano office', (t) => t <= 2),
    ...bale('9006', 'BLACK', '803', 5, 'Kano office', () => true),
    ...K6_SHADES.map((sh, i) => than('K6', sh, '810', i + 1, 'Kano office', i >= 4 ? 'sold' : 'available')),
    ...bale('9045', 'RED', '820', 5, 'Kano office'),
    ...bale('9045', 'BLUE', '821', 5, 'Kano office', (t) => t === 1),
    ...bale('T5', 'NAVY', '830', 4, 'Kano office', () => false, { grnId: 'GRN-L' }),
    ...bale('T5', 'NAVY', '831', 4, 'Kano office', (t) => t === 1, { grnId: 'GRN-L' }),
    ...bale(LONG, 'CREAM', '840', 5, 'Kano office'),
    ...bale(LONG, 'CREAM', '841', 5, 'Kano office', (t) => t <= 2),
    ...bale('9006', 'BLACK', '901', 5, 'IDUMOTA'),
    ...bale('9006', 'BLACK', '902', 5, 'IDUMOTA', (t) => t === 1),
    ...bale('9045', 'RED', '920', 5, 'IDUMOTA', (t) => t <= 2),
    ...bale('9045', 'BLUE', '921', 5, 'IDUMOTA'),
  ];
}
inventoryRepository.getAll = async () => fixture();

function seed(warehouse, cart = [], extra = {}) {
  sessionStore.set(UID, {
    type: 'supply_req_flow', warehouse, cart, step: 'design', productType: 'fabric', flowMessageId: 50, ...extra,
  });
}
function renders(bot) {
  return bot.calls.filter((c) => ['sendPhoto', 'sendMessage', 'editMessageText', 'editMessageMedia'].includes(c.method)
    && c.args.opts && c.args.opts.reply_markup);
}
function lastRender(bot) { const r = renders(bot); return r[r.length - 1] || null; }
function rowsOf(call) { return call ? call.args.opts.reply_markup.inline_keyboard : []; }
function textOf(call) {
  if (!call) return '';
  return call.args.text || call.args.opts.caption || (call.args.media && call.args.media.caption) || '';
}
function labelsWith(call, prefix) {
  return rowsOf(call).flat().filter((b) => String(b.callback_data).startsWith(prefix)).map((b) => b.text);
}
const headerLine = (text) => (text.split('\n').find((l) => l.startsWith('📊')) || '');

async function designScreen(warehouse, cart = []) {
  seed(warehouse, cart);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));
  return lastRender(bot);
}
async function shadeScreen(warehouse, design, cart = [], extra = {}) {
  seed(warehouse, cart, extra);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`srf_dg:${design}`));
  return { bot, call: lastRender(bot) };
}

/* ── Kano office (than-selling) ─────────────────────────────────────── */

test('Kano office design screen: header pair and every design chip count closed bales as B', async () => {
  const call = await designScreen('Kano office');
  assert.equal(headerLine(textOf(call)), '📊 4B + 17t / 8B _(remaining / opening)_');
  // Sorted by the bale count the picker sums per shade: K6's four shades
  // are four "bales" there (selection logic, not changed by TV-9b).
  assert.deepEqual(labelsWith(call, 'srf_dg:'), [
    'K6 (4t / 1B)', // one bale of six shades, two thans sold
    '9006 (1B + 3t / 3B)',
    '9045 (1B + 4t / 2B)',
    'T5 (1B + 3t)', // no opening here (GRN-received at Lagos) → one figure
    LONG, // "LONGDESIGN-ABCDEFGHIJ (1B + 3t / 2B)" is 36 chars → overflows
  ]);
  assert.ok(textOf(call).includes(`\n${LONG}: 1B + 3t / 2B`), `the overflowing pair moves to the body, got:\n${textOf(call)}`);
});

test('Kano office design screen with one bale of 9006 in the cart: the first bale in sheet order is skipped', async () => {
  const call = await designScreen('Kano office', [{ design: '9006', shade: 'BLACK', quantity: 1 }]);
  assert.equal(headerLine(textOf(call)), '📊 3B + 17t / 8B _(remaining / opening)_');
  assert.equal(labelsWith(call, 'srf_dg:').find((t) => t.startsWith('9006 ')), '9006 (3t / 3B)');
});

test('Kano office shade screen of a two-shade design: shade chips and Take ALL', async () => {
  const { call } = await shadeScreen('Kano office', '9045');
  assert.deepEqual(labelsWith(call, 'srf_sh:'), ['RED (1B / 1B)', 'BLUE (4t / 1B)']);
  assert.deepEqual(labelsWith(call, 'srf_all:'), ['✅ Take ALL 2 shades (1B + 4t)']);
  // Display-only: the payloads still carry the BALE counts.
  assert.deepEqual(rowsOf(call).flat().filter((b) => b.callback_data.startsWith('srf_sh:')).map((b) => b.callback_data),
    ['srf_sh:9045|RED|1', 'srf_sh:9045|BLUE|1']);
});

test('Kano office shade screen with one K6 shade in the cart: it lists as nothing left, Take ALL drops it', async () => {
  const { call } = await shadeScreen('Kano office', 'K6', [{ design: 'K6', shade: 'RED', quantity: 1 }]);
  assert.deepEqual(labelsWith(call, 'srf_sh:'), [
    'BLUE (1t / 1t)', 'GREEN (1t / 1t)', 'GOLD (1t / 1t)',
    'GREY (0B / 1t)', 'PINK (0B / 1t)', 'RED (0B / 1t)',
  ]);
  assert.deepEqual(labelsWith(call, 'srf_all:'), ['✅ Take ALL 3 shades (3t)']);
});

test('Kano office shade screen of a multi-colour bale: one than per shade reads 1t, a sold shade 0B', async () => {
  const { call } = await shadeScreen('Kano office', 'K6');
  assert.deepEqual(labelsWith(call, 'srf_sh:'), [
    'RED (1t / 1t)', 'BLUE (1t / 1t)', 'GREEN (1t / 1t)', 'GOLD (1t / 1t)',
    'GREY (0B / 1t)', 'PINK (0B / 1t)',
  ]);
  assert.deepEqual(labelsWith(call, 'srf_all:'), ['✅ Take ALL 4 shades (4t)']);
});

test('Kano office shade picker: the photo combo, the album picker and the morph-back carry the same chips', async () => {
  const expected = ['RED (1B / 1B)', 'BLUE (4t / 1B)', '✅ Take ALL 2 shades (1B + 4t)'];
  const pick = (call) => rowsOf(call).flat().filter((b) => /^srf_(sh|all):/.test(b.callback_data)).map((b) => b.text);
  const PHOTO = { photo: 'FAKE_FILE_ID', photoSource: 'telegram_file_id', rowIndex: 2 };
  designAssetsRepo.findActive = async () => ({ design: '9045', shades: [] });
  try {
    // Photo combo (one catalogue page).
    designAssetsService.getPhotoForSend = async () => PHOTO;
    let { bot } = await shadeScreen('Kano office', '9045');
    const combo = bot.callsTo('sendPhoto').pop();
    assert.ok(combo, 'the picker went out as a photo combo');
    assert.deepEqual(pick(combo), expected);
    // Morph-back (Back from a shade photo of this design: same message).
    ({ bot } = await shadeScreen('Kano office', '9045', [], { previewMessageId: 77, previewIsPhoto: true, currentDesign: '9045' }));
    const morph = bot.callsTo('editMessageMedia').pop();
    assert.ok(morph, 'the kept combo morphed back to the swatch page');
    assert.deepEqual(pick(morph), expected);
    // Album picker (two catalogue pages: the chips get their own message).
    designAssetsService.getPhotosForSend = async () => [PHOTO, PHOTO];
    designAssetsService.sendDesignAlbum = async () => [91, 92];
    ({ bot } = await shadeScreen('Kano office', '9045'));
    const picker = bot.callsTo('sendMessage').filter((c) => c.args.opts && c.args.opts.reply_markup).pop();
    assert.ok(picker, 'the album picker went out');
    assert.deepEqual(pick(picker), expected);
  } finally {
    designAssetsRepo.findActive = async () => null;
    designAssetsService.getPhotoForSend = async () => null;
    designAssetsService.getPhotosForSend = async () => [];
  }
});

test('Kano office: the 🚚 In transit chip and the quantity card are unchanged', async () => {
  inventoryRepository.getAll = async () => [
    ...fixture(),
    ...bale('9006', 'BLACK', '880', 2, 'Kano office').map((r) => ({ ...r, status: 'in_transit' })),
  ];
  try {
    const call = await designScreen('Kano office');
    assert.equal(rowsOf(call)[0][0].text, '🚚 In transit (2t)');
    seed('Kano office', [], { currentDesign: '9006', step: 'shade' });
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('srf_sh:9006|BLACK|2'));
    const text = textOf(lastRender(bot));
    assert.match(text, /🏭 Kano office · 2B available/, `quantity card still counts bales, got:\n${text}`);
    assert.match(text, /How many bales\?/);
  } finally {
    inventoryRepository.getAll = async () => fixture();
  }
});

/* ── IDUMOTA (sells bales) — §6c: the pair stays in bales ───────────── */

test('IDUMOTA design and shade screens keep the bales pair', async () => {
  const call = await designScreen('IDUMOTA');
  assert.equal(headerLine(textOf(call)), '📊 4B / 4B _(remaining / opening)_');
  assert.deepEqual(labelsWith(call, 'srf_dg:'), ['9006 (2B / 2B)', '9045 (2B / 2B)']);
  const { call: shades } = await shadeScreen('IDUMOTA', '9045');
  assert.deepEqual(labelsWith(shades, 'srf_sh:'), ['RED (1B / 1B)', 'BLUE (1B / 1B)']);
  assert.deepEqual(labelsWith(shades, 'srf_all:'), ['✅ Take ALL 2 shades (2 bales)']);
});
