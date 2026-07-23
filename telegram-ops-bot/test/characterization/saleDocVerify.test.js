'use strict';

/**
 * VRF-1 — bill-vs-request verification (owner 22-Jul) + CARD-2 grouped
 * sale cards. Pins: compare logic (number match, details rescue, qty
 * tolerance, missing/extra), snap-source skip (owner cost rule), the
 * Settings kill-switch, the notify wiring, and the design-grouped card.
 *
 * VRF-1 accuracy (owner 23-Jul, precision over cost — the real 11-page
 * bill scored 0/8/3/3, all false): shade aliases (BK→BLACK), DesignAssets
 * numeric-shade translation, unverifiable-notation softening, design
 * prefix misreads (4420 vs 44200), missing↔extra misread pairing, and
 * the strong-model force on the verification OCR read.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

loadController();
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const vision = require(path.join(SRC, 'services/vision'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const svc = require(path.join(SRC, 'services/saleDocVerifyService'));
const { compareItemsToLabels, buildVerdictMessage } = svc._internals;

let settings = {};
settingsRepository.getAll = async () => ({ ...settings });

test('compare: number match, indent-misread details rescue, qty tolerance, missing + extra', () => {
  const items = [
    { packageNo: '879', design: '77016', shade: '1', thans: 5, yards: 150 },
    { packageNo: '889', design: '77016', shade: '3', thans: 5, yards: 300 },
    { packageNo: '862', design: '77014', shade: '6', thans: 5, yards: 150 },
    { packageNo: '847', design: '77014', shade: '3', thans: 5, yards: 150 },
  ];
  const labels = [
    { packageNo: 'P879', design: '77016', shade: '1', thanNo: 5, yards: 155 },   // prefix + within tolerance
    { packageNo: '889', design: '77016', shade: '3', thanNo: 5, yards: 164 },    // 300 vs 164 → qty differs
    { packageNo: '2522', design: '77014-3', shade: '3', thanNo: 5, yards: 150 }, // indent misread → details rescue
    { packageNo: '873', design: '77016', shade: '5', thanNo: 5, yards: 150 },    // extra on the bill
  ];
  const { results, extras } = compareItemsToLabels(items, labels);
  assert.equal(results[0].status, 'ok', '879 confirmed (prefix digits, qty inside tolerance)');
  assert.equal(results[1].status, 'differs');
  assert.match(results[1].diffs.join(' '), /qty: bill ~164 yds, request 300 yds/);
  assert.equal(results[3].status, 'differs', '847 found via design+shade despite bill reading 2522');
  assert.match(results[3].diffs.join(' '), /bill reads "2522" — matched by details/);
  assert.equal(results[2].status, 'missing', '862 nowhere on the bill');
  assert.equal(extras.length, 1);
  assert.equal(extras[0].packageNo, '873');
  const msg = buildVerdictMessage('REQ1', results, extras);
  assert.match(msg, /✅ Bale 879 — on the bill/);
  assert.match(msg, /❌ Bale 862 — NOT found on the bill/);
  assert.match(msg, /➕ On the bill but NOT in the request: 873 \(77016 5\)/);
  assert.match(msg, /Verdict: 1 confirmed · 2 differ · 1 missing · 1 extra/);
  assert.match(msg, /Open the attached bill and compare before approving/);
});

test('VRF-1 accuracy: shade aliases, catalog shade numbers, design-prefix misreads', () => {
  const shadeCatalog = new Map([
    ['44200', [{ number: 1, name: 'BLACK' }, { number: 2, name: 'WHITE' }]],
  ]);
  const items = [
    { packageNo: '601', design: '44200', shade: 'BLACK', thans: 5, yards: 150 },
    { packageNo: '602', design: '44200', shade: 'BLACK', thans: 5, yards: 150 },
    { packageNo: '603', design: '44200', shade: 'WHITE', thans: 5, yards: 150 },
    { packageNo: '605', design: '44200', shade: 'BLACK', thans: 5, yards: 150 },
  ];
  const labels = [
    { packageNo: '601', design: '44200', shade: 'BK', thanNo: 5, yards: 150 },   // (i) alias
    { packageNo: '602', design: '44200', shade: '1', thanNo: 5, yards: 150 },    // (ii) catalog: 1 → BLACK
    { packageNo: '603', design: '4420', shade: 'WHITE', thanNo: 5, yards: 150 }, // (iv) design prefix misread
    { packageNo: '605', design: '44200', shade: '2', thanNo: 5, yards: 150 },    // catalog: 2 → WHITE ≠ BLACK
  ];
  const { results, extras } = compareItemsToLabels(items, labels, { shadeCatalog });
  assert.equal(results[0].status, 'ok', 'BK aliases BLACK — confirmed');
  assert.equal(results[1].status, 'ok', 'COLOUR NO. 1 maps to BLACK via DesignAssets — confirmed');
  assert.equal(results[2].status, 'ok', '4420 is a ≥4-digit prefix of 44200 with the bale number matching');
  assert.match(results[2].notes.join(' '), /bill reads "4420" — leading digits match 44200/);
  assert.equal(results[3].status, 'differs', 'catalog maps 2→WHITE, request says BLACK — a REAL differ');
  assert.match(results[3].diffs.join(' '), /shade: bill says 2, request says BLACK/);
  assert.equal(extras.length, 0);
  const msg = buildVerdictMessage('REQA', results, extras);
  assert.match(msg, /✅ Bale 603 — on the bill \(⚠️ design: bill reads "4420" — leading digits match 44200\)/);
  assert.match(msg, /Verdict: 3 confirmed · 1 differ · 0 missing · 0 extra/);
});

test('VRF-1 accuracy: numeric shade with NO catalog entry softens to a note, not a differ', () => {
  const items = [{ packageNo: '881', design: '9060', shade: 'BLACK', thans: 5, yards: 150 }];
  const labels = [{ packageNo: '881', design: '9060', shade: '1', thanNo: 5, yards: 150 }];
  const { results } = compareItemsToLabels(items, labels);
  assert.equal(results[0].status, 'ok', 'no catalog to translate — not a hard differ');
  assert.match(results[0].notes.join(' '), /could not verify shade notation \(bill says 1, request says BLACK\)/);
  const msg = buildVerdictMessage('REQB', results, []);
  assert.match(msg, /✅ Bale 881 — on the bill \(⚠️ shade: could not verify shade notation/);
  assert.match(msg, /Verdict: 1 confirmed · 0 differ · 0 missing · 0 extra/);

  // Name-vs-name that genuinely disagrees still differs hard.
  const hard = compareItemsToLabels(
    [{ packageNo: '882', design: '9060', shade: 'BLACK', thans: 5, yards: 150 }],
    [{ packageNo: '882', design: '9060', shade: 'RED', thanNo: 5, yards: 150 }],
  );
  assert.equal(hard.results[0].status, 'differs');
});

test('VRF-1 accuracy: misread bale number pairs missing+extra into ONE differ-with-note', () => {
  // Real bill: request bale 604 (44200 BLACK) was read as bale 634 with
  // COLOUR NO. "1" — the old compare double-counted it as 1 missing + 1
  // extra. Details agree + edit distance 1 → one misread bale.
  const items = [
    { packageNo: '604', design: '44200', shade: 'BLACK', thans: 5, yards: 150 },
    { packageNo: '700', design: '55100', shade: 'BLUE', thans: 5, yards: 150 },
  ];
  const labels = [
    { packageNo: '634', design: '44200', shade: '1', thanNo: 5, yards: 150 }, // 604 misread
    { packageNo: '223', design: '44200', shade: 'RED', thanNo: 2, yards: 60 }, // phantom corner scribble
  ];
  const { results, extras } = compareItemsToLabels(items, labels);
  assert.equal(results[0].status, 'differs', '604↔634 paired as one physical bale');
  assert.match(results[0].diffs.join(' '), /bale no: bill reads "634" — matched by details/);
  assert.equal(results[1].status, 'missing', '700 has no plausible pair (edit distance too far, wrong design)');
  assert.equal(extras.length, 1, 'the phantom 223 stays extra — details disagree');
  assert.equal(extras[0].packageNo, '223');
  const msg = buildVerdictMessage('REQC', results, extras);
  assert.match(msg, /⚠️ Bale 604 — bale no: bill reads "634" — matched by details/);
  assert.match(msg, /❌ Bale 700 — NOT found on the bill/);
  assert.match(msg, /Verdict: 0 confirmed · 1 differ · 1 missing · 1 extra/,
    'paired misread counts as differ — NOT as missing + extra');
});

test('maybeVerify: documented hand-entered sale → OCR runs, verdict reaches admins, row patched', async () => {
  settings = {};
  const rows = new Map();
  approvalQueueRepository.getByRequestId = async (id) => rows.get(id) || null;
  const patches = [];
  approvalQueueRepository.updateActionJSON = async (id, p) => { patches.push({ id, p }); return true; };
  inventoryRepository.getAll = async () => [];
  designAssetsRepository.getAll = async () => [];
  telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('pdf'), mimeType: 'application/pdf' });
  let ocrCalls = 0;
  let ocrOpts = null;
  vision.extractBales = async (buf, mime, opts) => {
    ocrCalls += 1;
    ocrOpts = opts;
    return { ok: true, provider: 'anthropic', rawText: '', overallConfidence: 0.9, warnings: [],
      bales: [{ packageNo: '879', design: '77016', shade: '1', thanNo: 5, yards: 150, confidence: 0.9 }] };
  };
  rows.set('R1', { requestId: 'R1', user: '4242', status: 'pending', actionJSON: {
    action: 'sale_bundle', customer: 'OKESON', sale_doc_file_id: 'bill-1', sale_doc_type: 'document',
    items: [{ packageNo: '879', design: '77016', shade: '1', thans: 5, yards: 150 }],
  } });
  const bot = createFakeBot();
  const done = await svc.maybeVerify(bot, 'R1', { adminIds: ['777', '888'] });
  assert.equal(done, true);
  assert.equal(ocrCalls, 1);
  assert.equal(ocrOpts && ocrOpts.forceStrongModel, true,
    'VRF-1: the verification read ALWAYS requests the strong model (owner: precision over cost)');
  const msgs = bot.calls.filter((c) => c.method === 'sendMessage').map((c) => `${c.args.chatId}:${c.args.text}`).join('\n');
  assert.match(msgs, /777:🔬 Bill check — request R1/);
  assert.match(msgs, /888:🔬 Bill check — request R1/);
  assert.match(msgs, /The bill and the request agree/);
  assert.equal(patches.length, 1);
  assert.deepEqual({ ok: patches[0].p.docVerify.ok, missing: patches[0].p.docVerify.missing },
    { ok: 1, missing: 0 }, 'verdict persisted on the queue row');

  // Owner cost rule: snap-sourced request → NO second OCR read.
  rows.set('R2', { requestId: 'R2', user: '4242', status: 'pending', actionJSON: {
    action: 'sale_bundle', customer: 'X', sale_doc_file_id: 'bill-2', sale_doc_type: 'document',
    source: 'snap_pdf', items: [{ packageNo: '1' }],
  } });
  assert.equal(await svc.maybeVerify(bot, 'R2'), false, 'snap request skipped');
  assert.equal(ocrCalls, 1, 'no OCR spent on the snap request');

  // Kill-switch.
  settings = { PDF_VERIFY_ENABLED: 0 };
  assert.equal(await svc.maybeVerify(bot, 'R1'), false, 'PDF_VERIFY_ENABLED=0 disables the check');
  settings = {};

  // Non-sale and doc-less rows never verify.
  rows.set('R3', { requestId: 'R3', user: '4242', status: 'pending', actionJSON: { action: 'add_bank', bank_name: 'GTB' } });
  assert.equal(await svc.maybeVerify(bot, 'R3'), false);
});

test('wiring: notifyAdminsApprovalRequest launches the check (awaitVerify pins it)', async () => {
  settings = {};
  approvalQueueRepository.getByRequestId = async () => ({ requestId: 'R9', user: '4242', status: 'pending', actionJSON: {
    action: 'sell_package', customer: 'A', packageNo: '879', design: '77016', shade: '1', thans: 5, yards: 150,
    sale_doc_file_id: 'bill-9', sale_doc_type: 'document',
  } });
  telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('pdf'), mimeType: 'application/pdf' });
  vision.extractBales = async () => ({ ok: true, bales: [{ packageNo: '879', design: '77016', shade: '1', thanNo: 5, yards: 150, confidence: 0.9 }], rawText: '', overallConfidence: 0.9, warnings: [] });
  const bot = createFakeBot();
  await approvalEvents.notifyAdminsApprovalRequest(bot, 'R9', 'Abdul', 'Sale Request', 'All sale operations require admin approval.', '4242', { awaitVerify: true });
  const msgs = bot.calls.filter((c) => c.method === 'sendMessage').map((c) => c.args.text).join('\n');
  assert.match(msgs, /🔬 Bill check — request R9/, 'verdict follows the card');
});

test('CARD-2: multi-design card is sorted + grouped with per-design subtotals; single design stays flat', async () => {
  const card = await approvalCards.buildSaleCard({
    customer: 'OKESON',
    items: [
      { packageNo: '879', design: '77016', shade: '1', thans: 5, yards: 150, warehouse: 'IDUMOTA' },
      { packageNo: '844', design: '77014', shade: '2', thans: 5, yards: 150, warehouse: 'IDUMOTA' },
      { packageNo: '836', design: '77014', shade: '1', thans: 5, yards: 150, warehouse: 'IDUMOTA' },
      { packageNo: '881', design: '77016', shade: '2', thans: 5, yards: 150, warehouse: 'IDUMOTA' },
    ],
  });
  const i77014 = card.indexOf('🧵 77014 — 2 bales (10 thans), 150+150'.slice(0, 8));
  assert.match(card, /🧵 77014 — 2 bales \(10 thans\), 300 yds/);
  assert.match(card, /🧵 77016 — 2 bales \(10 thans\), 300 yds/);
  assert.ok(card.indexOf('🧵 77014') < card.indexOf('Bale 836'), 'header precedes its group');
  assert.ok(card.indexOf('Bale 836') < card.indexOf('Bale 844'), 'shade 1 before shade 2');
  assert.ok(card.indexOf('Bale 844') < card.indexOf('🧵 77016'), '77014 group closes before 77016 opens');
  assert.ok(card.indexOf('Bale 879') < card.indexOf('Bale 881'), '77016 sorted by shade');
  assert.match(card, /\n\n🧵 77016/, 'blank separator line between design groups');
  assert.match(card, /Total: 4 Bales \(20 thans\), 600 yards/, 'grand total unchanged');
  assert.ok(i77014 !== -1);

  const single = await approvalCards.buildSaleCard({
    customer: 'X',
    items: [
      { packageNo: '897', design: '77016', shade: '2', thans: 1, yards: 55 },
      { packageNo: '896', design: '77016', shade: '5', thans: 2, yards: 60 },
    ],
  });
  assert.ok(!single.includes('🧵'), 'single-design card keeps the flat layout');
  assert.ok(single.indexOf('Bale 897') < single.indexOf('Bale 896'), 'still sorted by shade');
});
