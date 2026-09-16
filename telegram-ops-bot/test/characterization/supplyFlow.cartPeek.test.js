'use strict';

/**
 * CART-PEEK (owner, 16-Sep-2026): "When I am selecting the design → shade →
 * quantity from the supply request, I am not able to see what I have
 * selected in the cart already. … keep on selecting the quantity, looking
 * at what I already have in my basket."
 *
 * Pinned: the basket block rides the DESIGN list, the SHADE picker (text
 * and photo-caption forms) and the QUANTITY card; it is the cart card's own
 * lines under a tally header; it is absent when the cart is empty; and on
 * the quantity card it sits above the question, never below it.
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

const UID = '4242';

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsRepo.findActive = async () => null;
designAssetsService.getPhotoForSend = async () => null;
designAssetsService.getPhotosForSend = async () => [];
designAssetsService.cacheTelegramFileId = async () => {};

function rowsFor(design, shades) {
  const out = [];
  for (const [shade, n] of Object.entries(shades)) {
    for (let i = 0; i < n; i += 1) out.push({ design, shade, warehouse: 'Lagos', status: 'available', packageNo: `${design}-${shade}-${i}`, productType: 'fabric' });
  }
  return out;
}
const CART = [{ design: '202/201', shade: '3', shadeName: 'Navy Blue', quantity: 2 }, { design: '9037', shade: '3', shadeName: '', quantity: 1 }];

function seed(step, cart) {
  sessionStore.set(UID, {
    type: 'supply_req_flow', warehouse: 'Lagos', cart: JSON.parse(JSON.stringify(cart)), step, productType: 'fabric',
    flowMessageId: 50, currentDesign: '202/201',
  });
}
/** Every text a screen could have been drawn with: message text or photo caption. */
function screens(bot) {
  // Every way a picker can be drawn — including a MORPH (editMessageMedia),
  // which carries its caption inside the media object.
  return bot.calls
    .filter((c) => ['sendMessage', 'editMessageText', 'sendPhoto', 'editMessageCaption', 'editMessageMedia'].includes(c.method))
    .map((c) => c.args.text || c.args.caption || (c.args.media && c.args.media.caption) || (c.args.opts && c.args.opts.caption) || '');
}
function rowsWithStatus(design, shades, status) {
  return rowsFor(design, shades).map((r) => ({ ...r, status }));
}
const PHOTO = { photo: 'FAKE_FILE_ID', photoSource: 'telegram_file_id', rowIndex: 2 };
function withPhoto(fn) {
  return async () => {
    designAssetsRepo.findActive = async () => ({ design: '202/201', shades: [] });
    designAssetsService.getPhotoForSend = async () => PHOTO;
    try { await fn(); } finally {
      designAssetsRepo.findActive = async () => null;
      designAssetsService.getPhotoForSend = async () => null;
    }
  };
}
const last = (bot) => screens(bot).filter(Boolean).pop() || '';

test('CART-PEEK: the shade picker (text form) shows the basket under the shade list', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 }).concat(rowsFor('9037', { 3: 3 }));
  seed('design', CART);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
  const text = last(bot);
  assert.match(text, /Select shade:/, 'it is the shade picker');
  assert.match(text, /🛒 In cart · Σ 3B/, `tally header, got:\n${text}`);
  assert.match(text, /3 - Navy Blue · 2B/, 'the line already chosen, with its shade name');
  assert.match(text, /9037\n {2}• 3 · 1B/, 'the other design too');
});

test('CART-PEEK: the shade picker as a PHOTO carries the basket in its caption', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  designAssetsRepo.findActive = async () => ({ design: '202/201', shades: [] });
  designAssetsService.getPhotoForSend = async () => ({ photo: 'FAKE_FILE_ID', photoSource: 'telegram_file_id', rowIndex: 2 });
  try {
    seed('design', CART);
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
    const photo = bot.callsTo('sendPhoto').pop();
    assert.ok(photo, 'the picker went out as a photo combo');
    const caption = photo.args.opts.caption;
    assert.match(caption, /📷 \*202\/201\* — \*Lagos\*/, 'the header is untouched');
    assert.match(caption, /🛒 In cart · Σ 3B/, `caption carries the basket, got:\n${caption}`);
    assert.ok(caption.length <= 1024, `Telegram caption budget: ${caption.length}`);
  } finally {
    designAssetsRepo.findActive = async () => null;
    designAssetsService.getPhotoForSend = async () => null;
  }
});

test('CART-PEEK: the quantity card shows the basket ABOVE the question', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('shade', CART);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sh:202/201|1|5'));
  const text = last(bot);
  assert.match(text, /How many bales\?/, 'it is the quantity card');
  const peekAt = text.indexOf('🛒 In cart');
  const askAt = text.indexOf('How many');
  assert.ok(peekAt > -1, `basket on the quantity card, got:\n${text}`);
  assert.ok(peekAt < askAt, 'the question stays nearest the chips');
  assert.match(text, /3 - Navy Blue · 2B/, 'you can see what you already have of this design');
});

test('CART-PEEK: the design list shows the block, not a bare "N in cart"', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 }).concat(rowsFor('9037', { 3: 3 }));
  seed('shade', CART);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));
  const text = last(bot);
  assert.match(text, /Select design/, 'it is the design list');
  assert.match(text, /🛒 In cart · Σ 3B/, `got:\n${text}`);
  assert.doesNotMatch(text, /\d+ in cart/, 'the old count line is gone');
});

test('CART-PEEK: an empty cart shows nothing on any of the four surfaces — each screen positively identified', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('design', []);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
  assert.match(last(bot), /Select shade:/); assert.doesNotMatch(last(bot), /In cart/i);
  await controller.handleCallbackQuery(bot, cb('srf_sh:202/201|1|5'));
  assert.match(last(bot), /How many bales\?/); assert.doesNotMatch(last(bot), /In cart/i);
  await controller.handleCallbackQuery(bot, cb('srf_qty:__custom__'));
  assert.match(last(bot), /Type the number/); assert.doesNotMatch(last(bot), /In cart/i);
  const s2 = sessionStore.get(UID); s2.step = 'shade'; sessionStore.set(UID, s2);
  await controller.handleCallbackQuery(bot, cb('srf_back:design'));
  assert.match(last(bot), /Select design/); assert.doesNotMatch(last(bot), /in cart/i);
});

test('CART-PEEK: the basket grows as lines are added, and the quantity card reflects it', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('quantity', []);
  const s = sessionStore.get(UID); s.currentShade = '3'; s.currentShadeName = 'Navy Blue'; s.currentAvailPkgs = 4; sessionStore.set(UID, s);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_qty:2'));          // cart: 202/201 shade 3 ×2 → cart card
  await controller.handleCallbackQuery(bot, cb('srf_cart:add'));       // Add More → same design's shade picker
  assert.match(last(bot), /🛒 In cart · Σ 2B/, 'the picker now shows the line just added');
  await controller.handleCallbackQuery(bot, cb('srf_sh:202/201|1|5')); // pick shade 1 → quantity card
  const text = last(bot);
  assert.match(text, /How many bales\?/);
  assert.match(text, /3 - Navy Blue · 2B/, 'while choosing shade 1\'s quantity, shade 3\'s line is in view');
});

test('CART-PEEK: the typed Custom Quantity prompt keeps the basket in view too', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('quantity', CART);
  const s = sessionStore.get(UID); s.currentShade = '1'; s.currentShadeName = 'White'; s.currentAvailPkgs = 5; sessionStore.set(UID, s);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_qty:__custom__'));
  const text = last(bot);
  assert.match(text, /Type the number of bales \(max 5\):/);
  assert.match(text, /🛒 In cart · Σ 3B/, `got:\n${text}`);
});

/* ── the renders the first review found untested ──────────────────────── */

test('CART-PEEK: Back to shades from the quantity card MORPHS the photo back with the basket in its caption', withPhoto(async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('design', CART);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));        // photo combo, previewIsPhoto
  assert.ok(sessionStore.get(UID).previewIsPhoto, 'the combo is on screen as a photo');
  await controller.handleCallbackQuery(bot, cb('srf_sh:202/201|1|5'));    // morph → quantity
  // The quantity card on the MORPH path is a real photo caption (the
  // 1,024-capped one): the basket must be there, above the question.
  const qtyMorph = bot.callsTo('editMessageCaption').pop();
  assert.ok(qtyMorph, 'the quantity step morphed the caption in place');
  assert.match(qtyMorph.args.caption, /🛒 In cart · Σ 3B/, `got:\n${qtyMorph.args.caption}`);
  assert.ok(qtyMorph.args.caption.indexOf('🛒 In cart') < qtyMorph.args.caption.indexOf('How many'));
  await controller.handleCallbackQuery(bot, cb('srf_back:shade'));         // morph BACK → shade picker
  const morphs = bot.callsTo('editMessageMedia');
  assert.ok(morphs.length, 'the way back is a morph of the same message, not a new one');
  const caption = morphs[morphs.length - 1].args.media.caption;
  assert.match(caption, /📷 \*202\/201\* — \*Lagos\*/, 'it is the shade picker again');
  assert.match(caption, /🛒 In cart · Σ 3B/, `the morphed-back caption carries the basket, got:\n${caption}`);
}));

test('CART-PEEK: the picker under a multi-page ALBUM carries the basket, above the prompt', withPhoto(async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  const origPages = designAssetsService.getPhotosForSend;
  const origAlbum = designAssetsService.sendDesignAlbum;
  designAssetsService.getPhotosForSend = async () => [PHOTO, { ...PHOTO, rowIndex: 3 }];
  designAssetsService.sendDesignAlbum = async () => [901, 902];
  try {
    seed('design', CART);
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
    const text = last(bot);
    assert.match(text, /📦 \*202\/201\* in \*Lagos\*/, 'the album picker text');
    assert.match(text, /🛒 In cart · Σ 3B/, `the basket is on the album picker, got:\n${text}`);
    assert.ok(text.indexOf('🛒 In cart') < text.indexOf('Select shade:'), 'basket above the prompt');
  } finally {
    designAssetsService.getPhotosForSend = origPages;
    designAssetsService.sendDesignAlbum = origAlbum;
  }
}));

test('CART-PEEK: a sold-out design (text form) still shows the basket', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5 }).concat(rowsWithStatus('9037', { 3: 3 }, 'sold'));
  seed('design', CART);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));
  const text = last(bot);
  assert.match(text, /Sold out/, `it is the sold-out screen, got:\n${text}`);
  assert.match(text, /🛒 In cart · Σ 3B/, 'the basket does not vanish on a sold-out design');
});

test('CART-PEEK: tapping a SOLD-OUT shade keeps the basket on the note that replaces the picker', async () => {
  // The note morphs (or replaces) the very message whose caption carried
  // the basket — the first cut dropped it there.
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('shade', CART);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_sh:202/201|7|0'));   // availPkgs 0 → sold-out note
  const text = last(bot);
  assert.match(text, /Sold out/);
  assert.match(text, /Nothing available to add/);
  assert.match(text, /🛒 In cart · Σ 3B/, `got:\n${text}`);
});

test('CART-PEEK: a single-shade design lands on the quantity card as a PHOTO with the basket above the question', async () => {
  inventoryRepository.getAll = async () => rowsFor('9037', { 3: 3 });
  designAssetsRepo.findActive = async () => ({ design: '9037', shades: [] });
  designAssetsService.getPhotoForSend = async () => PHOTO;
  try {
    seed('design', CART);
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));
    const photo = bot.callsTo('sendPhoto').pop();
    assert.ok(photo, 'single-shade quantity card went out as a photo combo');
    const caption = photo.args.opts.caption;
    assert.match(caption, /How many bales\?/);
    assert.match(caption, /🛒 In cart · Σ 3B/, `the basket is on the single-shade photo, got:\n${caption}`);
    assert.match(caption, /3 - Navy Blue · 2B/);
    assert.ok(caption.indexOf('🛒 In cart') < caption.indexOf('How many'), 'basket above the question');
  } finally {
    designAssetsRepo.findActive = async () => null;
    designAssetsService.getPhotoForSend = async () => null;
  }
});

test('CART-PEEK: Markdown specials in a shade name are escaped on Markdown pickers and left alone on the plain prompt', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  const odd = [{ design: '202/201', shade: '3', shadeName: 'Navy_Blue *special*', quantity: 2 }];
  seed('design', odd);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
  const picker = last(bot);
  assert.match(picker, /Navy\\_Blue \\\*special\\\*/, `escaped on a Markdown card, got:\n${picker}`);
  await controller.handleCallbackQuery(bot, cb('srf_sh:202/201|1|5'));
  await controller.handleCallbackQuery(bot, cb('srf_qty:__custom__'));
  const prompt = last(bot);
  assert.match(prompt, /Navy_Blue \*special\*/, `plain text on the typed prompt, got:\n${prompt}`);
  assert.doesNotMatch(prompt, /\\_/, 'no escape backslashes leak into plain text');
});

test('CART-PEEK: past its budget the block collapses to the tally line — the total is never cut', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  // Even after the 8-line cap the block must exceed the 420-char text
  // budget, so every kept line is long: the collapse, not the cap, is
  // what this pins.
  const long = [];
  for (let d = 1; d <= 4; d += 1) for (const sh of ['1', '2']) {
    long.push({ design: `70${d}/30${d}`, shade: sh, shadeName: `A very long catalogue shade name number ${sh} indeed, as typed into the sheet by hand`, quantity: 1 });
  }
  seed('design', long);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
  const text = last(bot);
  assert.match(text, /🛒 In cart · Σ 8B — full list in the cart/, `collapsed to the tally, got:\n${text}`);
  assert.doesNotMatch(text, /A very long catalogue/, 'the lines went, the tally stayed');
});

/**
 * Overflow lines: one per shade whose composed button label exceeds 34
 * characters. buildShadeNameMap reads `number` (not `shade`) off the
 * asset, so the fixture must say `number` or no names — and no overflow
 * lines — are produced at all (the first cut of this test had that bug).
 */
function longShadeAsset(count) {
  const shades = [];
  for (let i = 1; i <= count; i += 1) shades.push({ number: String(i), name: `Extraordinarily long shade name ${i}` });
  return { design: '202/201', shades };
}
function heavyCart() {
  const heavy = [];
  for (let d = 1; d <= 4; d += 1) for (const sh of ['1', '2']) heavy.push({ design: `70${d}/30${d}`, shade: sh, shadeName: `Long shade name ${sh}`, quantity: 1 });
  return heavy;
}
async function photoPickerWith(shadeCount) {
  const shades = {};
  for (let i = 1; i <= shadeCount; i += 1) shades[`${i}`] = 2;
  inventoryRepository.getAll = async () => rowsFor('202/201', shades);
  designAssetsRepo.findActive = async () => longShadeAsset(shadeCount);
  designAssetsService.getPhotoForSend = async () => PHOTO;
  try {
    seed('design', heavyCart());
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));
    const photo = bot.callsTo('sendPhoto').pop();
    assert.ok(photo, `the picker still went out as a photo (no fallback to text): ${screens(bot).slice(-1)}`);
    const caption = photo.args.opts.caption;
    assert.ok(caption.length <= 1024, `caption ${caption.length} chars`);
    assert.match(caption, /Extraordinarily long shade name 1: /, 'the overflow body lines are really there');
    return caption;
  } finally {
    designAssetsRepo.findActive = async () => null;
    designAssetsService.getPhotoForSend = async () => null;
  }
}

test('CART-PEEK: the full block rides the photo caption right up to the limit — the budget is the room left, not a fixed number', async () => {
  // Measured: 16 overflowing shades + this cart = 1,021 characters with
  // the FULL block. A fixed 420 guard would have collapsed it needlessly;
  // a caption-blind guard would have overflowed at 17.
  const caption = await photoPickerWith(16);
  assert.match(caption, /🛒 In cart · Σ 8B\n/, 'full block, not the collapsed line');
  assert.match(caption, /Long shade name 1 · 1B/);
  assert.ok(caption.length > 1000, `close to the limit on purpose: ${caption.length}`);
});

test('CART-PEEK: when the overflow lines leave little room, the block collapses to the tally line', async () => {
  const caption = await photoPickerWith(18);
  assert.match(caption, /🛒 In cart · Σ 8B — full list in the cart/, `collapsed, got:\n${caption}`);
  assert.doesNotMatch(caption, /Long shade name/, 'the lines went');
});

test('CART-PEEK: when not even the tally fits, the basket is dropped rather than the photo', async () => {
  const caption = await photoPickerWith(20);
  assert.doesNotMatch(caption, /In cart/, `nothing added, got ${caption.length} chars`);
});

test('CART-PEEK: a sold-out shade tapped on the PHOTO picker morphs the caption and keeps the basket', withPhoto(async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('design', CART);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:202/201'));        // photo combo
  await controller.handleCallbackQuery(bot, cb('srf_sh:202/201|7|0'));    // sold-out shade → morph
  const morph = bot.callsTo('editMessageCaption').pop();
  assert.ok(morph, 'the note morphed the same message');
  assert.match(morph.args.caption, /Sold out/);
  assert.match(morph.args.caption, /🛒 In cart · Σ 3B/, `got:\n${morph.args.caption}`);
}));

test('CART-PEEK: the typed re-prompts (bad number, too many) keep the basket in view', async () => {
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  seed('custom_quantity', CART);
  const s = sessionStore.get(UID); s.currentShade = '1'; s.currentShadeName = 'White'; s.currentAvailPkgs = 5; sessionStore.set(UID, s);
  const bot = createFakeBot();
  await controller.handleMessage(bot, { from: { id: UID }, chat: { id: UID }, text: 'abc' });
  assert.match(last(bot), /Enter a valid number/);
  assert.match(last(bot), /🛒 In cart · Σ 3B/, `got:\n${last(bot)}`);
  await controller.handleMessage(bot, { from: { id: UID }, chat: { id: UID }, text: '9' });
  assert.match(last(bot), /Only 5 bales available/);
  assert.match(last(bot), /🛒 In cart · Σ 3B/);
  assert.doesNotMatch(last(bot), /\\_/, 'plain text: no escape backslashes');
});

test('CART-PEEK: the cart card the pointer sends you to renders the same odd names safely', async () => {
  // The peek escapes; the cart card, confirmation and receipt render the
  // SAME rows under Markdown and did not — so the pointer used to send the
  // person to a card that could not draw for exactly those names.
  inventoryRepository.getAll = async () => rowsFor('202/201', { 1: 5, 3: 4 });
  const odd = [{ design: '202/201', shade: '3', shadeName: 'Navy_Blue *special* [x]', quantity: 2 }];
  seed('shade', odd);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_back:cart'));
  const text = last(bot);
  assert.match(text, /Supply Cart/, 'it is the cart card');
  assert.match(text, /Navy\\_Blue \\\*special\\\* \\\[x\]/, `escaped like the peek (and never a "\\]" — legacy Markdown renders that backslash), got:\n${text}`);
});
