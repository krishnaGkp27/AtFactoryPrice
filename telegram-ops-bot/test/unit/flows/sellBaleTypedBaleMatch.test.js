'use strict';

/**
 * FIX-BALEMATCH2 (11-Nov-2026) — 💰 Sell Bale preloaded from typed bale
 * numbers (`startWithBales`, reached through the AI sale intent, i.e. only
 * while Settings AI_TEXT_PARSER = 1): a typed number stands for the bale
 * that CARRIES it (BUSINESS_RULES §1).
 *
 * The preload took every available bale whose number EQUALS the typed one
 * OR ENDS with it. With bale 552 sold and bale 1552 on the shelf, typing
 * 552 loaded 1552 into the cart; with both on the shelf it asked "exists in
 * 2 places — which one?" between two different bales.
 *
 * Pinned: exact beats ending; an exact bale that is sold / has nothing left
 * is skipped with the door's own reason and never replaced; the ending
 * match still works when no bale carries the number exactly, one candidate
 * or two, as before.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const sessionStore = require('../../../src/utils/sessionStore');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const sellBaleFlow = require('../../../src/flows/sellBaleFlow');

let inventory = [];
inventoryRepository.getAll = async () => inventory;

const than = (packageNo, status = 'available', warehouse = 'IDUMOTA', soldTo = '') => (
  { packageNo, design: '44200', shade: 'BLACK', thanNo: 1, yards: 30, status, warehouse, soldTo, arrivalBatch: 'Jul26' });

/** The card on screen, Markdown escapes dropped. */
const lastCard = (bot) => {
  const t = bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  return t.length ? String(t[t.length - 1].args.text).replace(/\\/g, '') : '';
};
const lastButtons = (bot) => {
  const t = bot.calls.filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.args.opts && c.args.opts.reply_markup);
  return t.length ? t[t.length - 1].args.opts.reply_markup.inline_keyboard.flat() : [];
};
const cartNos = () => (sessionStore.get('555').cart || []).map((c) => `${c.packageNo}@${c.warehouse}`);

test('exact beats ending: 552 and 1552 both on the shelf → 552 is loaded, no "which one?"', async () => {
  for (const rows of [[than('1552'), than('552'), than('552')], [than('552'), than('552'), than('1552'), than('20552')]]) {
    inventory = rows;
    const bot = createFakeBot();
    await sellBaleFlow.startWithBales(bot, 1, '555', ['552']);
    assert.deepEqual(cartNos(), ['552@IDUMOTA']);
    assert.equal(sessionStore.get('555').step, 'preload_review');
    assert.match(lastCard(bot), /1 bale\(s\) loaded from your message/);
    assert.match(lastCard(bot), /✅ Bale 552: 44200, 2 thans, 60 yds/);
    assert.doesNotMatch(lastCard(bot), /exists in|1552/);
    sessionStore.clear('555');
  }
});

test('the exact bale is sold: skipped with its own reason — the longer number is not loaded in its place', async () => {
  inventory = [than('552', 'sold', 'IDUMOTA', 'CJE'), than('1552'), than('600')];
  let bot = createFakeBot();
  await sellBaleFlow.startWithBales(bot, 1, '555', ['552']);
  assert.match(lastCard(bot), /None of the typed bale numbers matched available stock:\n {2}• 552 — already sold to CJE/);
  assert.doesNotMatch(lastCard(bot), /1552/);
  assert.ok(!sessionStore.get('555'), 'nothing to sell — the session is closed, as before');

  // Next to a bale that does load, it is listed as skipped on the review card.
  bot = createFakeBot();
  await sellBaleFlow.startWithBales(bot, 1, '555', ['552', '600']);
  assert.deepEqual(cartNos(), ['600@IDUMOTA']);
  assert.match(lastCard(bot), /✅ Bale 600: 44200, 1 thans, 30 yds/);
  assert.match(lastCard(bot), /⚠️ 552 — already sold to CJE \(skipped\)/);
  assert.doesNotMatch(lastCard(bot), /1552/);
  sessionStore.clear('555');
});

test('the exact bale has nothing available and no buyer on record (on the road): "no available thans", not replaced', async () => {
  inventory = [than('552', 'in_transit'), than('1552')];
  const bot = createFakeBot();
  await sellBaleFlow.startWithBales(bot, 1, '555', ['552']);
  assert.match(lastCard(bot), /• 552 — no available thans/);
  assert.doesNotMatch(lastCard(bot), /1552/);
  assert.ok(!sessionStore.get('555'));
});

test('the exact number in two stores is still the "which one?" question — between those two only', async () => {
  inventory = [than('552', 'available', 'IDUMOTA'), than('552', 'available', 'Lagos'), than('1552')];
  const bot = createFakeBot();
  await sellBaleFlow.startWithBales(bot, 1, '555', ['552']);
  assert.match(lastCard(bot), /Bale \*552\* exists in 2 places — which one is being sold\?/);
  assert.deepEqual(lastButtons(bot).filter((b) => b.callback_data.startsWith('sb:amb:')).map((b) => b.text),
    ['🏭 IDUMOTA — 44200 · 1 thans · 30 yds', '🏭 Lagos — 44200 · 1 thans · 30 yds']);
  sessionStore.clear('555');
});

test('no bale carries the number exactly → the ending match, as before (one: loaded · two: "which one?" · none: not found)', async () => {
  inventory = [than('997'), than('1552')];
  let bot = createFakeBot();
  await sellBaleFlow.startWithBales(bot, 1, '555', ['552']);
  assert.deepEqual(cartNos(), ['1552@IDUMOTA']);
  assert.match(lastCard(bot), /✅ Bale 1552: 44200, 1 thans, 30 yds/);
  sessionStore.clear('555');

  inventory = [than('2552'), than('1552')];
  bot = createFakeBot();
  await sellBaleFlow.startWithBales(bot, 1, '555', ['552']);
  assert.match(lastCard(bot), /Bale \*552\* exists in 2 places — which one is being sold\?/);
  assert.equal(lastButtons(bot).filter((b) => b.callback_data.startsWith('sb:amb:')).length, 2);
  sessionStore.clear('555');

  // Only a SOLD longer number ends in the digits: no bale is the typed number.
  inventory = [than('1552', 'sold', 'IDUMOTA', 'CJE')];
  bot = createFakeBot();
  await sellBaleFlow.startWithBales(bot, 1, '555', ['552']);
  assert.match(lastCard(bot), /• 552 — not found in the sheet/);
  assert.ok(!sessionStore.get('555'));
});
