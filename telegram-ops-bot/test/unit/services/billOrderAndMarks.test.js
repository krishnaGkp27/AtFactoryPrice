'use strict';
// VRF-5 — the sale card follows the bill's order and marks each checked
// bale (✅ / 🔴), marks off above the owner's threshold; the re-check door
// is one tap per admin per request.
process.env.ADMIN_IDS = '777,888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const svc = require(path.join(SRC, 'services/saleDocVerifyService'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const locationService = require(path.join(SRC, 'services/locationService'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const vision = require(path.join(SRC, 'services/vision'));
const { compareItemsToLabels, docVerifyRecord } = svc._internals;

settingsRepository.getAll = async () => ({});
inventoryRepository.getAll = async () => [];
designAssetsRepository.getAll = async () => [];
designAssetsRepository.findActive = async () => null;
designAssetsRepository.findLatest = async () => null;
locationService.shipsOnlyFromStores = async () => false;
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('pdf'), mimeType: 'application/pdf' });

// 526 is the one WHITE bale, so the details rescue cannot hand it 577's bill row.
const ITEMS = ['483', '490', '526', '577'].map((n) => ({ packageNo: n, design: '44200', shade: n === '526' ? 'WHITE' : 'BLACK', thans: 5, yards: 150, type: 'package', warehouse: 'IDUMOTA' }));
// The bill lists 483, then 577 (yards wrong), then 490; 526 is not on it.
const BILL = [
  { packageNo: '483', design: '44200', shade: 'BLACK', thanNo: 5, yards: 150 },
  { packageNo: '577', design: '44200', shade: 'BLACK', thanNo: 5, yards: 300 },
  { packageNo: '490', design: '44200', shade: 'BLACK', thanNo: 5, yards: 150 },
];

test('the verdict remembers the bill\'s row order of every matched bale', () => {
  const { results, extras } = compareItemsToLabels(ITEMS, BILL);
  const rec = docVerifyRecord(results, extras);
  assert.deepEqual(rec.billSeq, ['483', '577', '490'], 'matched bales in bill order; the missing 526 has no row');
  assert.deepEqual(rec.okNos, ['483', '490']);
  assert.deepEqual(rec.differRows.map((r) => r.no), ['577']);
  assert.deepEqual(rec.missingNos, ['526']);
  assert.deepEqual(rec.rechecks, []);
});

test('the card: bill order, ✅ on confirmed, 🔴 on differ and missing (missing last), nothing on a loose than', async () => {
  const { results, extras } = compareItemsToLabels(ITEMS, BILL);
  const docVerify = docVerifyRecord(results, extras, { thanExcluded: 1 });
  const text = await approvalCards.buildSaleCard({
    headline: 'Sale',
    items: [...ITEMS, { packageNo: '1100', thanNo: 1, type: 'than', design: '77014', shade: '11', thans: 1, yards: 30, warehouse: 'IDUMOTA' }],
    docVerify, marksOffAbovePct: 75,
  });
  assert.match(text, /\n44200 · 4B · 600 yd\n Shade BLACK\n {2}1\. 483 · 150 yd ✅\n {2}2\. 577 · 150 yd 🔴\n {2}3\. 490 · 150 yd ✅\n Shade WHITE\n {2}4\. 526 · 150 yd 🔴\n77014 · 1t · 30 yd\n Shade 11\n {2}5\. 1100\/1 · 30 yd$/, text);
});

test('above the threshold the marks go off and the check line says so; at exactly the threshold they stay', async () => {
  const mostlyWrong = {
    ok: 1, differs: 3, missing: 0, extra: 0, okNos: ['483'], okNoted: [],
    differRows: ['490', '526', '577'].map((no) => ({ no, diffs: ['qty'], notes: [] })), missingNos: [], extraRows: [],
    billSeq: ['483', '490', '526', '577'],
  };
  const off = approvalCards.billMarks(mostlyWrong, 50);
  assert.equal(off.marksOff, true, '75% flagged > 50');
  assert.equal(off.markOf('483'), '');
  const on = approvalCards.billMarks(mostlyWrong, 75);
  assert.equal(on.marksOff, false, '75% is not above 75');
  assert.equal(on.markOf('483'), ' ✅');
  assert.equal(on.markOf('490'), ' 🔴');
  assert.equal(on.markOf('9999'), '', 'never checked → no mark');
  // The bundle card reads the threshold from Settings.
  settingsRepository.getAll = async () => ({ BILL_MARKS_OFF_ABOVE_PCT: 50 });
  const card = await approvalCards.buildSaleBundleCard({ action: 'sale_bundle', items: ITEMS.map((i) => ({ type: 'package', packageNo: i.packageNo })), docVerify: mostlyWrong, totalYards: 600 });
  assert.match(card, /🔬 Bill check: 1 confirmed · 3 differ · 0 missing · 0 extra ⚠️ · marks off, compare by hand\n/, card);
  assert.ok(!/✅|🔴/.test(card.split('🔬')[0]), `no per-line marks when off: ${card}`);
  settingsRepository.getAll = async () => ({});
});

function fakeBot() {
  const sent = [];
  return { sent, sendMessage: async (chatId, text) => { sent.push(`${chatId}:${text}`); return { message_id: sent.length }; } };
}

test('re-check: one tap per admin per request, the result told to every admin, a second admin within a minute served the fresh result', async () => {
  const rows = new Map();
  rows.set('REQ1', { requestId: 'REQ1', user: '4242', status: 'pending', actionJSON: {
    action: 'sale_bundle', customer: 'OKESON', sale_doc_file_id: 'bill-1', sale_doc_type: 'document',
    items: ITEMS.map((i) => ({ packageNo: i.packageNo, design: i.design, shade: i.shade, thans: 5, yards: 150 })),
  } });
  approvalQueueRepository.getByRequestId = async (id) => rows.get(id) || null;
  approvalQueueRepository.updateActionJSON = async (id, p) => { Object.assign(rows.get(id).actionJSON, p); return true; };
  let ocrCalls = 0;
  vision.extractBales = async () => { ocrCalls += 1; return { ok: true, bales: BILL, rawText: '', overallConfidence: 0.9, warnings: [] }; };

  const bot = fakeBot();
  const first = await svc.recheckBill(bot, 'REQ1', { by: '777', byLabel: 'Musa' });
  assert.equal(first.status, 'done');
  assert.equal(ocrCalls, 1);
  const saved = rows.get('REQ1').actionJSON.docVerify;
  assert.deepEqual(saved.billSeq, ['483', '577', '490']);
  assert.deepEqual(saved.rechecks.map((r) => r.by), ['777']);
  assert.deepEqual(bot.sent, [
    '777:🔬 Bill of R-REQ1 re-checked by Musa · 2 confirmed · 1 differ · 1 missing · 0 extra',
    '888:🔬 Bill of R-REQ1 re-checked by Musa · 2 confirmed · 1 differ · 1 missing · 0 extra',
  ]);

  assert.equal((await svc.recheckBill(bot, 'REQ1', { by: '777', byLabel: 'Musa' })).status, 'used', 'the tap is spent');
  assert.equal((await svc.recheckBill(bot, 'REQ1', { by: '888', byLabel: 'Krishna' })).status, 'fresh', 'read a moment ago → served, not re-read');
  assert.equal(ocrCalls, 1, 'no second read');

  // An hour later the other admin's own tap reads again.
  saved.rechecks[0].at = new Date(Date.now() - 3600 * 1000).toISOString();
  const second = await svc.recheckBill(bot, 'REQ1', { by: '888', byLabel: 'Krishna' });
  assert.equal(second.status, 'done');
  assert.equal(ocrCalls, 2);
  assert.deepEqual(rows.get('REQ1').actionJSON.docVerify.rechecks.map((r) => r.by), ['777', '888']);

  // A decided request is never re-read; an unreadable re-read keeps the old rows and records the tap.
  rows.get('REQ1').status = 'approved';
  assert.equal((await svc.recheckBill(bot, 'REQ1', { by: '999' })).status, 'skipped');
  rows.get('REQ1').status = 'pending';
  rows.get('REQ1').actionJSON.docVerify.rechecks = [];
  vision.extractBales = async () => { ocrCalls += 1; return { ok: false, error: 'blank page' }; };
  const bad = await svc.recheckBill(bot, 'REQ1', { by: '777', byLabel: 'Musa' });
  assert.equal(bad.status, 'unreadable');
  const after = rows.get('REQ1').actionJSON.docVerify;
  assert.equal(after.readFailed, true);
  assert.deepEqual(after.okNos, ['483', '490'], 'the earlier verdict survives a failed re-read');
  assert.deepEqual(after.rechecks.map((r) => r.by), ['777']);
  assert.match(bot.sent[bot.sent.length - 1], /re-checked by Musa · could not read the bill \(blank page\) — compare by hand$/);
});

test('a first read that failed and was never re-read renders one honest line, no marks', async () => {
  const card = await approvalCards.buildSaleBundleCard({
    action: 'sale_bundle', items: [{ type: 'package', packageNo: '483' }], totalYards: 150,
    docVerify: { readFailed: true, readFailedAt: '2026-10-18T10:00:00.000Z', rechecks: [{ by: '777', at: '2026-10-18T10:00:00.000Z', ok: false }] },
  });
  assert.match(card, /\n🔬 Bill check: could not read the bill — compare by hand$/, card);
  assert.ok(!/✅|🔴/.test(card), 'nothing was checked, so nothing is marked');
});
