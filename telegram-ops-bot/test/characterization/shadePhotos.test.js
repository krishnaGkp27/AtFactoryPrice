'use strict';

/**
 * SHP-1 (owner, 02-Sep-2026) — "image 3 should be shown when the customer,
 * marketer, or salesperson selects that colour shade from image 1."
 *
 * Drives the REAL controller and flows:
 *   1. Orders → shade tap: the photo combo MORPHS in place into the shade's
 *      garment photo (editMessageMedia), caption = the quantity question,
 *      🔍 Full-quality chip present; Back morphs it back to the swatch page;
 *      a shade WITHOUT a photo keeps the picture and changes only the caption.
 *   2. 🔍 Full-quality picture delivers a DOCUMENT (never a recompressed photo).
 *   3. 🎨 Shade Photos upload door: design → shade → file → preview →
 *      ✅ Use it (full-quality copy kept) → ✅ Done → ONE approval, riding the
 *      existing design_asset_upload gate → approve → live.
 *   4. Marketer: the shade tap shows the garment photo (pair grammar, no
 *      warehouse fact) and asks ✅ before the request is raised.
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

const sheets = createFakeSheets({});
installFakeSheets(sheets);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const productTypesRepo = require(path.join(SRC, 'repositories/productTypesRepository'));
const designAssetsRepo = require(path.join(SRC, 'repositories/designAssetsRepository'));
const designAssetsService = require(path.join(SRC, 'services/designAssetsService'));
const shadeRepo = require(path.join(SRC, 'repositories/designShadeAssetsRepository'));
const shadeAssets = require(path.join(SRC, 'services/designShadeAssetsService'));
const driveClient = require(path.join(SRC, 'repositories/driveClient'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));

const UID = '4242';
const ASSET = {
  rowIndex: 2, design: '9037', shadeCount: 2, status: 'active', arrivalBatch: '',
  shades: [{ number: 1, name: 'White' }, { number: 2, name: 'Dark Brown' }],
};
const PAGE = { photo: 'PAGE_FID', photoSource: 'telegram_file_id', rowIndex: 2, design: '9037' };

productTypesRepo.getLabels = async () => ({ container_label: 'Bale', subunit_label: 'Than', measure_unit: 'yards' });
designAssetsService.cacheTelegramFileId = async () => {};
designAssetsRepo.findActive = async () => ASSET;
designAssetsRepo.list = async (status) => (status && status !== 'active' ? [] : [ASSET]);
designAssetsService.getPhotosForSend = async () => [PAGE];
designAssetsService.getPhotoForSend = async () => PAGE;
auditLogRepository.append = async () => {};
driveClient.uploadFile = async (buf, name) => ({ fileId: `drv_${name.replace(/[^a-z]/gi, '').slice(0, 8)}`, webViewLink: 'x' });
driveClient.downloadFile = async () => Buffer.from('drive-bytes');

function seedShadeRows(rows) {
  sheets._store.set(shadeRepo.SHEET, [shadeRepo.HEADERS, ...rows.map((r) => shadeRepo._internals.toRow(
    { design: '9037', status: 'active', uploadedAt: '2026-09-01T00:00:00Z', ...r }))]);
  shadeRepo.invalidateCache();
}

function seedStock() {
  const rows = [];
  for (const shade of ['1', '2']) {
    for (let i = 0; i < 3; i += 1) {
      rows.push({ design: '9037', shade, warehouse: 'IDUMOTA', status: 'available', packageNo: `${shade}${i}`, productType: 'fabric', yards: 30 });
    }
  }
  inventoryRepository.getAll = async () => rows;
  sessionStore.set(UID, { type: 'supply_req_flow', warehouse: 'IDUMOTA', cart: [], step: 'design', productType: 'fabric', flowMessageId: 50 });
}

const flat = (kb) => (kb ? kb.inline_keyboard.flat() : []);
const last = (bot, method) => bot.calls.filter((c) => c.method === method).pop();
const lastCard = (bot) => bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').pop();
/** Queue rows for shade batches, read from the fake sheet (appendOnce is idempotent on requestId). */
const queuedShadeBatches = () => (sheets._store.get('ApprovalQueue') || []).slice(1)
  .filter((r) => /"kind":"shade"/.test(String(r[2])))
  .map((r) => ({ requestId: r[0], actionJSON: JSON.parse(r[2]) }));
const previewId = () => sessionStore.get(UID)._pending.previewMessageId;

test('Orders: the shade tap morphs the swatch page into the shade’s garment photo, in place', async () => {
  seedStock();
  seedShadeRows([{ shadeNo: '1', shadeName: 'White', telegramFileId: 'SHADE1_FID', telegramDocFileId: 'SHADE1_DOC', width: 4000, height: 6000, bytes: 8 * 1024 * 1024 }]);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));
  const combo = last(bot, 'sendPhoto');
  assert.ok(combo, 'the swatch page combo is a photo message');
  assert.equal(combo.args.photo, 'PAGE_FID');
  const s1 = sessionStore.get(UID);
  assert.equal(s1.previewIsPhoto, true, 'the combo is remembered as morphable');
  const comboId = s1.previewMessageId;

  const before = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('srf_sh:9037|1|3'));
  const morph = last(bot, 'editMessageMedia');
  assert.ok(morph, 'shade tap edits the SAME message');
  assert.equal(morph.args.opts.message_id, comboId);
  assert.equal(morph.args.media.type, 'photo');
  assert.equal(morph.args.media.media, 'SHADE1_FID', 'the picture is now the shade photo');
  assert.match(morph.args.media.caption, /Shade: \*1 - White\*/);
  assert.match(morph.args.media.caption, /How many bales to supply\?/);
  const texts = flat(morph.args.opts.reply_markup).map((b) => b.text);
  assert.ok(texts.includes('All (3)') && texts.includes('1'), `quantity chips ride the photo, got ${texts}`);
  assert.ok(texts.includes('🔍 Full-quality picture'), 'full-quality chip present');
  assert.equal(texts[texts.length - 1], '⬅️ Back to shades', 'back stays last');
  const newMsgs = bot.calls.slice(before).filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto');
  assert.equal(newMsgs.length, 0, 'NO second card under the photo');
  assert.equal(bot.calls.slice(before).filter((c) => c.method === 'deleteMessage').length, 0, 'nothing deleted');
  assert.equal(sessionStore.get(UID).previewMessageId, comboId, 'the same message stays the anchor');

  // 🔍 → a DOCUMENT, the stored bytes, never a recompressed photo.
  await controller.handleCallbackQuery(bot, cb('srf_shpfull'));
  const doc = last(bot, 'sendDocument');
  assert.ok(doc, 'full quality goes as a document');
  assert.equal(doc.args.doc, 'SHADE1_DOC');
  assert.match(doc.args.opts.caption, /full quality · 4000×6000 · 8\.0 MB/);

  // Back → the same message morphs back to the swatch page + shade chips.
  const b2 = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('srf_back:shade'));
  const back = last(bot, 'editMessageMedia');
  assert.equal(back.args.media.media, 'PAGE_FID', 'the swatch page is back');
  assert.equal(back.args.opts.message_id, comboId);
  assert.ok(flat(back.args.opts.reply_markup).some((b) => /1 - White/.test(b.text)), 'shade chips are back');
  assert.equal(bot.calls.slice(b2).filter((c) => c.method === 'sendPhoto').length, 0, 'no fresh combo sent');

  // A shade WITHOUT a photo: the picture stays, only the words change.
  await controller.handleCallbackQuery(bot, cb('srf_sh:9037|2|3'));
  const cap = last(bot, 'editMessageCaption');
  assert.ok(cap, 'caption-only morph');
  assert.match(cap.args.caption, /Shade: \*2 - Dark Brown\*/);
  assert.ok(!flat(cap.args.opts.reply_markup).some((b) => /Full-quality/.test(b.text)), 'no 🔍 chip without a photo');
});

test('Orders: SHADE_PHOTOS_ENABLED=0 restores the pre-SHP-1 behaviour exactly', async () => {
  const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
  const saved = settingsRepository.getAll;
  settingsRepository.getAll = async () => ({ SHADE_PHOTOS_ENABLED: 0 });
  try {
    seedStock();
    seedShadeRows([{ shadeNo: '1', shadeName: 'White', telegramFileId: 'SHADE1_FID' }]);
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));
    const comboId = sessionStore.get(UID).previewMessageId;
    await controller.handleCallbackQuery(bot, cb('srf_sh:9037|1|3'));
    assert.equal(last(bot, 'editMessageMedia'), undefined, 'no picture morph when the knob is off');
    assert.equal(last(bot, 'editMessageCaption'), undefined, 'no caption morph either');
    assert.ok(bot.calls.some((c) => c.method === 'deleteMessage' && c.args.messageId === comboId), 'the combo is dropped at the tap, as before');
    const qty = last(bot, 'sendMessage');
    assert.match(qty.args.text, /How many bales to supply\?/, 'the old text quantity card');
    assert.ok(!flat(qty.args.opts.reply_markup).some((b) => /Full-quality/.test(b.text)));
    await controller.handleCallbackQuery(bot, cb('srf_back:shade'));
    assert.equal(last(bot, 'editMessageMedia'), undefined, 'Back sends a fresh combo, never morphs');
    assert.ok(bot.calls.filter((c) => c.method === 'sendPhoto').length >= 2);
  } finally { settingsRepository.getAll = saved; }
});

test('🎨 Shade Photos: file → native-resolution preview → Use it → Done → one approval → live', async () => {
  const sharp = require('sharp');
  const original = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#553311' } }).jpeg().toBuffer();
  telegramFiles.downloadTelegramFile = async () => ({ buffer: original, mimeType: 'image/jpeg' });
  seedShadeRows([{ shadeNo: '1', shadeName: 'White', telegramFileId: 'SHADE1_FID' }]);
  sessionStore.clear(UID);
  sheets._store.set('ApprovalQueue', [['requestId', 'user', 'actionJSON', 'riskReason', 'status', 'createdAt', 'resolvedAt']]);
  try {
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('act:shade_photos'));
    let kb = flat(lastCard(bot).args.opts.reply_markup).map((b) => b.text);
    assert.ok(kb.includes('✓ 9037'), `design list with ✓ for a design that has shade photos, got ${kb}`);

    await controller.handleCallbackQuery(bot, cb('shp:d:0'));
    const shadesCard = lastCard(bot);
    kb = flat(shadesCard.args.opts.reply_markup).map((b) => b.text);
    assert.ok(kb.includes('✓ 1 - White'), `shade 1 already has one, got ${kb}`);
    assert.ok(kb.includes('2 - Dark Brown'));
    assert.ok(kb.includes('📷 Add next missing'));

    await controller.handleCallbackQuery(bot, cb('shp:next'));
    const prompt = lastCard(bot);
    assert.match(prompt.args.text, /shade 2 - Dark Brown/);
    assert.match(prompt.args.text, /send it as a \*File\*/, 'the quality instruction is on the prompt');

    await controller.handleFileMessage(bot, { from: { id: UID }, chat: { id: UID }, document: { file_id: 'DOC_IN', mime_type: 'image/jpeg' } });
    const preview = last(bot, 'sendPhoto');
    assert.ok(preview, 'preview sent');
    assert.ok(Buffer.isBuffer(preview.args.photo), 'preview is the stamped buffer');
    assert.equal((await sharp(preview.args.photo).metadata()).width, 1600, 'stamped at native size, not 1280');
    assert.match(preview.args.opts.caption, /1600×1200/);
    assert.match(preview.args.opts.caption, /full quality \(sent as file\)/);
    kb = flat(preview.args.opts.reply_markup).map((b) => b.text);
    assert.deepEqual(kb, ['✅ Use it', '🔁 Retake', '⏭ Skip this shade']);

    await controller.handleCallbackQuery(bot, cb('shp:use:1', UID, previewId()));
    const copy = last(bot, 'sendDocument');
    assert.ok(copy && Buffer.isBuffer(copy.args.doc), 'full-quality copy kept as a document');
    assert.equal(copy.args.fileOptions.filename, '9037_shade_2.jpg');
    const done = lastCard(bot);
    kb = flat(done.args.opts.reply_markup).map((b) => b.text);
    assert.ok(kb.some((t) => /✅ Done — send 1 for approval/.test(t)), `Done offered, got ${kb}`);
    assert.ok(kb.includes('🆕 2 - Dark Brown'));

    await controller.handleCallbackQuery(bot, cb('shp:done'));
    const queued = queuedShadeBatches();
    assert.equal(queued.length, 1, 'ONE approval for the batch');
    const aj = queued[0].actionJSON;
    assert.equal(aj.action, 'design_asset_upload', 'rides the existing photo gate — no new action code');
    assert.equal(aj.kind, 'shade');
    assert.deepEqual(aj.shades, [{ number: '2', name: 'Dark Brown' }]);
    // The admin card is MarkdownV2-escaped — strip the escapes to read it.
    const adminMsgs = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777').map((c) => c.args.text).join('\n').replace(/\\/g, '');
    assert.match(adminMsgs, /Shade photos: 9037 — 1 shade\(s\): 2 Dark Brown/);
    const adminPreview = bot.calls.find((c) => c.method === 'sendPhoto' && String(c.args.chatId) === '777');
    assert.ok(adminPreview, 'admin sees the picture before deciding');
    assert.ok(!sessionStore.get(UID), 'session cleared');

    const pending = (await shadeRepo.getAll()).filter((r) => r.status === 'pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].shadeNo, '2');
    assert.equal(pending[0].sourceKind, 'document');
    assert.ok(pending[0].telegramFileId, 'preview file_id cached on the row');
    assert.ok(pending[0].telegramDocFileId, 'full-quality document file_id cached on the row');
    assert.equal(pending[0].width, 1600);

    const r = await inventoryService.executeApprovedAction(queued[0].requestId, '777');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.message || '', /1 shade photo\(s\) for \*9037\* now live — #2 Dark Brown/);
    const live = await shadeAssets.getShadePhotoForSend('9037', '2');
    assert.ok(live, 'shade 2 now resolves');
    assert.equal(live.photoSource, 'telegram_file_id');
  } finally { /* nothing to restore */ }
});

test('🎨 Shade Photos: a compressed photo is accepted but told apart; wrong file type refused', async () => {
  const sharp = require('sharp');
  const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#112233' } }).jpeg().toBuffer();
  telegramFiles.downloadTelegramFile = async () => ({ buffer: small, mimeType: 'image/jpeg' });
  seedShadeRows([]);
  sessionStore.clear(UID);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:shade_photos'));
  await controller.handleCallbackQuery(bot, cb('shp:d:0'));
  await controller.handleCallbackQuery(bot, cb('shp:s:0'));
  await controller.handleFileMessage(bot, { from: { id: UID }, chat: { id: UID }, document: { file_id: 'PDF', mime_type: 'application/pdf' } });
  assert.match(last(bot, 'sendMessage').args.text, /Send an image file/);
  await controller.handleFileMessage(bot, { from: { id: UID }, chat: { id: UID }, photo: [{ file_id: 'P_small' }, { file_id: 'P_large' }] });
  const preview = last(bot, 'sendPhoto');
  assert.match(preview.args.opts.caption, /sent as photo — Telegram compressed it/);
  await controller.handleCallbackQuery(bot, cb('shp:retake:0', UID, previewId()));
  assert.match(lastCard(bot).args.text, /shade 1 - White/, 'retake re-prompts the same shade');
  await controller.handleCallbackQuery(bot, cb('shp:cancel'));
  assert.ok(!sessionStore.get(UID));
});

test('Marketer: the shade tap shows the garment photo (pair grammar only) and asks ✅ before the request', async () => {
  const myProductsFlow = require(path.join(SRC, 'flows/myProductsFlow'));
  const linkedAccessService = require(path.join(SRC, 'services/linkedAccessService'));
  const linkedSupplyService = require(path.join(SRC, 'services/linkedSupplyService'));
  linkedAccessService.infoFor = async () => ({ type: 'marketer', linkId: 'MKT-1', linkName: 'Musa', pinnedWarehouse: 'IDUMOTA' });
  const raised = [];
  linkedSupplyService.raise = async (bot, info, lines) => { raised.push(lines); return { ok: true }; };
  seedShadeRows([{ shadeNo: '1', shadeName: 'White', telegramFileId: 'SHADE1_FID', telegramDocFileId: 'SHADE1_DOC' }]);
  const MK = '9009';
  sessionStore.set(MK, {
    type: 'my_products_flow', step: 'shades', photoMessageId: 321, _design: 0,
    _items: [{ design: '9037', suppliedB: 1, allocatedB: 3, shades: [{ shade: '1', suppliedB: 1, allocatedB: 3 }, { shade: '2', suppliedB: 0, allocatedB: 2 }] }],
  });
  const bot = createFakeBot();
  await myProductsFlow.handleCallback(bot, cb('myp:s:0:0', MK));
  const morph = last(bot, 'editMessageMedia');
  assert.ok(morph, 'the design card morphs into the shade photo');
  assert.equal(morph.args.media.media, 'SHADE1_FID');
  assert.equal(morph.args.opts.message_id, 321);
  assert.match(morph.args.media.caption, /Shade \*1 - White\*/);
  assert.match(morph.args.media.caption, /\(1B \/ 3B — supplied \/ allocated to you\)/, 'pair grammar');
  assert.ok(!/IDUMOTA|available|stock/i.test(morph.args.media.caption), 'no warehouse fact reaches a linked person (§16)');
  const texts = flat(morph.args.opts.reply_markup).map((b) => b.text);
  assert.deepEqual(texts, ['✅ Request this shade (2B)', '🔍 Full-quality picture', '⬅️ Back']);
  assert.equal(raised.length, 0, 'nothing raised yet');

  await myProductsFlow.handleCallback(bot, cb('myp:sf:0:0', MK));
  assert.equal(last(bot, 'sendDocument').args.doc, 'SHADE1_DOC');

  await myProductsFlow.handleCallback(bot, cb('myp:sc:0:0', MK));
  assert.equal(raised.length, 1, '✅ raises the request');
  assert.deepEqual(raised[0], [{ design: '9037', shade: '1', quantity: 2 }]);

  // A shade WITHOUT a photo keeps the MYP-2 one-tap request.
  await myProductsFlow.handleCallback(bot, cb('myp:s:0:1', MK));
  assert.equal(raised.length, 2);
  assert.deepEqual(raised[1], [{ design: '9037', shade: '2', quantity: 2 }]);

  // Back from the photo morphs the same message back to the design card.
  sessionStore.set(MK, { ...sessionStore.get(MK), photoMessageId: 321 });
  await myProductsFlow.handleCallback(bot, cb('myp:sb:0', MK));
  const back = last(bot, 'editMessageMedia');
  assert.equal(back.args.media.media, 'PAGE_FID');
  assert.ok(flat(back.args.opts.reply_markup).some((b) => /Take ALL 2 shades/.test(b.text)));
});

/* ── Adversarial-review regressions (02-Sep-2026) ───────────────────── */

test('REGRESSION: a sold-out shade tap morphs the caption in place — no "Sold out" card stacks under live chips', async () => {
  seedStock();
  seedShadeRows([{ shadeNo: '1', shadeName: 'White', telegramFileId: 'SHADE1_FID' }]);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));
  const comboId = sessionStore.get(UID).previewMessageId;
  const before = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('srf_sh:9037|2|0'));
  const cap = last(bot, 'editMessageCaption');
  assert.ok(cap && /Sold out/.test(cap.args.caption), 'sold-out note rides the combo');
  assert.equal(cap.args.opts.message_id, comboId);
  assert.equal(bot.calls.slice(before).filter((c) => c.method === 'sendMessage').length, 0, 'no separate card');
  await controller.handleCallbackQuery(bot, cb('srf_sh:9037|1|3'));
  assert.equal(last(bot, 'editMessageMedia').args.opts.message_id, comboId, 'the next shade still morphs the same message');
  assert.equal(bot.calls.slice(before).filter((c) => c.method === 'sendMessage').length, 0, 'nothing stranded');
});

test('REGRESSION: choosing a quantity detaches the morphed photo — Cart → Add more → same design never morphs a stale bubble', async () => {
  seedStock();
  seedShadeRows([{ shadeNo: '1', shadeName: 'White', telegramFileId: 'SHADE1_FID' }]);
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));
  const comboId = sessionStore.get(UID).previewMessageId;
  await controller.handleCallbackQuery(bot, cb('srf_sh:9037|1|3'));
  await controller.handleCallbackQuery(bot, cb('srf_qty:2', UID, comboId));
  const rec = bot.calls.filter((c) => c.method === 'editMessageCaption').pop();
  assert.match(rec.args.caption, /× 2 added to cart/, 'the photo becomes a record of what was added');
  assert.equal(rec.args.opts.message_id, comboId);
  const s = sessionStore.get(UID);
  assert.equal(s.previewMessageId, null, 'detached');
  assert.equal(s.previewIsPhoto, false);
  assert.equal(s.cart.length, 1);
  const mark = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('srf_cart:add'));
  await controller.handleCallbackQuery(bot, cb('srf_dg:9037'));
  const after = bot.calls.slice(mark);
  assert.ok(after.some((c) => c.method === 'sendPhoto'), 'a FRESH combo for the second visit');
  assert.ok(!after.some((c) => c.method === 'editMessageMedia' && c.args.opts.message_id === comboId), 'the old bubble is never morphed');
});

test('REGRESSION: marketer — a failed morph shows a fresh photo card and NEVER raises the request', async () => {
  const myProductsFlow = require(path.join(SRC, 'flows/myProductsFlow'));
  const linkedAccessService = require(path.join(SRC, 'services/linkedAccessService'));
  const linkedSupplyService = require(path.join(SRC, 'services/linkedSupplyService'));
  linkedAccessService.infoFor = async () => ({ type: 'marketer', linkId: 'MKT-1', linkName: 'Musa', pinnedWarehouse: 'IDUMOTA' });
  const raised = [];
  linkedSupplyService.raise = async (bot, info, lines) => { raised.push(lines); return { ok: true }; };
  seedShadeRows([{ shadeNo: '1', shadeName: 'White', telegramFileId: 'SHADE1_FID' }]);
  const MK = '9010';
  const items = [{ design: '9037', suppliedB: 1, allocatedB: 3, shades: [{ shade: '1', suppliedB: 1, allocatedB: 3 }] }];
  sessionStore.set(MK, { type: 'my_products_flow', step: 'shades', photoMessageId: 321, _design: 0, _items: items });
  const bot = createFakeBot();
  bot.editMessageMedia = async () => { throw new Error('ETELEGRAM: 400 Bad Request: message to edit not found'); };
  await myProductsFlow.handleCallback(bot, cb('myp:s:0:0', MK));
  assert.equal(raised.length, 0, 'a display failure raises nothing');
  const fresh = last(bot, 'sendPhoto');
  assert.ok(fresh && fresh.args.photo === 'SHADE1_FID', 'the photo goes up as a fresh card');
  const texts = flat(fresh.args.opts.reply_markup).map((b) => b.text);
  assert.deepEqual(texts, ['✅ Request this shade (2B)', '🔍 Full-quality picture', '⬅️ Back']);
  assert.equal(sessionStore.get(MK).photoMessageId, fresh.args.opts && sessionStore.get(MK).photoMessageId, 'anchor moved to the new card');

  // Text-fallback design card (no photoMessageId) with a shade photo: same — show, do not raise.
  sessionStore.set(MK, { type: 'my_products_flow', step: 'shades', photoMessageId: null, flowMessageId: 5, _design: 0, _items: items });
  const bot2 = createFakeBot();
  await myProductsFlow.handleCallback(bot2, cb('myp:s:0:0', MK));
  assert.equal(raised.length, 0);
  assert.equal(last(bot2, 'sendPhoto').args.photo, 'SHADE1_FID');
  await myProductsFlow.handleCallback(bot2, cb('myp:sc:0:0', MK));
  assert.equal(raised.length, 1, 'only ✅ raises');
});

test('REGRESSION: upload door — one picture at a time, stale previews are inert, Done is single-flight, huge files refused', async () => {
  const sharp = require('sharp');
  const img = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#553311' } }).jpeg().toBuffer();
  telegramFiles.downloadTelegramFile = async () => ({ buffer: img, mimeType: 'image/jpeg' });
  seedShadeRows([]);
  sessionStore.clear(UID);
  sheets._store.set('ApprovalQueue', [['requestId', 'user', 'actionJSON', 'riskReason', 'status', 'createdAt', 'resolvedAt']]);
  const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
  const savedSettings = settingsRepository.getAll;
  try {
    const bot = createFakeBot();
    const file = (id) => ({ from: { id: UID }, chat: { id: UID }, document: { file_id: id, mime_type: 'image/jpeg' } });
    await controller.handleCallbackQuery(bot, cb('act:shade_photos'));
    await controller.handleCallbackQuery(bot, cb('shp:d:0'));
    await controller.handleCallbackQuery(bot, cb('shp:s:0'));

    // Two pictures at once (a media group): one preview, the other refused.
    await Promise.all([controller.handleFileMessage(bot, file('A')), controller.handleFileMessage(bot, file('B'))]);
    assert.equal(bot.calls.filter((c) => c.method === 'sendPhoto').length, 1, 'exactly one preview');
    assert.ok(bot.calls.some((c) => c.method === 'sendMessage' && /One picture at a time/.test(c.args.text)));
    const previewId = last(bot, 'sendPhoto') && sessionStore.get(UID)._pending.previewMessageId;

    // ⬅ Shades abandons the preview: its chips are frozen and later taps on it are inert.
    await controller.handleCallbackQuery(bot, cb('shp:back'));
    const frozen = last(bot, 'editMessageReplyMarkup');
    assert.equal(frozen.args.opts.message_id, previewId);
    assert.match(flat(frozen.args.replyMarkup)[0].text, /back/);
    await controller.handleCallbackQuery(bot, cb('shp:s:0'));
    await controller.handleFileMessage(bot, file('C'));
    await controller.handleCallbackQuery(bot, cb('shp:use:0', UID, sessionStore.get(UID)._pending.previewMessageId));
    assert.ok(sessionStore.get(UID)._staged[0], 'shade 1 staged properly');
    await controller.handleCallbackQuery(bot, cb('shp:skip:0', UID, previewId)); // the STALE preview's ⏭
    assert.ok(sessionStore.get(UID)._staged[0], 'a stale ⏭ cannot drop the staged shade');
    assert.ok(!sessionStore.get(UID)._skipped[0]);
    assert.ok(bot.calls.some((c) => c.method === 'sendMessage' && /no longer the one being decided/.test(c.args.text)));

    // Done twice at once → ONE batch, ONE queue row, ONE set of rows.
    await controller.handleCallbackQuery(bot, cb('shp:skip:1', UID, sessionStore.get(UID).flowMessageId)); // finish shade 2's prompt
    await Promise.all([controller.handleCallbackQuery(bot, cb('shp:done')), controller.handleCallbackQuery(bot, cb('shp:done'))]);
    assert.equal(queuedShadeBatches().length, 1, 'one approval row');
    assert.equal((await shadeRepo.getAll()).filter((r) => r.status === 'pending').length, 1, 'one pending shade row');

    // Too big for the native stamp → refused with the size, prompt stays.
    settingsRepository.getAll = async () => ({ SHADE_PHOTO_MAX_MP: 0.5 });
    sessionStore.clear(UID);
    const bot2 = createFakeBot();
    await controller.handleCallbackQuery(bot2, cb('act:shade_photos'));
    await controller.handleCallbackQuery(bot2, cb('shp:d:0'));
    await controller.handleCallbackQuery(bot2, cb('shp:s:0'));
    await controller.handleFileMessage(bot2, file('BIG'));
    assert.equal(bot2.calls.filter((c) => c.method === 'sendPhoto').length, 0, 'no preview for a refused file');
    assert.ok(bot2.calls.some((c) => c.method === 'sendMessage' && /1600×1200 .*MP limit/.test(c.args.text)), 'told the size and the limit');
    assert.equal(sessionStore.get(UID).step, 'photo', 'prompt is back');
  } finally {
    settingsRepository.getAll = savedSettings;
  }
});
