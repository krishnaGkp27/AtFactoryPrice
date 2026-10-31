'use strict';

/**
 * SELL-T3 — the deterministic than-list shorthand. Pure parsing: no AI,
 * no sheet, so it keeps working when the provider is down.
 *
 * The grammar rule that carries the weight: a COMMA always starts a new
 * bale, several thans of one bale join with `+` or a `-` range. Without
 * that, "1100/1, 2" is indistinguishable from "bale 2" and the bot would
 * have to guess — which BUSINESS_RULES §2 forbids.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseThanList, looksLikeThanList } = require('../../../src/utils/thanListParser');

test('looksLikeThanList: only claims text it can actually parse', () => {
  assert.equal(looksLikeThanList('sell 1100/1, 1091/1 kano'), true);
  assert.equal(looksLikeThanList('sell 1100 x3'), true);
  assert.equal(looksLikeThanList('Sell 1100/2'), true);
  // Whole-bale typed sales keep their existing path.
  assert.equal(looksLikeThanList('sell bale 1100 to Adamu'), false);
  assert.equal(looksLikeThanList('transfer 1100 to kano'), false);
  assert.equal(looksLikeThanList(''), false);
});

test('Abdul’s real line: one than from five different bales + store', () => {
  const out = parseThanList('sell 1100/1, 1091/1, 1082/1, 1122/1, 1113/1 kano');
  assert.deepEqual(out.items, [
    { packageNo: '1100', thans: [1] },
    { packageNo: '1091', thans: [1] },
    { packageNo: '1082', thans: [1] },
    { packageNo: '1122', thans: [1] },
    { packageNo: '1113', thans: [1] },
  ]);
  assert.equal(out.warehouseHint, 'kano');
  assert.deepEqual(out.bad, []);
});

test('several thans of one bale: + list and - range, deduped', () => {
  assert.deepEqual(parseThanList('sell 1100/1+2+3').items, [{ packageNo: '1100', thans: [1, 2, 3] }]);
  assert.deepEqual(parseThanList('sell 1100/1-3').items, [{ packageNo: '1100', thans: [1, 2, 3] }]);
  assert.deepEqual(parseThanList('sell 1100/2+2+5').items, [{ packageNo: '1100', thans: [2, 5] }]);
});

test('"x3" asks for a count — it never names thans (the human picks)', () => {
  const out = parseThanList('sell 1100 x3 from Kano office');
  assert.deepEqual(out.items, [{ packageNo: '1100', count: 3 }]);
  assert.equal(out.warehouseHint, 'Kano office');
});

test('a comma-separated than run is NOT silently read as thans', () => {
  // "1100/1, 2, 3" means bale 2 and bale 3 by the grammar — the flow will
  // report them as not found, and the hint tells him to use `+`.
  const out = parseThanList('sell 1100/1, 2, 3');
  assert.deepEqual(out.items, [
    { packageNo: '1100', thans: [1] }, { packageNo: '2' }, { packageNo: '3' },
  ]);
  assert.equal(out.commaThanHint, true, 'the + hint is raised instead of guessing');
});

test('warehouse hint: from / @ / trailing words, noise words stripped', () => {
  assert.equal(parseThanList('sell 1100/1 from kano office').warehouseHint, 'kano office');
  assert.equal(parseThanList('sell 1100/1 @ Idumota').warehouseHint, 'Idumota');
  assert.equal(parseThanList('sell 1100/1 Lagos').warehouseHint, 'Lagos');
  assert.equal(parseThanList('sell 1100/1').warehouseHint, '');
  // "than"/"package" are noise, not a warehouse called "than".
  assert.equal(parseThanList('sell 1100/1 than').warehouseHint, '');
});

test('unreadable tokens are reported, never guessed at', () => {
  const out = parseThanList('sell 1100/abc, 1091/1');
  assert.deepEqual(out.items, [{ packageNo: '1091', thans: [1] }]);
  assert.deepEqual(out.bad, ['1100/abc']);
});

/* ── SELL-T3b: Abdul writes the whole sale on one line ── */

test('Abdul’s real message: store, customer and date all survive the parse', () => {
  const out = parseThanList(
    'Sell 1108/1, 1126/1, 1120/1, 1093/1, 1085/1 from kano office to karibullah, 06 august 2026');
  assert.deepEqual(out.items.map((i) => i.packageNo), ['1108', '1126', '1120', '1093', '1085'],
    'the LAST bale is no longer eaten by the customer/date tail');
  assert.deepEqual(out.items[4], { packageNo: '1085', thans: [1] });
  assert.equal(out.warehouseHint, 'kano office');
  assert.equal(out.ignoredCustomer, 'karibullah');
  assert.equal(out.ignoredDate, '06 august 2026');
  assert.deepEqual(out.bad, [], 'nothing is reported as unreadable');
});

test('a customer clause never becomes the store name', () => {
  const out = parseThanList('sell 1100/1+2 from Kano office to ABBA');
  assert.equal(out.warehouseHint, 'Kano office');
  assert.equal(out.ignoredCustomer, 'ABBA');
  assert.deepEqual(out.items, [{ packageNo: '1100', thans: [1, 2] }]);
});

test('a date with no comma is lifted out, not read as a than or a store', () => {
  const out = parseThanList('sell 1100/1 6/8/2026');
  assert.deepEqual(out.items, [{ packageNo: '1100', thans: [1] }], 'the date is not a than number');
  assert.equal(out.ignoredDate, '6/8/2026');
  assert.equal(out.warehouseHint, '', 'a date is never a store name');
});

test('"and" separates bales exactly like a comma', () => {
  assert.deepEqual(parseThanList('sell 1100/1 and 1091/2').items, [
    { packageNo: '1100', thans: [1] }, { packageNo: '1091', thans: [2] },
  ]);
});

// RET-5 — the typed RETURN line shares the grammar; a bare-only list qualifies.
const { looksLikeReturnList } = require('../../../src/utils/thanListParser');

test('looksLikeReturnList: a "Return …" line with a number, bare bales included', () => {
  assert.equal(looksLikeReturnList('Return 771, 779, 6189/5'), true);
  assert.equal(looksLikeReturnList('return 771'), true);
  assert.equal(looksLikeReturnList('Return 771 x3, 6189/1+2'), true);
  assert.equal(looksLikeReturnList('Return than 2 from Bale 5801'), false, 'a worded line is the intent parser\'s');
  assert.equal(looksLikeReturnList('Return 771 from Kafaya'), false);
  assert.equal(looksLikeReturnList('returned goods from kafaya'), false);
  assert.equal(looksLikeReturnList('Return the goods'), false);
  assert.equal(looksLikeReturnList('sell 771'), false);
});

test('parseThanList strips the return verb and reads bare bales, thans and x-counts', () => {
  const out = parseThanList('Return 771, 779, 6189/5, 6210/1+2, 700 x3');
  assert.deepEqual(out.items, [
    { packageNo: '771' }, { packageNo: '779' }, { packageNo: '6189', thans: [5] },
    { packageNo: '6210', thans: [1, 2] }, { packageNo: '700', count: 3 },
  ]);
  assert.equal(out.warehouseHint, '');
  assert.equal(parseThanList('Return 771 from Kafaya').warehouseHint, 'Kafaya', 'a trailing name surfaces so the flow can say it ignored it');
});

// ── TRF-23 — the typed transfer line is read locally (owner's Go, 31-Oct-2026)
const { looksLikeTransferLine } = require('../../../src/utils/thanListParser');

test('looksLikeTransferLine: Abdul’s four real lines of 31-Oct all qualify', () => {
  assert.equal(looksLikeTransferLine('Transfer package 832,1186,786,812,828,1193,1202,802,1191,822,1111,1328 to kano'), true);
  assert.equal(looksLikeTransferLine('Transfer 832,1186,786,812,828,1193,1202,802,1191,822,1111,1328 to kano'), true);
  assert.equal(looksLikeTransferLine('Transfer 832, 1186, 786, 812, 828, 1193, 1202, 802, 1191, 822, 1111, 1328 to kano'), true);
  assert.equal(looksLikeTransferLine('Transfer package 832, 1186, 786, 812, 828, 1193, 1202, 802, 1191, 822, 1111, 1328 to kano'), true);
});

test('looksLikeTransferLine: the verb opens the line, a number follows', () => {
  assert.equal(looksLikeTransferLine('Move package 5804 to Lagos warehouse'), true);
  assert.equal(looksLikeTransferLine('please transfer 5801 to kano'), true);
  assert.equal(looksLikeTransferLine('Transfer than 3 from package 5801 to Kano'), true);
  assert.equal(looksLikeTransferLine('transfer 6189/5, 6210/5 to kano'), true);
  // No number → not a bale line: the AI (or the wizard) keeps it.
  assert.equal(looksLikeTransferLine('Transfer stock'), false);
  assert.equal(looksLikeTransferLine('Move Stock'), false);
  // The verb is not at the front → the AI reads the sentence.
  assert.equal(looksLikeTransferLine('Can you transfer 5801 to kano'), false);
  // Other doors are never hijacked.
  assert.equal(looksLikeTransferLine('sell 1100/1, 1091/1 kano'), false);
  assert.equal(looksLikeTransferLine('Return 771, 779'), false);
  assert.equal(looksLikeTransferLine(''), false);
  assert.equal(looksLikeTransferLine(null), false);
});
