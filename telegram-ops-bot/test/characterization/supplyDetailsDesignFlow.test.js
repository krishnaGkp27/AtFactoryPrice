'use strict';

/**
 * SDG-1/SDG-2 — 📦 Supply Details → Design wise → Date-wise, as a tappable
 * drill: container → design → date → customer → bale numbers.
 *
 * SDG-2 (owner, 02-Aug) inserted the CONTAINER step at the top; these
 * fixtures carry no arrival_batch, so they all bucket under the synthetic
 * '(unlabelled)' container — one chip, and the drill continues as before.
 *
 * Owner-locked rules pinned here:
 *  - level 1 shows "supplied / total bales" and NO yards;
 *  - level 1 is sorted MOST SUPPLIED FIRST;
 *  - a design with nothing left anywhere carries ✅;
 *  - bales are counted as distinct PHYSICAL bales (a bale sold as loose
 *    thans counts once, not once per than);
 *  - ₦ appears for env admins only — the same gate the flat report used.
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
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const flow = require(path.join(SRC, 'flows/supplyDetailsDesignFlow'));

const EMPLOYEE = '4242';
const ADMIN = '777';

/** One row per than; thans of the same bale share packageNo. */
function row(design, pkg, shade, soldTo, soldDate, status = 'sold') {
  return {
    design, packageNo: pkg, shade, warehouse: 'Lagos',
    soldTo: status === 'sold' ? soldTo : '',
    soldDate: status === 'sold' ? soldDate : '',
    status, yards: 30, pricePerYard: 100,
  };
}

// 44200: 3 bales SOLD (824, 831 on 12-Feb; 840 on 11-Feb) + 1 bale still
//        available → supplied 3B of total 4B.
//        Bale 824 is sold as 3 loose thans — it must count as ONE bale.
// 9006:  1 bale sold, nothing else → 1B / 1B, fully supplied (✅).
const ROWS = [
  row('44200', '824', 'BLACK', 'madam oshodi', '2026-02-12'),
  row('44200', '824', 'BLACK', 'madam oshodi', '2026-02-12'),
  row('44200', '824', 'BLACK', 'madam oshodi', '2026-02-12'),
  row('44200', '831', 'BLACK', 'mama kafaya', '2026-02-12'),
  // mixed date format for the same day must merge with the ISO rows above
  row('44200', '840', 'BLACK', 'Ketu madam', '11-02-2026'),
  row('44200', '850', 'BLACK', '', '', 'available'),
  row('9006', '900', 'GOLD', 'Awunawu', '2026-02-16'),
];

inventoryRepository.getAll = async () => ROWS;
inventoryRepository.getSoldRows = async () => ROWS.filter((r) => r.status === 'sold' && r.soldTo && r.soldDate);

function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
    && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}
function lastText(bot) {
  const withText = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
  return withText.length ? withText[withText.length - 1].args.text : '';
}

test('SDG-2: the drill opens on a container picker', async () => {
  const bot = createFakeBot();
  await flow.start(bot, EMPLOYEE, EMPLOYEE, null);
  const cts = lastKb(bot).filter((b) => b.callback_data.startsWith('sdg:ct:'));
  assert.equal(cts.length, 1, 'one container chip for the unlabelled fixture');
  assert.match(cts[0].text, /\(unlabelled\) — 4B \/ 5B$/, `container pair, got: ${cts[0].text}`);
  assert.ok(!lastKb(bot).some((b) => b.callback_data.startsWith('sdg:d:')),
    'the design list is behind the container, not shown yet');
  sessionStore.clear(EMPLOYEE);
});

test('SDG-1: level 1 shows supplied/total bales, no yards, most supplied first', async () => {
  const bot = createFakeBot();
  await flow.start(bot, EMPLOYEE, EMPLOYEE, null);
  await flow.handleCallback(bot, cb('sdg:ct:0', EMPLOYEE));
  const kb = lastKb(bot).filter((b) => b.callback_data.startsWith('sdg:d:'));

  assert.match(kb[0].text, /44200 — 3B \/ 4B$/, `44200 first with 3B/4B, got: ${kb[0].text}`);
  assert.match(kb[1].text, /9006 — 1B \/ 1B ✅$/, `fully-supplied design carries ✅, got: ${kb[1].text}`);
  assert.ok(!kb.some((b) => /yds/.test(b.text)), 'no yards at level 1 (owner, 25-Jul)');
  assert.ok(!/yds/.test(lastText(bot)), 'and none in the level-1 body');
  // 824 sold as 3 thans must count once, not three times.
  assert.ok(!/3B \/ 6B|5B/.test(kb[0].text), 'loose thans of one bale count as a single bale');
  sessionStore.clear(EMPLOYEE);
});

test('SDG-1: drills design → date → customer → bale numbers, and back again', async () => {
  const bot = createFakeBot();
  await flow.start(bot, EMPLOYEE, EMPLOYEE, null);
  await flow.handleCallback(bot, cb('sdg:ct:0', EMPLOYEE));
  const design = lastKb(bot).find((b) => /44200/.test(b.text));
  await flow.handleCallback(bot, cb(design.callback_data, EMPLOYEE));

  const days = lastKb(bot).filter((b) => b.callback_data.startsWith('sdg:t:'));
  assert.match(days[0].text, /12 Feb 2026 — 2B$/, `newest date first with bale count, got: ${days[0].text}`);
  assert.match(days[1].text, /11 Feb 2026 — 1B$/, 'DD-MM-YYYY row merged onto its own day');
  // Yards are a DETAIL figure — a date is an aggregate over customers.
  assert.ok(!days.some((b) => /yds/.test(b.text)), 'no yards on the date level');

  await flow.handleCallback(bot, cb('sdg:t:0', EMPLOYEE));
  const custs = lastKb(bot).filter((b) => b.callback_data.startsWith('sdg:c:'));
  assert.ok(custs.some((b) => /madam oshodi — 1B$/.test(b.text)), `customer with bale count, got: ${custs.map((c) => c.text)}`);
  assert.ok(!custs.some((b) => /yds/.test(b.text)), 'no yards on the customer level');
  assert.match(lastText(bot), /Day total: 2B · 4 thans/, 'day total counts bales and thans');
  assert.ok(!/yds/.test(lastText(bot)), 'no yards on the day total either — still an aggregate');

  await flow.handleCallback(bot, cb(custs.find((b) => /madam oshodi/.test(b.text)).callback_data, EMPLOYEE));
  const detail = lastText(bot);
  // SDG-2 layout: numbers ride the shade row in brackets, quantities below,
  // and the flat "Bale numbers (N)" list is gone.
  assert.match(detail, / • Shade BLACK ×1 \(824\)/, `shade row with numbers, got: ${detail}`);
  assert.match(detail, /3 thans · 90 yds/, 'quantities on the second line');
  assert.ok(!/Bale numbers \(/.test(detail), 'flat bale list dropped');

  // back-chain: detail → customers → dates → designs
  await flow.handleCallback(bot, cb('sdg:back', EMPLOYEE));
  assert.ok(lastKb(bot).some((b) => b.callback_data.startsWith('sdg:c:')), 'back to customers');
  await flow.handleCallback(bot, cb('sdg:back', EMPLOYEE));
  assert.ok(lastKb(bot).some((b) => b.callback_data.startsWith('sdg:t:')), 'back to dates');
  await flow.handleCallback(bot, cb('sdg:back', EMPLOYEE));
  assert.ok(lastKb(bot).some((b) => b.callback_data.startsWith('sdg:d:')), 'back to designs');
  sessionStore.clear(EMPLOYEE);
});

test('SDG-1: ₦ is admin-only — an employee never sees value', async () => {
  const empBot = createFakeBot();
  await flow.start(empBot, EMPLOYEE, EMPLOYEE, null);
  await flow.handleCallback(empBot, cb('sdg:ct:0', EMPLOYEE));
  await flow.handleCallback(empBot, cb('sdg:d:0', EMPLOYEE));
  await flow.handleCallback(empBot, cb('sdg:t:0', EMPLOYEE));
  assert.ok(!/₦/.test(lastText(empBot)), `employee must not see money, got: ${lastText(empBot)}`);
  sessionStore.clear(EMPLOYEE);

  const admBot = createFakeBot();
  await flow.start(admBot, ADMIN, ADMIN, null);
  await flow.handleCallback(admBot, cb('sdg:ct:0', ADMIN));
  await flow.handleCallback(admBot, cb('sdg:d:0', ADMIN));
  await flow.handleCallback(admBot, cb('sdg:t:0', ADMIN));
  assert.match(lastText(admBot), /₦/, 'admin sees the day total in naira');
  sessionStore.clear(ADMIN);
});

test('SDG-2: an expired card self-heals back to the container list', async () => {
  const bot = createFakeBot();
  sessionStore.clear(EMPLOYEE);
  await flow.handleCallback(bot, cb('sdg:t:0', EMPLOYEE, 99));
  assert.ok(lastKb(bot).some((b) => b.callback_data.startsWith('sdg:ct:')), 'reseeds to the container list');
  sessionStore.clear(EMPLOYEE);
});
