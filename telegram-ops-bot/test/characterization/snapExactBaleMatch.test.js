'use strict';

/**
 * FIX-BALEMATCH2 (11-Nov-2026) — 📸 Snap Sale: the number read from the
 * label stands for the bale that CARRIES that number (BUSINESS_RULES §1).
 *
 * The door matched the label against AVAILABLE bales by "the bale's number
 * equals the one read OR ends with it". With bale 832 sold and bale 1832
 * on the shelf (same design), a label reading 832 was taken for 1832 — on
 * the single-photo card and, silently, in a PDF batch. And with both on
 * the shelf the single photo asked "which one?" between 832 and 1832.
 *
 * Pinned:
 *  - a bale whose number IS the one read wins outright;
 *  - when that bale has nothing left, the label is reported with the
 *    door's existing "not available" wording — never moved to a longer
 *    number, in the batch not even through the details rescue;
 *  - the ending match still works when NO bale carries the number exactly,
 *    one candidate or several, exactly as before;
 *  - the design rule and the details rescue for a number that matches
 *    nothing are what they were.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb, lastKb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const vision = require(path.join(SRC, 'services/vision'));
const snapSaleFlow = require(path.join(SRC, 'flows/snapSaleFlow'));
const { matchBales, matchBatch, groupBales } = snapSaleFlow._internals;

/** One Inventory than row. */
const than = (packageNo, design, status = 'available', warehouse = 'Lagos', soldTo = '') => (
  { packageNo, design, shade: '3', warehouse, status, yards: 30, soldTo });
const nos = (list) => list.map((m) => `${m.packageNo}@${m.warehouse}`);

let inventory = [];
inventoryRepository.getAll = async () => inventory;
transactionsRepository.getCustomersByDesign = async () => [];
usersRepository.findByUserId = async () => ({ user_id: '4242', name: 'Yarima' });
auditLogRepository.append = async () => {};
telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('img'), ext: 'jpg', mimeType: 'image/jpeg' });
let ocrBales = [];
vision.extractBales = async () => ({ ok: true, provider: 'stub', rawText: '', overallConfidence: 0.9, warnings: [], bales: ocrBales });

const photoMsg = () => ({ from: { id: '4242' }, chat: { id: '4242' }, photo: [{ file_id: 'small' }, { file_id: 'label-photo' }] });
const pdfMsg = () => ({ from: { id: '4242' }, chat: { id: '4242' }, document: { file_id: 'pdf-1', mime_type: 'application/pdf', file_size: 1024 } });
/** The card the dispatcher is looking at (the flow redraws one message). */
const lastCard = (bot) => {
  const t = bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  return t.length ? String(t[t.length - 1].args.text).replace(/\\/g, '') : '';
};

/* ── the matcher, on grouped sheet rows ───────────────────────────────── */

test('grouping keeps a bale with nothing left, so its own number can be recognised', () => {
  const grouped = groupBales([than('832', '9006', 'sold', 'Lagos', 'CJE'), than('1832', '9006'), than('1832', '9006')]);
  assert.deepEqual(grouped.map((g) => [g.packageNo, g.availableThans, g.availableYards]), [['832', 0, 0], ['1832', 2, 60]]);
});

test('exact beats ending — in either sheet order, with or without a design read', () => {
  const a = groupBales([than('1832', '9006'), than('832', '9006')]);
  const z = groupBales([than('832', '9006'), than('1832', '9006'), than('20832', '9006')]);
  assert.deepEqual(nos(matchBales(a, { packageNo: '832', design: '9006' })), ['832@Lagos']);
  assert.deepEqual(nos(matchBales(z, { packageNo: '832', design: '9006' })), ['832@Lagos']);
  assert.deepEqual(nos(matchBales(a, { packageNo: '832', design: '' })), ['832@Lagos']);
});

test('the exact bale is sold: nothing matches — the longer number is not taken for it', () => {
  const grouped = groupBales([than('832', '9006', 'sold', 'Lagos', 'CJE'), than('1832', '9006')]);
  assert.deepEqual(matchBales(grouped, { packageNo: '832', design: '9006' }), []);
  assert.deepEqual(matchBales(grouped, { packageNo: '832', design: '' }), []);
});

test('the exact number in two stores, one sold out: the one with stock is the match, as before', () => {
  const grouped = groupBales([than('832', '9006', 'sold', 'Lagos', 'CJE'), than('832', '9006', 'available', 'IDUMOTA'), than('1832', '9006')]);
  assert.deepEqual(nos(matchBales(grouped, { packageNo: '832', design: '9006' })), ['832@IDUMOTA']);
});

test('the ending match still works alone — and a lettered number is exact on its digits', () => {
  assert.deepEqual(nos(matchBales(groupBales([than('997', '9006'), than('1832', '9006')]), { packageNo: '832', design: '9006' })), ['1832@Lagos']);
  assert.deepEqual(nos(matchBales(groupBales([than('1896', '77016'), than('P896', '77016')]), { packageNo: '896', design: '77016' })), ['P896@Lagos']);
});

test('two ending candidates and no exact bale: both are returned, as before', () => {
  const grouped = groupBales([than('2832', '9006'), than('1832', '9006'), than('997', '9006')]);
  assert.deepEqual(nos(matchBales(grouped, { packageNo: '832', design: '9006' })), ['2832@Lagos', '1832@Lagos']);
});

test('the design read from the label must still agree', () => {
  const grouped = groupBales([than('832', '9007'), than('1832', '9006')]);
  // The number read is on record under another design: nothing matches by
  // number (the batch then identifies by details, flagged — see below).
  assert.deepEqual(matchBales(grouped, { packageNo: '832', design: '9006' }), []);
  assert.deepEqual(nos(matchBales(grouped, { packageNo: '832', design: '9007' })), ['832@Lagos']);
});

/* ── the PDF batch pass ───────────────────────────────────────────────── */

test('batch: a label whose own bale is sold is reported "not available" — not moved to the longer number, not rescued', () => {
  const longer = groupBales([than('832', '9006', 'sold', 'Lagos', 'CJE'), than('1832', '9006')]);
  let r = matchBatch(longer, [{ packageNo: '832', design: '9006', shade: '3', confidence: 0.9 }]);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.skipped, [{ label: '832 9006', reason: 'not available in the sheet' }]);

  // Not even onto another bale of the same design through the details rescue.
  const other = groupBales([than('832', '9006', 'sold', 'Lagos', 'CJE'), than('997', '9006')]);
  r = matchBatch(other, [{ packageNo: '832', design: '9006', shade: '3', confidence: 0.9 }]);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.skipped, [{ label: '832 9006', reason: 'not available in the sheet' }]);
});

test('batch: exact beats ending, the ending match alone still matches silently, two endings are kept aside — as before', () => {
  let r = matchBatch(groupBales([than('1832', '9006'), than('832', '9006')]), [{ packageNo: '832', design: '9006', confidence: 0.9 }]);
  assert.deepEqual(nos(r.items), ['832@Lagos']);
  assert.equal(r.items[0]._rescued, undefined);

  r = matchBatch(groupBales([than('997', '9006'), than('1832', '9006')]), [{ packageNo: '832', design: '9006', confidence: 0.9 }]);
  assert.deepEqual(nos(r.items), ['1832@Lagos']);
  assert.equal(r.items[0]._rescued, undefined, 'matched by number, not flagged — unchanged');

  r = matchBatch(groupBales([than('2832', '9006'), than('1832', '9006')]), [{ packageNo: '832', design: '9006', confidence: 0.9 }]);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.skipped, [{ label: '832 9006', reason: 'could be 2832 (Lagos) or 1832 (Lagos) — kept aside' }]);
});

test('batch: the details rescue is what it was when the number read is NOT the label\'s own bale', () => {
  // The number matches nothing at all → identified by details, flagged.
  let r = matchBatch(groupBales([than('1006', '9006')]), [{ packageNo: '2522', design: '9006', shade: '3', confidence: 0.8 }]);
  assert.deepEqual(nos(r.items), ['1006@Lagos']);
  assert.match(r.items[0]._rescued, /label read "2522 9006"/);

  // The number is on record under ANOTHER design → still the rescue.
  r = matchBatch(groupBales([than('832', '9007'), than('1006', '9006')]), [{ packageNo: '832', design: '9006', shade: '3', confidence: 0.8 }]);
  assert.deepEqual(nos(r.items), ['1006@Lagos']);
  assert.match(r.items[0]._rescued, /label read "832 9006"/);

  // Only a SOLD longer number ends in the digits (no exact bale) → still the rescue.
  r = matchBatch(groupBales([than('1832', '9006', 'sold', 'Lagos', 'CJE'), than('1006', '9006')]), [{ packageNo: '832', design: '9006', shade: '3', confidence: 0.8 }]);
  assert.deepEqual(nos(r.items), ['1006@Lagos']);
  assert.match(r.items[0]._rescued, /label read "832 9006"/);

  // A sold bale is never a rescue candidate.
  r = matchBatch(groupBales([than('1006', '9006', 'sold', 'Lagos', 'CJE')]), [{ packageNo: '2522', design: '9006', shade: '3', confidence: 0.8 }]);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.skipped, [{ label: '2522 9006', reason: 'not available in the sheet' }]);
});

/* ── through the real controller ──────────────────────────────────────── */

test('single photo: the bale on the label is sold → the "No AVAILABLE bale" card, never the longer number', async () => {
  inventory = [than('832', '9006', 'sold', 'Lagos', 'CJE'), than('1832', '9006'), than('1832', '9006')];
  ocrBales = [{ packageNo: '832', design: '9006', shade: '3', yards: 150, confidence: 0.92 }];
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, photoMsg());
  const card = lastCard(bot);
  assert.match(card, /Read from label: Bale \*832\* · Design \*9006\*/);
  assert.match(card, /⚠️ No AVAILABLE bale in the sheet matches this label — it may be sold already or recorded differently\./);
  assert.doesNotMatch(bot.allText(), /Matched bale|1832/);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'act:sell_bale'), 'the door\'s own way out is offered, as before');
  assert.ok(!sessionStore.get('4242').bale, 'no bale was picked');
  sessionStore.clear('4242');
});

test('single photo: 832 and 1832 both on the shelf → 832 is matched straight away, no "which one?" between them', async () => {
  inventory = [than('1832', '9006'), than('832', '9006'), than('832', '9006')];
  ocrBales = [{ packageNo: '832', design: '9006', shade: '3', yards: 60, confidence: 0.92 }];
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, photoMsg());
  const card = lastCard(bot);
  assert.match(card, /Matched bale — confirm dispatch/);
  assert.match(card, /📦 Bale \*832\* — 9006/);
  assert.match(card, /Lagos · 2 thans · 60 yds available/);
  assert.doesNotMatch(bot.allText(), /more than one place/);
  assert.equal(sessionStore.get('4242').bale.packageNo, '832');
  sessionStore.clear('4242');
});

test('single photo: no bale carries the number exactly → the ending match, as before (one: matched · two: "which one?")', async () => {
  inventory = [than('997', '9006'), than('1832', '9006')];
  ocrBales = [{ packageNo: '832', design: '9006', shade: '3', yards: 30, confidence: 0.92 }];
  let bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, photoMsg());
  assert.match(lastCard(bot), /Read from label: Bale \*832\*/);
  assert.match(lastCard(bot), /📦 Bale \*1832\* — 9006/);
  sessionStore.clear('4242');

  inventory = [than('2832', '9006'), than('1832', '9006')];
  bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, photoMsg());
  assert.match(lastCard(bot), /This bale number exists in more than one place — which one\?/);
  assert.deepEqual(lastKb(bot).filter((b) => b.callback_data.startsWith('sns:m:')).map((b) => b.text),
    ['📦 2832 · 9006 · Lagos', '📦 1832 · 9006 · Lagos']);
  sessionStore.clear('4242');
});

test('PDF batch: the sold bale\'s label is listed as skipped "not available in the sheet"; the rest of the batch goes on', async () => {
  inventory = [than('832', '9006', 'sold', 'Lagos', 'CJE'), than('1832', '9006'), than('897', '77016')];
  ocrBales = [
    { packageNo: '832', design: '9006', shade: '3', confidence: 0.9 },
    { packageNo: '897', design: '77016', shade: '3', confidence: 0.9 },
  ];
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:snap_sale'));
  await controller.handleFileMessage(bot, pdfMsg());
  const review = lastCard(bot);
  assert.match(review, /PDF batch — 1 bale\(s\) matched/);
  assert.match(review, /✅ \*897\* — 77016/);
  assert.match(review, /⚠️ 832 9006 — not available in the sheet \(skipped\)/);
  assert.doesNotMatch(review, /1832/);
  assert.deepEqual(sessionStore.get('4242').batch.items.map((i) => i.packageNo), ['897']);
  sessionStore.clear('4242');
});
