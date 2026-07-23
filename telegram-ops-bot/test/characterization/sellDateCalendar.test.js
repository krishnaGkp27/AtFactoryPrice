'use strict';

/**
 * SELL-T2 — sale-date UX + backdated rule (owner 21-Jul):
 * calendar picker (90d back, no future), typed dates at the date step,
 * beyond-yesterday = BACKDATED (yesterday is normal), banner on review,
 * and the central Transactions Backdated stamp.
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
installFakeIntent(() => ({ action: 'sell_batch', packageNos: ['507'], confidence: 0.95 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));

inventoryRepository.getAll = async () => [
  { packageNo: '507', design: '77016', shade: '5', warehouse: 'IDUMOTA', status: 'available', yards: 30 },
];

function lagosISO(daysBack = 0) {
  return new Date(Date.now() - daysBack * 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

/** Drive to the date step via typed preload → customer → salesperson → payment. */
async function reachDateStep(bot) {
  await controller.handleMessage(bot, { from: { id: '4242' }, chat: { id: '4242' }, text: 'Sell package 507' });
  // Seed the mid-flow fields directly (customer/salesperson/payment are
  // covered by their own tests) and open the date step like the taps do.
  const s = sessionStore.get('4242');
  s.customer = 'OKESON'; s.salesperson = 'Abdul'; s.paymentMode = 'ZENITH BANK';
  sessionStore.set('4242', s);
  const sellBaleFlow = require(path.join(SRC, 'flows/sellBaleFlow'));
  await sellBaleFlow._internals.showDates(bot, '4242', '4242');
}

test('date step: chips + calendar button; calendar bounds; old day pick → BACKDATED banner', async () => {
  const bot = createFakeBot();
  await reachDateStep(bot);
  const calBtn = lastKb(bot).find((b) => b.callback_data.startsWith('sb:cal:'));
  assert.ok(calBtn, 'calendar entry button present');

  await controller.handleCallbackQuery(bot, cb(calBtn.callback_data));
  let kb = lastKb(bot);
  assert.ok(kb.some((b) => b.callback_data.startsWith('sb:cd:')), 'day buttons rendered');
  assert.ok(!kb.some((b) => b.callback_data.startsWith('sb:cd:') && b.callback_data.slice(6) > lagosISO(0)),
    'no future day is pickable');

  // Pick a day 10 days back (navigate to its month if it differs).
  const target = lagosISO(10);
  if (!kb.some((b) => b.callback_data === `sb:cd:${target}`)) {
    const prev = kb.find((b) => b.text === '◀');
    await controller.handleCallbackQuery(bot, cb(prev.callback_data));
    kb = lastKb(bot);
  }
  await controller.handleCallbackQuery(bot, cb(`sb:cd:${target}`));
  const review = bot.allText().replace(/\\/g, '');
  assert.match(review, /BACKDATED — 10 days in the past/, 'review banner with days-back');
  assert.match(review, /Both admins will see this flag/);
  assert.equal(sessionStore.get('4242').backdatedDays, 10);
  sessionStore.clear('4242');
});

test('a TYPED date never executes — it opens the calendar with the day marked; only the tap commits', async () => {
  const bot = createFakeBot();
  await reachDateStep(bot);
  const target = lagosISO(10);
  await controller.handleMessage(bot, { from: { id: '4242' }, chat: { id: '4242' }, text: target });
  let s = sessionStore.get('4242');
  assert.ok(!s.salesDate, 'typing alone sets NOTHING');
  assert.match(bot.allText().replace(/\\/g, ''), /You typed .* — confirm it with a TAP/);
  const kb = lastKb(bot);
  const marked = kb.find((b) => b.callback_data === `sb:cd:${target}`);
  assert.ok(marked, 'the typed day is on the calendar page shown');
  assert.equal(marked.text, `[${Number(target.slice(8))}]`, 'typed day is visually marked');
  // Any OTHER pickable day still works normally.
  assert.ok(kb.some((b) => b.callback_data.startsWith('sb:cd:') && b.callback_data !== `sb:cd:${target}` && !b.text.startsWith('[')));
  // The tap is the commit.
  await controller.handleCallbackQuery(bot, cb(marked.callback_data));
  s = sessionStore.get('4242');
  assert.equal(s.salesDate, target);
  assert.equal(s.backdatedDays, 10);
  sessionStore.clear('4242');
});

test('chip tap: yesterday is NOT backdated (owner rule)', async () => {
  const bot = createFakeBot();
  await reachDateStep(bot);
  await controller.handleCallbackQuery(bot, cb('sb:dt:1')); // Yesterday chip
  const s = sessionStore.get('4242');
  assert.equal(s.salesDate, lagosISO(1));
  assert.equal(s.backdatedDays, 0, 'yesterday is a NORMAL sale');
  assert.ok(!/BACKDATED —/.test(bot.allText()), 'no banner for yesterday');
  sessionStore.clear('4242');
});

test('future and >90d dates are refused; junk text gets the calendar hint', async () => {
  const bot = createFakeBot();
  await reachDateStep(bot);
  const sellBaleFlow = require(path.join(SRC, 'flows/sellBaleFlow'));
  await sellBaleFlow._internals.applyDate(bot, '4242', '4242', lagosISO(-3));
  assert.match(bot.allText().replace(/\\/g, ''), /is in the FUTURE/);
  await sellBaleFlow._internals.applyDate(bot, '4242', '4242', lagosISO(120));
  assert.match(bot.allText().replace(/\\/g, ''), /more than 90 days back/);
  await controller.handleMessage(bot, { from: { id: '4242' }, chat: { id: '4242' }, text: 'someday soon' });
  assert.match(bot.allText().replace(/\\/g, ''), /Could not read "someday soon" as a date — tap it instead/);
  assert.ok(lastKb(bot).some((b) => b.callback_data.startsWith('sb:cd:')), 'calendar shown for the junk text');
  assert.ok(!sessionStore.get('4242').salesDate, 'nothing applied');
  sessionStore.clear('4242');
});

test('Transactions append stamps BACKDATED-Nd centrally and audit-logs it', async () => {
  const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
  const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
  const sheetsClient = require(path.join(SRC, 'repositories/sheetsClient'));
  const appended = [];
  const audits = [];
  const savedAppend = sheetsClient.appendRows;
  const savedRead = sheetsClient.readRange;
  sheetsClient.appendRows = async (sheet, rows) => { if (sheet === 'Transactions') appended.push(...rows); };
  sheetsClient.readRange = async () => [Array(18).fill('h')];
  auditLogRepository.append = async (event, payload) => { audits.push({ event, payload }); };
  try {
    await transactionsRepository.append({ action: 'sell_package', salesDate: lagosISO(10), customerName: 'OKESON', user: '4242' });
    assert.equal(appended[0][17], 'BACKDATED-10d', 'stamp in the end column');
    assert.ok(audits.some((a) => a.event === 'backdated_sale_recorded'), 'audit trail written');

    appended.length = 0; audits.length = 0;
    await transactionsRepository.append({ action: 'sell_package', salesDate: lagosISO(1), customerName: 'OKESON', user: '4242' });
    assert.equal(appended[0][17], '', 'yesterday not stamped');
    await transactionsRepository.append({ action: 'receive_goods', salesDate: lagosISO(30), user: '4242' });
    assert.equal(appended[1][17], '', 'non-sale rows never stamped');
    assert.equal(audits.length, 0);
  } finally {
    sheetsClient.appendRows = savedAppend;
    sheetsClient.readRange = savedRead;
  }
});
