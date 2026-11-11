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
  // SELL-T3d (04-Nov-2026) — a bare-only list is read locally too.
  assert.equal(looksLikeThanList('sell bale 1100 to Adamu'), true);
  assert.equal(looksLikeThanList('Sell 1111,1112 to Abba'), true);
  assert.equal(looksLikeThanList('Sell 1111, 1112 and 1113 to Abba'), true);
  assert.equal(looksLikeThanList('sell 1111 1112 kano'), true);
  assert.equal(looksLikeThanList('Sell packages 5801, 5802 to Ibrahim, sold by Yarima'), true);
  // The worded than form is not the list grammar — its 3 is a than.
  assert.equal(looksLikeThanList('Sell than 3 from package 5801 to Ibrahim'), false);
  // A count, not a bale number.
  assert.equal(looksLikeThanList('Sell 5 bales of 9006 to Abba'), false);
  assert.equal(looksLikeThanList('sell'), false);
  assert.equal(looksLikeThanList('sell to Abba'), false);
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

// ── SELL-T3d (owner's Go, 04-Nov-2026) — the bare-only sell line, parsed
test('bare-only sell line: every number is a whole bale, the buyer rides the tail', () => {
  const out = parseThanList('Sell 1111,1112 to Abba');
  assert.deepEqual(out.items, [{ packageNo: '1111' }, { packageNo: '1112' }]);
  assert.equal(out.ignoredCustomer, 'Abba');
  assert.deepEqual(out.bad, []);
  const two = parseThanList('sell bale 1100 to Adamu');
  assert.deepEqual(two.items, [{ packageNo: '1100' }]);
  assert.equal(two.ignoredCustomer, 'Adamu');
});

// ── FIX-TYPED (11-Nov-2026) — SPACES separate bale numbers too (SELL-T3d
// says "commas, and, or spaces"). Before: only the first number of a
// space-joined run was read; the rest was dropped silently, or glued onto
// the store name ("I don't know a store called 1112 kano").
test('a space-joined bare list reads EVERY bale; the store and the buyer still ride the tail', () => {
  const two = parseThanList('sell 1111 1112');
  assert.deepEqual(two.items, [{ packageNo: '1111' }, { packageNo: '1112' }]);
  assert.equal(two.warehouseHint, '');
  assert.deepEqual(two.bad, []);
  assert.equal(two.commaThanHint, false);

  const store = parseThanList('sell 1111 1112 kano');
  assert.deepEqual(store.items, [{ packageNo: '1111' }, { packageNo: '1112' }]);
  assert.equal(store.warehouseHint, 'kano', 'the second bale is not part of the store name');

  const buyer = parseThanList('Sell 1111 1112 1113 to Abba');
  assert.deepEqual(buyer.items.map((i) => i.packageNo), ['1111', '1112', '1113']);
  assert.equal(buyer.ignoredCustomer, 'Abba');
  assert.equal(buyer.warehouseHint, '');

  const both = parseThanList('sell bales 771 779 from Kano office to Abba');
  assert.deepEqual(both.items, [{ packageNo: '771' }, { packageNo: '779' }]);
  assert.equal(both.warehouseHint, 'Kano office');
  assert.equal(both.ignoredCustomer, 'Abba');
});

test('space-joined: the 771 x3 and 6189/5 tokens keep their meaning anywhere in the run', () => {
  const out = parseThanList('sell 771 x3 6189/5 1111 6210/1+2 kano');
  assert.deepEqual(out.items, [
    { packageNo: '771', count: 3 },
    { packageNo: '6189', thans: [5] },
    { packageNo: '1111' },
    { packageNo: '6210', thans: [1, 2] },
  ]);
  assert.equal(out.warehouseHint, 'kano');
  assert.deepEqual(out.bad, []);
  // Mixed with commas and "and": every separator works in one line.
  assert.deepEqual(parseThanList('sell 771 779, 6189/5 and 1111 1112').items, [
    { packageNo: '771' }, { packageNo: '779' }, { packageNo: '6189', thans: [5] },
    { packageNo: '1111' }, { packageNo: '1112' },
  ]);
});

test('space-joined: a date after the bales is still a date, never a bale or a than', () => {
  const out = parseThanList('sell 1111 1112 06/08/2026');
  assert.deepEqual(out.items, [{ packageNo: '1111' }, { packageNo: '1112' }]);
  assert.equal(out.ignoredDate, '06/08/2026');
  const dash = parseThanList('sell 1100/1 1091/1 kano 6-8-2026');
  assert.deepEqual(dash.items, [{ packageNo: '1100', thans: [1] }, { packageNo: '1091', thans: [1] }]);
  assert.equal(dash.warehouseHint, 'kano');
  assert.equal(dash.ignoredDate, '6-8-2026');
});

test('space-joined: an unreadable than spec in the run is reported, the bales around it are kept', () => {
  const out = parseThanList('sell 1111 1100/abc 1112 kano');
  assert.deepEqual(out.items, [{ packageNo: '1111' }, { packageNo: '1112' }]);
  assert.deepEqual(out.bad, ['1100/abc']);
  assert.equal(out.warehouseHint, 'kano');
});

test('space-joined: what was NOT a bale list before is still not one', () => {
  // A count sentence — not claimed by the pre-check, and the parse does not
  // start reading the design number as a bale.
  assert.equal(looksLikeThanList('Sell 5 bales of 9006'), false);
  assert.deepEqual(parseThanList('Sell 5 bales of 9006').items, [{ packageNo: '5' }]);
  // (A two-digit count was already read as bale 10 before — unchanged.)
  assert.deepEqual(parseThanList('Sell 10 bales of 9006').items, [{ packageNo: '10' }]);
  // The worded than form stays the AI's / the chips card's.
  assert.equal(looksLikeThanList('Sell than 3 from package 5801'), false);
  // A single small number after an item is not a bale number (two digits or
  // more) — it stays in the tail exactly as before.
  const one = parseThanList('sell 1100/1 2');
  assert.deepEqual(one.items, [{ packageNo: '1100', thans: [1] }]);
  assert.equal(one.commaThanHint, false);
  // Words between the numbers end the run: the tail is read as before.
  const tail = parseThanList('sell 1100 x3 from Kano office');
  assert.deepEqual(tail.items, [{ packageNo: '1100', count: 3 }]);
  assert.equal(tail.warehouseHint, 'Kano office');
});

test('the RETURN line shares the tokeniser: Return 771 779 6189/5 reads all three', () => {
  assert.equal(looksLikeReturnList('Return 771 779 6189/5'), true);
  const out = parseThanList('Return 771 779 6189/5');
  assert.deepEqual(out.items, [{ packageNo: '771' }, { packageNo: '779' }, { packageNo: '6189', thans: [5] }]);
  assert.deepEqual(out.bad, []);
});
