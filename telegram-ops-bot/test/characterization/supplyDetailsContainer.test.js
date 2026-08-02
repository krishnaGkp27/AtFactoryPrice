'use strict';

/**
 * SDG-2 / SDD-2 (owner-approved, 02-Aug-2026):
 *
 *   • CONTAINER BIFURCATION — the Design-wise drill opens on a container
 *     picker; every level below is scoped to it, including the "total"
 *     side of the supplied/total pair. "🌍 All containers" keeps the old
 *     clubbed view reachable.
 *   • APPROVED DETAIL LAYOUT — bale numbers ride each row in brackets, the
 *     flat "Bale numbers (N)" list is gone, and 📄 / 🧮 chips deliver +
 *     reconcile the day's sale doc with 🟢 dots in place. These cards are
 *     NARROWER than a sale document, so doc-only numbers are not listed.
 *   • Warehouse-wise (SDD-2) gains the bale numbers it never had.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');

const SRC = path.join(__dirname, '..', '..', 'src');
const sdg = require(path.join(SRC, 'flows/supplyDetailsDesignFlow'));
const sdd = require(path.join(SRC, 'flows/supplyDetailsFlow'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const unitDisplayService = require(path.join(SRC, 'services/unitDisplayService'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const vision = require(path.join(SRC, 'services/vision'));
const ephemeralDocs = require(path.join(SRC, 'services/ephemeralDocs'));

unitDisplayService.isThanVisibilityWarehouse = async () => false;
// TV-8 — this fixture is bale-only stock (IDUMOTA); Kano office would show
// thans. Stubbed so the container assertions don't ride on Settings.
unitDisplayService.getThanVisibilityWarehouses = async () => new Set(['kano office']);

function row(pkg, opts = {}) {
  return {
    packageNo: String(pkg),
    design: opts.design || '44200',
    shade: opts.shade || 'BLACK',
    thanNo: opts.thanNo || 1,
    yards: opts.yards ?? 150,
    pricePerYard: opts.price ?? 0,
    status: opts.status || 'sold',
    soldTo: opts.status === 'available' ? '' : (opts.customer || 'Madam motunrayo'),
    soldDate: opts.status === 'available' ? '' : (opts.date || '2026-07-27'),
    warehouse: opts.wh || 'IDUMOTA',
    arrivalBatch: opts.batch === undefined ? 'Jul26' : opts.batch,
    baleUid: `U-${pkg}`,
  };
}

/**
 * Two containers:
 *   Jul26  — 44200 sold 487,521 (+ 641 available)  · 77008 sold 1057
 *   Mar26  — 44200 sold 900 (+ 901 available)
 */
function seed({ docs = [{ fileId: 'DOC1' }] } = {}) {
  const rows = [
    row('487'), row('521'),
    row('641', { status: 'available' }),
    row('1057', { design: '77008', shade: '5' }),
    row('900', { batch: 'Mar26' }),
    row('901', { batch: 'Mar26', status: 'available' }),
  ];
  inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(rows));
  inventoryRepository.getSoldRows = async () => JSON.parse(JSON.stringify(rows.filter((r) => r.status === 'sold')));
  approvalQueueRepository.getResolved = async () => docs.map((d, i) => ({
    requestId: `RQ-${i}`, status: 'approved',
    actionJSON: { action: 'sale_bundle', customer: 'Madam motunrayo', salesDate: '2026-07-27', sale_doc_file_id: d.fileId },
  }));
}

function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}
function lastKb(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup);
  const kb = c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => `${b.text}|${b.callback_data}`);
}
const q = (data, userId = '777') => ({
  id: 'q1', data, from: { id: userId },
  message: { chat: { id: userId }, message_id: 71 },
});

async function openSdg(userId = '777') {
  sessionStore.clear(userId);
  ephemeralDocs._internals._resetForTests();
  const bot = createFakeBot();
  await sdg.start(bot, userId, userId, null);
  return bot;
}

test('SDG-2 opens on a container picker, not the clubbed design list', async () => {
  seed();
  const bot = await openSdg();
  const text = lastText(bot);
  assert.match(text, /Which container\?/);
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b.startsWith('🚢 Jul26 — 3B / 4B|')), `Jul26 chip, got ${kb}`);
  assert.ok(kb.some((b) => b.startsWith('🚢 Mar26 — 1B / 2B|')), `Mar26 chip, got ${kb}`);
  assert.ok(kb.some((b) => b.startsWith('🌍 All containers — 4B / 6B|')), 'clubbed view still reachable');
});

test('picking a container scopes the design list — both sides of the pair', async () => {
  seed();
  const bot = await openSdg();
  await sdg.handleCallback(bot, q('sdg:ct:0')); // Jul26 (most supplied)
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b.startsWith('📦 44200 — 2B / 3B|')), `44200 scoped to Jul26, got ${kb}`);
  assert.ok(kb.some((b) => b.startsWith('📦 77008 — 1B / 1B ✅|')), '77008 fully supplied in Jul26');
  assert.match(lastText(bot), /🚢 \*Jul26\*/, 'container rides the header');
  // Mar26's 900 must not appear anywhere in this scope.
  assert.ok(!kb.some((b) => b.includes('900')), 'other container excluded');
});

test('🌍 All containers reproduces the old clubbed totals', async () => {
  seed();
  const bot = await openSdg();
  await sdg.handleCallback(bot, q('sdg:ct:all'));
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b.startsWith('📦 44200 — 3B / 5B|')), `clubbed 44200, got ${kb}`);
  assert.ok(!/🚢 \*/.test(lastText(bot)), 'no container tag when browsing all');
});

test('SDG-2 detail: numbers in brackets per shade, no flat list, chips present', async () => {
  seed();
  const bot = await openSdg();
  await sdg.handleCallback(bot, q('sdg:ct:0'));  // Jul26
  await sdg.handleCallback(bot, q('sdg:d:0'));   // 44200
  await sdg.handleCallback(bot, q('sdg:t:0'));   // 27 Jul
  await sdg.handleCallback(bot, q('sdg:c:0'));   // Madam motunrayo
  const text = lastText(bot);
  assert.match(text, / • Shade BLACK ×2B \(487, 521\)/);
  assert.match(text, /300 yds/);
  assert.ok(!/2 thans/.test(text), 'TV-8: one unit per figure, never bales AND thans');
  assert.ok(!/Bale numbers \(/.test(text), 'flat bottom list dropped');
  assert.match(text, /🚢 \*Jul26\*/);
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b === '📄 Sale doc|sdg:doc'));
  assert.ok(kb.some((b) => b === '🧮 Reconcile sale doc|sdg:rec'));
});

test('SDG-2 🧮 dots matches in place and hides doc-only numbers (narrow card)', async () => {
  seed();
  telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('pdf'), mimeType: 'application/pdf' });
  const orig = vision.extractBales;
  // The doc covers the whole day: 487 (on card), 1057 (another design), 999.
  vision.extractBales = async () => ({ ok: true, bales: [{ packageNo: '487' }, { packageNo: '1057' }, { packageNo: '999' }] });
  try {
    const bot = await openSdg();
    await sdg.handleCallback(bot, q('sdg:ct:0'));
    await sdg.handleCallback(bot, q('sdg:d:0'));
    await sdg.handleCallback(bot, q('sdg:t:0'));
    await sdg.handleCallback(bot, q('sdg:c:0'));
    await sdg.handleCallback(bot, q('sdg:rec'));
    const text = lastText(bot);
    assert.match(text, /📑 Doc check: \*1\/2\* matched/);
    assert.match(text, / • Shade BLACK ×2B \(🟢487, 521\)/);
    assert.match(text, /⚠️ Not in doc: 521/);
    assert.ok(!/Doc-only/.test(text), 'other designs from the same day are not flagged');
    assert.ok(lastKb(bot).some((b) => b === '🔁 Re-check sale doc|sdg:rec'));
  } finally { vision.extractBales = orig; }
});

test('SDG-2 reading state carries ✖ Stop check', async () => {
  seed();
  telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('pdf'), mimeType: 'application/pdf' });
  let release;
  const orig = vision.extractBales;
  vision.extractBales = () => new Promise((res) => { release = () => res({ ok: true, bales: [{ packageNo: '487' }] }); });
  try {
    const bot = await openSdg();
    await sdg.handleCallback(bot, q('sdg:ct:0'));
    await sdg.handleCallback(bot, q('sdg:d:0'));
    await sdg.handleCallback(bot, q('sdg:t:0'));
    await sdg.handleCallback(bot, q('sdg:c:0'));
    const running = sdg.handleCallback(bot, q('sdg:rec'));
    for (let i = 0; i < 10 && !release; i += 1) await new Promise(setImmediate);
    assert.match(lastText(bot), /⏳ _Reading sale doc…_/);
    assert.ok(lastKb(bot).some((b) => b === '✖ Stop check|sdg:recstop'));
    await sdg.handleCallback(bot, q('sdg:recstop'));
    assert.ok(!/Reading sale doc/.test(lastText(bot)), 'card restored');
    release();
    await running;
    assert.ok(!/Doc check|🟢/.test(lastText(bot)), 'orphaned read discarded');
  } finally { vision.extractBales = orig; }
});

test('SDD-2 warehouse card gains bale numbers + doc chips', async () => {
  seed();
  sessionStore.clear('777');
  const bot = createFakeBot();
  await sdd.start(bot, '777', '777', null);
  await sdd.handleCallback(bot, q('sdd:w:0'));  // Kano office
  await sdd.handleCallback(bot, q('sdd:d:0'));  // 27 Jul
  await sdd.handleCallback(bot, q('sdd:c:0'));  // customer
  const text = lastText(bot);
  assert.match(text, /🧵 44200: 3B \(487, 521, 900\)/, `numbers per design row, got: ${text}`);
  assert.match(text, /🧵 77008: 1B \(1057\)/);
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b === '📄 Sale doc|sdd:doc'));
  assert.ok(kb.some((b) => b === '🧮 Reconcile sale doc|sdd:rec'));
});

test('SDD-2 🧮 dots the design rows in place', async () => {
  seed();
  telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('img'), mimeType: 'image/jpeg' });
  const orig = vision.extractBales;
  vision.extractBales = async () => ({ ok: true, bales: [{ packageNo: '487' }, { packageNo: '1057' }] });
  try {
    sessionStore.clear('777');
    const bot = createFakeBot();
    await sdd.start(bot, '777', '777', null);
    await sdd.handleCallback(bot, q('sdd:w:0'));
    await sdd.handleCallback(bot, q('sdd:d:0'));
    await sdd.handleCallback(bot, q('sdd:c:0'));
    await sdd.handleCallback(bot, q('sdd:rec'));
    const text = lastText(bot);
    assert.match(text, /🧵 44200: 3B \(🟢487, 521, 900\)/);
    assert.match(text, /🧵 77008: 1B \(🟢1057\)/);
    assert.match(text, /📑 Doc check: \*2\/4\* matched/);
  } finally { vision.extractBales = orig; }
});
