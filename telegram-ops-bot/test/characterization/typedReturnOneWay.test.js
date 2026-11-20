'use strict';
/**
 * RET-7 (owner, 20-Nov-2026) — ONE way to type a return.
 *
 * Abdul typed a return three ways and got the generic chips card each time:
 *   Return 631/1+2+3+4+5,614/1 to Idumota
 *   Return package 631/1+2+3+4+5,614/1 to Idumota
 *   Return package from soldier madam 631/1+2+3+4+5,614/1 to Idumota
 * Owner: "I want to close all other door of this script … a single window
 * should be there for all this process so that they should not go and make
 * any mistake for my employees."
 *
 * So: `Return` + numbers only opens the card. Every other message that opens
 * with Return gets the ONE line back — nothing is read out of its words.
 */
process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

const INV_HEADERS = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
function invRow(pkg, than, status, soldTo, wh, design, shade, rate) {
  return [pkg, '', '', design, shade, String(than), '30', status, wh, String(rate), '2026-07-01',
    soldTo, soldTo ? '2026-08-20' : '', '', '', '', 'fabric', `UID-${pkg}-${than}`, '2026-07-01', '', '', 'Jul26', ''];
}
const CUS_HEADERS = ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases'];
installFakeSheets(createFakeSheets({
  Inventory: [
    INV_HEADERS,
    ...[1, 2, 3, 4, 5].map((t) => invRow('631', t, 'sold', 'Soldier Madam', 'IDUMOTA', '9043-B', '4', 1500)),
    invRow('631', 6, 'available', '', 'IDUMOTA', '9043-B', '4', 1500),
    invRow('614', 1, 'sold', 'Soldier Madam', 'IDUMOTA', '9043-A', '7', 1500),
    invRow('614', 2, 'available', '', 'IDUMOTA', '9043-A', '7', 1500),
    invRow('700', 1, 'sold', 'ABBA', 'Lagos', '9006', '1', 1000),
    invRow('635', 1, 'sold', 'ABBA', 'Lagos', '9006', '1', 1000),
  ],
  Customers: [
    CUS_HEADERS,
    ['CUS-S', 'Soldier Madam', '080', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
    ['CUS-A', 'ABBA', '081', '', '', 0, 0, '', '', 'Active', '', '', '[]'],
  ],
}));
// An AI that WOULD read a return sentence, to prove the return door never asks it.
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return { action: 'return_package', packageNo: '700', confidence: 0.9 }; });
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const returnBundleFlow = require(path.join(SRC, 'flows/returnBundleFlow'));
const typedRouter = require(path.join(SRC, 'utils/typedRouter'));
usersRepository.getAll = async () => [];
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}`, role: id === '555' ? 'employee' : 'admin' });
auditLogRepository.append = async () => {};

const EMP = '555';
const message = (text) => ({ chat: { id: EMP }, from: { id: EMP, first_name: 'Abdul' }, text });
const lastText = (bot) => bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).pop().args.text.replace(/\\/g, '');
const FORMAT = returnBundleFlow._internals.formatCardText();

async function type(line, { keep = false, bot = createFakeBot() } = {}) {
  if (!keep) sessionStore.clear(EMP);
  await controller.handleMessage(bot, message(line));
  return { bot, text: lastText(bot), session: sessionStore.get(EMP) };
}

test('RET-7: the one line — Return and numbers — opens the return card', async () => {
  const { text, session } = await type('Return 631/1+2+3+4+5, 614/1');
  assert.match(text, /^↩️ \*Return\* · 🏭 IDUMOTA\n📦 6t · 180 yd\n/);
  assert.match(text, /👤 Soldier Madam · 6t · 180 yd/);
  for (const t of ['631/1', '631/2', '631/3', '631/4', '631/5', '614/1']) assert.ok(text.includes(`${t} · 30 yd`), t);
  assert.equal(session.type, 'return_bundle_flow');
  // spacing, capitals and line breaks do not matter; the numbers do
  for (const l of ['return 631/1+2+3+4+5,614/1', 'RETURN  631/1+2+3+4+5 , 614/1', 'Return 631/1+2+3+4+5\n614/1']) {
    const again = await type(l);
    assert.equal(again.session && again.session.type, 'return_bundle_flow', l);
    assert.ok(again.text.includes('614/1 · 30 yd'), l);
  }
});

test('RET-7: Abdul\'s three lines — and every other wording — get the ONE line back, in every AI mode', async () => {
  const lines = [
    'Return 631/1+2+3+4+5,614/1 to Idumota',
    'Return package 631/1+2+3+4+5,614/1 to Idumota',
    'Return package from soldier madam 631/1+2+3+4+5,614/1 to Idumota',
    'Return than 2 from Bale 631',
    'Return Bale 700',
    'Returned goods from Abba',
    'Return 5 bales of 9006',
    'Return 631/1 abba',
    'Return: 631/1',
    'Return',
  ];
  for (const mode of ['0', 'reads', '1']) {
    typedRouter.forceMode(mode);
    for (const line of lines) {
      intentCalls = 0;
      const { bot, text, session } = await type(line);
      assert.equal(text, FORMAT, `${mode} · ${line}`);
      assert.equal(bot.calls.filter((c) => c.method === 'sendMessage').length, 1, `${mode} · ${line}: one answer`);
      assert.ok(!session, `${mode} · ${line}: no card is opened, nothing is loaded`);
      assert.equal(intentCalls, 0, `${mode} · ${line}: the AI is never asked about a Return line`);
      assert.doesNotMatch(bot.allText(), /I work with the chips/, `${mode} · ${line}`);
    }
  }
  typedRouter.forceMode('1');
  assert.match(FORMAT, /^↩️ Return — type it one way only\n\nReturn 631\/1\+2\+3, 614\n/);
  assert.match(FORMAT, /Numbers only\. No customer name, no store, no other word\./);
});

test('RET-7: a message that only starts LIKE the word is not the return door\'s', async () => {
  const p = require(path.join(SRC, 'utils/thanListParser'));
  for (const l of ['Returnable stock', 'Retur 631', 'sell 631', 'Transfer 631 to kano', '631']) assert.equal(p.isReturnLine(l), false, l);
  for (const l of ['Return 631', 'return', 'Returns 631', 'Returned 631 to Abba', 'RETURNING goods', 'Return: 631', 'Return, 631']) assert.equal(p.isReturnLine(l), true, l);
});

test('RET-7: in the one line, what cannot be placed is REPORTED — never dropped in silence', async () => {
  const range = await type('Return 631-635');
  assert.ok(range.text.includes('631'));
  assert.match(range.text, /❓ Could not read: `-635`/);
  assert.doesNotMatch(range.text, /635 · 30 yd/, 'a range of bales does not load its far end');
  const comma = await type('Return 631/1,2');
  assert.match(comma.text, /631\/1 · 30 yd/);
  assert.match(comma.text, /1100\/1\+2\+3/, 'the hint for several thans of one bale');
});

test('RET-7: on the open return card the rule is the same — numbers only; another door\'s line goes to its door', async () => {
  const { bot } = await type('Return 631/1');
  // numbers only: added
  await controller.handleMessage(bot, message('614/1'));
  assert.ok(lastText(bot).includes('614/1 · 30 yd'));
  assert.match(lastText(bot), /➕ Added 1 bale/);
  // a number with words: refused, said, nothing added
  await controller.handleMessage(bot, message('700 to Idumota'));
  const refused = lastText(bot);
  assert.match(refused, /❓ Numbers only here, like `631\/1\+2\+3, 614`\. Nothing was added\./);
  assert.doesNotMatch(refused, /700 · 30 yd/);
  assert.equal(sessionStore.get(EMP).bales.length, 2);
  // "Return …" with words, typed while the card is open: the one line, and the card's bales are untouched
  await controller.handleMessage(bot, message('Return 700 to Idumota'));
  assert.equal(sessionStore.get(EMP).bales.length, 2);
  // a line for ANOTHER door opens with a word: the return card does not swallow it
  const swallowed = async (line) => returnBundleFlow.handleText(bot, message(line));
  for (const l of ['Stock 9006 black', 'Move package 700 to Lagos', 'Details for package 700', 'Price 9006 black 1500', 'Payment 50000 Abba']) {
    assert.equal(await swallowed(l), false, l);
  }
  assert.equal(sessionStore.get(EMP).bales.length, 2);
});

// ── the independent check of RET-7 (same day) ───────────────────────────────

const { cb } = require('../helpers/charFixture');

test('RET-7: what stands in front of the word is not wording — "/return", "please return", an emoji', async () => {
  for (const line of ['/return 631/1', 'Please return 631/1 to Abba', 'pls return 631/1', 'Kindly return 631/1', '↩️ Return 631/1 to Idumota']) {
    const { text, session } = await type(line);
    assert.equal(text, FORMAT, line);
    assert.ok(!session, line);
  }
});

test('RET-7: a full stop at the end is not wording; a piece that cannot be read is named', async () => {
  const stop = await type('Return 631/1+2, 614.');
  assert.equal(stop.session && stop.session.type, 'return_bundle_flow');
  assert.ok(stop.text.includes('631/1 · 30 yd') && stop.text.includes('631/2 · 30 yd'));
  assert.doesNotMatch(stop.text, /Could not read/);
  // in the one format, but its only piece cannot be read: the card says which piece
  const bad = await type('Return 631/5-3');
  assert.equal(bad.text, `❓ Could not read: 631/5-3\n\n${FORMAT}`);
  assert.ok(!bad.session);
  // read in part: the card opens and says so at the TOP
  const part = await type('Return 631-635');
  assert.match(part.text, /^↩️ \*Return\*[^\n]*\n[^\n]*\n\n⚠️ \*Part of your line was not read\.\* Check the list before you continue\./);
  assert.match(part.text, /❓ Could not read: `-635`/);
});

test('RET-7: one return at a time — a new Return line never throws away the one under way', async () => {
  const { bot } = await type('Return 631/1');
  await controller.handleMessage(bot, message('614/1'));
  const cardId = sessionStore.get(EMP).flowMessageId;
  await controller.handleCallbackQuery(bot, cb('rb:go', EMP, cardId));            // → the date step
  const before = JSON.stringify(sessionStore.get(EMP).bales.map((b) => b.packageNo));
  const step = sessionStore.get(EMP).step;
  assert.notEqual(step, 'review');
  // a condition / confirm step: the line is refused and the return stays
  sessionStore.get(EMP).step = 'confirm';
  await controller.handleMessage(bot, message('Return 700'));
  assert.equal(lastText(bot), '↩️ You have a return open. Finish it, or tap ❌ Cancel on it. Then type the new line.');
  assert.equal(sessionStore.get(EMP).step, 'confirm');
  assert.equal(JSON.stringify(sessionStore.get(EMP).bales.map((b) => b.packageNo)), before, 'the bales of the open return are untouched');
  await controller.handleMessage(bot, message('Return package 700 to Idumota'));
  assert.equal(lastText(bot), '↩️ You have a return open. Finish it, or tap ❌ Cancel on it. Then type the new line.');
  // a condition NOTE may begin with the word: it is the note
  sessionStore.get(EMP).step = 'condition_note';
  await controller.handleMessage(bot, message('Returned wet, two thans stained'));
  assert.equal(sessionStore.get(EMP).conditionNote, 'Returned wet, two thans stained');
});

test('RET-7: on the open card — a Sell line is not the card\'s; the 🔎 Open step takes numbers too', async () => {
  const { bot } = await type('Return 631/1');
  assert.equal(await returnBundleFlow.handleText(bot, message('Sell 614/1')), false, 'a sale typed here goes to the sell door, never into the return');
  assert.equal(await returnBundleFlow.handleText(bot, message('Sell 614/1 to Abba')), false);
  assert.equal(sessionStore.get(EMP).bales.length, 1);
  // wordings the outside door refuses are refused here as well
  for (const l of ['Return: 614/1', 'Returned 614/1 to Abba', 'Return 700 to Idumota']) {
    await controller.handleMessage(bot, message(l));
    assert.match(lastText(bot), /❓ Numbers only here/, l);
    assert.equal(sessionStore.get(EMP).bales.length, 1, l);
  }
  // 🔎 Open a bale, then type one more: added, back on the list
  const cardId = sessionStore.get(EMP).flowMessageId;
  await controller.handleCallbackQuery(bot, cb('rb:o:0', EMP, cardId));
  assert.equal(sessionStore.get(EMP).step, 'open');
  await controller.handleMessage(bot, message('614/1'));
  assert.equal(sessionStore.get(EMP).bales.length, 2);
  assert.match(lastText(bot), /➕ Added 1 bale/);
  // the whole one line typed on the card is the one line
  await controller.handleMessage(bot, message('Return 700'));
  assert.equal(sessionStore.get(EMP).bales.length, 3);
});
