'use strict';

/**
 * SDD-1 — 📦 Supply Details drill (warehouse → date → customer → design).
 * Units are owner-locked per warehouse: than-visible (Kano office) shows
 * "Nt"; every other warehouse shows bales only ("NB").
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

loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const flow = require(path.join(SRC, 'flows/supplyDetailsFlow'));

settingsRepository.getAll = async () => ({ THAN_VISIBILITY_WAREHOUSES: 'Kano office' });

// Sold rows: Lagos — 21-May Karibulla 5 thans from 2 bales (824, 831) + Belly
// 2 thans from 1 bale; Kano office — 03-Jun Karibulla 5 thans. Mixed date
// formats on purpose (ISO + DD-MM-YYYY must merge on one Lagos day).
function row(pkg, uid, design, wh, soldTo, soldDate) {
  return { design, packageNo: pkg, baleUid: uid, warehouse: wh, soldTo, soldDate, status: 'sold', yards: 30 };
}
inventoryRepository.getSoldRows = async () => [
  row('824', 'B824', '9006', 'Lagos', 'Karibulla', '2026-05-21'),
  row('824', 'B824', '9006', 'Lagos', 'Karibulla', '21-05-2026'),
  row('824', 'B824', '9006', 'Lagos', 'Karibulla', '2026-05-21'),
  row('831', 'B831', '9032', 'Lagos', 'Karibulla', '2026-05-21'),
  row('831', 'B831', '9032', 'Lagos', 'Karibulla', '2026-05-21'),
  row('840', 'B840', '9006', 'Lagos', 'Belly', '2026-05-21'),
  row('840', 'B840', '9006', 'Lagos', 'Belly', '2026-05-21'),
  row('7', 'B7', '9006', 'Kano office', 'Karibulla', '2026-06-03'),
  row('7', 'B7', '9006', 'Kano office', 'Karibulla', '2026-06-03'),
  row('8', 'B8', '9006', 'Kano office', 'Karibulla', '2026-06-03'),
  row('8', 'B8', '9006', 'Kano office', 'Karibulla', '2026-06-03'),
  row('8', 'B8', '9006', 'Kano office', 'Karibulla', '2026-06-03'),
];

function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}
function lastText(bot) {
  const withText = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
  return withText.length ? withText[withText.length - 1].args.text : '';
}

test('SDD-1: Lagos drills in bales only; mixed date formats merge; back-chain works', async () => {
  const bot = createFakeBot();
  await flow.start(bot, '4242', '4242', null);
  let kb = lastKb(bot);
  const lagosBtn = kb.find((b) => /Lagos/.test(b.text));
  assert.ok(lagosBtn, 'Lagos warehouse button');
  await flow.handleCallback(bot, cb(lagosBtn.callback_data, '4242'));
  kb = lastKb(bot);
  const dayBtn = kb.find((b) => b.callback_data === 'sdd:d:0');
  assert.match(dayBtn.text, /21 May 2026 — 3B$/, 'one merged day, bales only (3 distinct bales)');
  await flow.handleCallback(bot, cb('sdd:d:0', '4242'));
  kb = lastKb(bot);
  const kari = kb.find((b) => /Karibulla/.test(b.text));
  const belly = kb.find((b) => /Belly/.test(b.text));
  assert.match(kari.text, /— 2B$/, 'Karibulla 2 bales, no thans, no =');
  assert.match(belly.text, /— 1B$/, 'Belly 1 bale');
  await flow.handleCallback(bot, cb(kari.callback_data, '4242'));
  const t = lastText(bot);
  assert.match(t, /9006: 1B/, 'design 9006 from 1 bale');
  assert.match(t, /9032: 1B/, 'design 9032 from 1 bale');
  assert.match(t, /Total: \*2B\*/, 'customer day total in bales');
  assert.ok(!/t\b.*from|=/.test(t.replace(/Total/, '')), 'no than figures or = on bales-only warehouse');
  // Back-chain: detail → customers → dates → warehouses
  await flow.handleCallback(bot, cb('sdd:back', '4242'));
  assert.ok(lastKb(bot).some((b) => /Karibulla/.test(b.text)), 'back to customers');
  await flow.handleCallback(bot, cb('sdd:back', '4242'));
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'sdd:d:0'), 'back to dates');
  await flow.handleCallback(bot, cb('sdd:back', '4242'));
  assert.ok(lastKb(bot).some((b) => /Lagos/.test(b.text)), 'back to warehouses');
  sessionStore.clear('4242');
});

test('SDD-1: Kano office drills in thans only', async () => {
  const bot = createFakeBot();
  await flow.start(bot, '4242', '4242', null);
  const kanoBtn = lastKb(bot).find((b) => /Kano office/.test(b.text));
  await flow.handleCallback(bot, cb(kanoBtn.callback_data, '4242'));
  const dayBtn = lastKb(bot).find((b) => b.callback_data === 'sdd:d:0');
  assert.match(dayBtn.text, /03 Jun 2026 — 5t$/, 'thans only on Kano');
  await flow.handleCallback(bot, cb('sdd:d:0', '4242'));
  const kari = lastKb(bot).find((b) => /Karibulla/.test(b.text));
  assert.match(kari.text, /— 5t$/);
  await flow.handleCallback(bot, cb(kari.callback_data, '4242'));
  const t = lastText(bot);
  assert.match(t, /9006: 5t/, 'design line in thans');
  assert.match(t, /Total: \*5t\*/);
  sessionStore.clear('4242');
});

test('SDD-1: expired session self-heals from an old card', async () => {
  const bot = createFakeBot();
  sessionStore.clear('4242');
  await flow.handleCallback(bot, cb('sdd:d:0', '4242', 99));
  assert.ok(lastKb(bot).some((b) => /Lagos|Kano office/.test(b.text)), 'reseeds to warehouse picker');
  sessionStore.clear('4242');
});
