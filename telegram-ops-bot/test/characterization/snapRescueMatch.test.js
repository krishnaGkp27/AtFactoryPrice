'use strict';

/**
 * SNAP-6 — rescue matching (owner 22-Jul): labels whose bale NUMBER matches
 * nothing (indent-as-bale OCR confusion, misread digits, unreadable number)
 * are identified by their OTHER attributes — design, shade, pieces,
 * meterage — searched across EVERY store. Unique corroborated candidate →
 * auto-included flagged 🔎; shortlist → tap-to-pick; nothing → skip.
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
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const vision = require(path.join(SRC, 'services/vision'));
const snapSaleFlow = require(path.join(SRC, 'flows/snapSaleFlow'));
const { matchBatch, rescueMatch, normCode } = snapSaleFlow._internals;
const { PROMPT } = require(path.join(SRC, 'services/vision/labelExtraction'));

// Sheet: 9060-B bales in two stores; one lone 7160A; two 9032 in Lagos.
function grouped() {
  return [
    { packageNo: '1001', design: '9060-B', shade: '3', warehouse: 'IDUMOTA', availableThans: 7, availableYards: 210 },
    { packageNo: '1006', design: '9060-A', shade: '2', warehouse: 'IDUMOTA', availableThans: 7, availableYards: 210 },
    { packageNo: '2201', design: '7160A', shade: '1', warehouse: 'Lagos', availableThans: 5, availableYards: 150 },
    { packageNo: '6261', design: '9032', shade: '4', warehouse: 'Lagos', availableThans: 4, availableYards: 138 },
    { packageNo: '6262', design: '9032', shade: '4', warehouse: 'Lagos', availableThans: 4, availableYards: 120 },
  ];
}

test('prompt: the INDENT vs BALE NO. distinction is spelled out for the model', () => {
  assert.match(PROMPT, /BALE NO\. and INDENT NO\. are DIFFERENT/);
  assert.match(PROMPT, /never\nput the indent value there|never put the indent value there/i);
});

test('indent-as-bale label is rescued via design+shade across stores, flagged 🔎', () => {
  // Claude read the indent (2522) as the number; design 9060A (hyphen lost).
  const { items, skipped } = matchBatch(grouped(), [
    { packageNo: '2522', design: '9060A', shade: '2', thanNo: 7, yards: 210, confidence: 0.8 },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].packageNo, '1006', 'the only available 9060-A anywhere');
  assert.match(items[0]._rescued, /label read "2522 9060A"/);
  assert.equal(skipped.length, 0);
});

test('unreadable bale number (packageNo empty) still rescues by details', () => {
  const { items } = matchBatch(grouped(), [
    { packageNo: '', design: '7160-A', shade: '1', thanNo: 5, yards: 150, confidence: 0.6 },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].packageNo, '2201');
  assert.match(items[0]._rescued, /\(no number\) 7160-A/);
});

test('6b: corroboration breaks ties; a true tie is KEPT ASIDE with candidates named — never a question', () => {
  // Two 9032 bales; label meterage 138 corroborates 6261 uniquely.
  const byYards = matchBatch(grouped(), [
    { packageNo: '999', design: '9032', shade: '4', thanNo: 0, yards: 138, confidence: 0.7 },
  ]);
  assert.equal(byYards.items.length, 1);
  assert.equal(byYards.items[0].packageNo, '6261', 'meterage picked the right one');
  // No corroborating details at all → kept aside with the analysis, no guess.
  const noHint = matchBatch(grouped(), [
    { packageNo: '999', design: '9032', shade: '4', thanNo: 0, yards: 0, confidence: 0.7 },
  ]);
  assert.equal(noHint.items.length, 0);
  assert.equal(noHint.skipped.length, 1);
  assert.match(noHint.skipped[0].reason, /could be 6261 \(Lagos\) or 6262 \(Lagos\) — kept aside/);
  // Unknown design → honest skip.
  const unknown = matchBatch(grouped(), [
    { packageNo: '4444', design: '5555', shade: '9', thanNo: 1, yards: 30, confidence: 0.7 },
  ]);
  assert.equal(unknown.skipped.length, 1);
  assert.match(unknown.skipped[0].reason, /not available/);
});

test('normalised design compare + dedupe: 9060-A / 9060A / "9060 a" are ONE label', () => {
  assert.equal(normCode('9060-A'), normCode('9060 a'));
  const { items } = matchBatch(grouped(), [
    { packageNo: '2522', design: '9060-A', shade: '2', thanNo: 7, yards: 210, confidence: 0.8 },
    { packageNo: '2522', design: '9060A', shade: '2', thanNo: 7, yards: 210, confidence: 0.8 },
  ]);
  assert.equal(items.length, 1, 'duplicate re-reads collapse after normalisation');
});

test('a rescued bale is never double-assigned to a second label', () => {
  const r1 = rescueMatch(grouped(), { packageNo: '2522', design: '9060A', shade: '2' }, new Set());
  assert.equal(r1.cand.packageNo, '1006');
  const r2 = rescueMatch(grouped(), { packageNo: '2523', design: '9060A', shade: '2' }, new Set(['IDUMOTA|1006']));
  assert.equal(r2.cand, null, 'already-taken bale is off the table');
});

test('end-to-end 6b: PDF with a rescue + a tie → NO questions — straight to review, tie kept aside', async () => {
  inventoryRepository.getAll = async () => [
    { packageNo: '1006', design: '9060-A', shade: '2', warehouse: 'IDUMOTA', status: 'available', yards: 30 },
    { packageNo: '6261', design: '9032', shade: '4', warehouse: 'Lagos', status: 'available', yards: 35 },
    { packageNo: '6262', design: '9032', shade: '4', warehouse: 'Lagos', status: 'available', yards: 35 },
  ];
  transactionsRepository.getCustomersByDesign = async () => ['ALABI'];
  usersRepository.findByUserId = async () => ({ user_id: '4242', name: 'Yarima' });
  auditLogRepository.append = async () => {};
  const queued = [];
  approvalQueueRepository.append = async (r) => { queued.push(r); };
  telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('pdf'), ext: 'pdf', mimeType: 'application/pdf' });
  vision.extractBales = async () => ({
    ok: true, provider: 'anthropic', rawText: '', overallConfidence: 0.9, warnings: [],
    bales: [
      { packageNo: '2522', design: '9060-A', shade: '2', thanNo: 1, yards: 33, confidence: 0.8 },  // rescue
      { packageNo: '999', design: '9032', shade: '4', thanNo: 0, yards: 0, confidence: 0.7 },      // ambiguous pair
    ],
  });

  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, {
    from: { id: '4242' }, chat: { id: '4242' },
    document: { file_id: 'pdf-1', mime_type: 'application/pdf', file_size: 1024 },
  });
  // 6b: NO question screen — the review comes straight back.
  const review = bot.allText().replace(/\\/g, '');
  assert.ok(!review.includes('Which bale is this?'), 'never asks after processing');
  assert.match(review, /1 bale\(s\) matched/);
  assert.match(review, /🔎 \*1006\*.*by details \(label read "2522 9060-A"\)/);
  assert.match(review, /999 9032 — could be 6261 \(Lagos\) or 6262 \(Lagos\) — kept aside \(skipped\)/);
  // Submit → the admin card carries the rescue note + the kept-aside analysis.
  const buyer = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup)
    .pop().args.opts.reply_markup.inline_keyboard.flat().find((b) => b.text === '👤 ALABI');
  await controller.handleCallbackQuery(bot, cb(buyer.callback_data));
  await controller.handleCallbackQuery(bot, cb('sns:ok'));
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].actionJSON.items.map((i) => i.packageNo), ['1006'], 'only the certain bale rides');
  const adminMsgs = bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777')
    .map((c) => c.args.text).join('\n').replace(/\\/g, '');
  assert.match(adminMsgs, /Identified by label DETAILS, not by number \(1\)/);
  assert.match(adminMsgs, /could be 6261 \(Lagos\) or 6262 \(Lagos\)/);
  assert.ok(!sessionStore.get('4242'), 'session cleared after submit');
});
