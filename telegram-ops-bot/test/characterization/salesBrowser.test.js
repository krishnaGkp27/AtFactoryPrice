'use strict';

/**
 * RPT-2 — 📈 Sales Browser: admin-only date-wise drill-down. Day chips
 * with mini summaries, one tappable row per sale (grouped by SaleRefId)
 * with the ⚠️BD backdated marker, full detail with per-bale lines +
 * approval status + invoice link, the Supplies tab, and the calendar.
 *
 * RPT-3/3b — 👤 Customer tab: customer → design → dates → bale entries
 * with yards, fed from SOLD Inventory rows (one per THAN) — real design
 * chips, distinct-physical-bale counts, real bale numbers on the day
 * card, mixed-format soldDate normalization, back-chain.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '4242';
process.env.BASE_URL = 'https://afp.example';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb: fxCb } = require('../helpers/charFixture');
const cb = (data, uid = '777') => fxCb(data, uid);

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const invoicesRepository = require(path.join(SRC, 'repositories/invoicesRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
// Same real day written the legacy way (DD-MM-YYYY) — must group with TODAY.
const TODAY_DMY = TODAY.split('-').reverse().join('-');
const TODAY_PRETTY = require(path.join(SRC, 'utils/formatDate'))(TODAY);

// Two sales today: refA (2 bales, backdated stamp) + refB (1 bale, no rate).
const saleRows = [
  { timestamp: 't1', user: '4242', action: 'sell_package', design: '512', color: '3', qty: 25,
    status: 'completed', salesDate: TODAY, warehouse: 'Kano office', customerName: 'ALHAJI MUSA',
    salesPerson: 'Abdul', paymentMode: 'ZENITH — AFP LTD', saleRefId: 'refA', pricePerYard: 1000,
    amountPaid: 0, backdated: 'BACKDATED-5d' },
  { timestamp: 't1', user: '4242', action: 'sell_package', design: '618', color: '', qty: 30,
    status: 'completed', salesDate: TODAY, warehouse: 'Kano office', customerName: 'ALHAJI MUSA',
    salesPerson: 'Abdul', paymentMode: 'ZENITH — AFP LTD', saleRefId: 'refA', pricePerYard: 1000,
    amountPaid: 0, backdated: 'BACKDATED-5d' },
  { timestamp: 't2', user: '4242', action: 'sell_than', design: '700', color: '1', qty: 20,
    status: 'completed', salesDate: TODAY, warehouse: 'Lagos', customerName: 'MAMA K',
    salesPerson: '', paymentMode: '', saleRefId: 'refB', pricePerYard: 0, amountPaid: 0, backdated: '' },
  // Reverted rows never appear.
  { timestamp: 't3', user: '4242', action: 'sell_than', design: '999', color: '', qty: 50,
    status: 'reverted', salesDate: TODAY, warehouse: 'Lagos', customerName: 'GHOST',
    salesPerson: '', paymentMode: '', saleRefId: 'refC', pricePerYard: 0, amountPaid: 0, backdated: '' },
];

transactionsRepository.getBySalesDateRange = async (fromIso, toIso) =>
  saleRows.filter((t) => t.salesDate >= fromIso && t.salesDate <= toIso);

// RPT-3b — the Customer tab reads SOLD Inventory rows (one per THAN).
// ALHAJI MUSA: design 512 = 3 physical bales — 824 (2 thans, ISO today),
// 831 (1 than, same real day written DD-MM-YYYY) and 840 (older day);
// design 618 = bale 900. MAMA K: design 700 = printed bale 77 + a legacy
// unprinted row (packageNo empty → short baleUid-tail label), no rates.
const OLDER = new Date(Date.now() - 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const OLDER_PRETTY = require(path.join(SRC, 'utils/formatDate'))(OLDER);
const soldRows = [
  { design: '512', packageNo: '824', baleUid: 'BAL-20260601-824-a1b2', thanNo: 1, yards: 100,
    pricePerYard: 1000, soldTo: 'ALHAJI MUSA', soldDate: TODAY, status: 'sold' },
  { design: '512', packageNo: '824', baleUid: 'BAL-20260601-824-c3d4', thanNo: 2, yards: 50,
    pricePerYard: 1000, soldTo: 'ALHAJI MUSA', soldDate: TODAY, status: 'sold' },
  { design: '512', packageNo: '831', baleUid: 'BAL-20260601-831-e5f6', thanNo: 1, yards: 300,
    pricePerYard: 1000, soldTo: 'ALHAJI MUSA', soldDate: TODAY_DMY, status: 'sold' },
  { design: '512', packageNo: '840', baleUid: 'BAL-20260501-840-g7h8', thanNo: 1, yards: 200,
    pricePerYard: 1000, soldTo: 'ALHAJI MUSA', soldDate: OLDER, status: 'sold' },
  { design: '618', packageNo: '900', baleUid: 'BAL-20260501-900-i9j0', thanNo: 1, yards: 30,
    pricePerYard: 0, soldTo: 'ALHAJI MUSA', soldDate: OLDER, status: 'sold' },
  { design: '700', packageNo: '77', baleUid: 'BAL-20260601-77-k1l2', thanNo: 1, yards: 40,
    pricePerYard: 0, soldTo: 'MAMA K', soldDate: TODAY_DMY, status: 'sold' },
  { design: '700', packageNo: '', baleUid: 'BAL-LEGACY-7', thanNo: 1, yards: 20,
    pricePerYard: 0, soldTo: 'MAMA K', soldDate: TODAY, status: 'sold' },
];
inventoryRepository.getSoldRows = async () => soldRows;

approvalQueueRepository.getResolved = async () => [
  { requestId: 'SUP1', user: '4242', status: 'approved', createdAt: `${TODAY}T10:00:00Z`, resolvedAt: '',
    actionJSON: { action: 'supply_request', customer: 'BELLO TRADERS', warehouse: 'Kano office',
      salesperson: 'Abdul', salesDate: TODAY, stage: 'completed',
      cart: [{ design: '512', shade: '2', quantity: 3 }, { design: '618', shade: '', quantity: 1 }] } },
  // Non-supply resolved rows are filtered out of the Supplies tab.
  { requestId: 'X1', user: '777', status: 'approved', createdAt: `${TODAY}T09:00:00Z`, resolvedAt: '',
    actionJSON: { action: 'add_bank', bank_name: 'GTB' } },
];
approvalQueueRepository.getByRequestId = async (id) =>
  id === 'refA' ? { requestId: 'refA', status: 'approved', actionJSON: {} } : null;
invoicesRepository.getByRequestId = async (id) =>
  id === 'refA' ? { invoiceNo: 'INV-0042', token: 'tok123', requestId: 'refA' } : null;

function plain(bot) { return bot.allText().replace(/\\/g, ''); }

test('non-admin tapping the tile is refused', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:sales_browser', '4242'));
  assert.match(bot.allText(), /admin-only/);
  assert.ok(!sessionStore.get('4242'), 'no session opened');
});

test('admin start: tabs + day chips with per-day mini summaries', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:sales_browser'));
  assert.match(plain(bot), /Sales Browser/);
  const kb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup)
    .pop().args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === 'sbr:tab:sales'), 'Sales tab');
  assert.ok(kb.some((b) => b.callback_data === 'sbr:tab:supplies'), 'Supplies tab');
  assert.ok(kb.some((b) => b.callback_data === 'sbr:tab:customer' && b.text === '👤 Customer'), 'Customer tab (RPT-3)');
  const todayChip = kb.find((b) => b.callback_data === `sbr:day:${TODAY}`);
  assert.match(todayChip.text, /Today — 2 sales · 75 yds/, 'today chip summarises grouped sales (reverted excluded)');
  assert.ok(kb.some((b) => b.callback_data.startsWith('sbr:cal:')), 'calendar entry');
});

test('day list: one tappable row per sale, short summary, ⚠️BD marker', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`sbr:day:${TODAY}`));
  const text = plain(bot);
  assert.match(text, /2 sales · 75 yds/, 'day header totals');
  const kb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup)
    .pop().args.opts.reply_markup.inline_keyboard.flat();
  const itemBtns = kb.filter((b) => b.callback_data.startsWith('sbr:itm:'));
  assert.equal(itemBtns.length, 2, 'one row per SaleRefId group');
  assert.match(itemBtns[0].text, /ALHAJI MUSA — 2 items · 55 yds · ₦55,000 ⚠️BD/);
  assert.match(itemBtns[1].text, /MAMA K — 1 item · 20 yds/);
  assert.ok(!itemBtns[1].text.includes('⚠️BD'), 'normal sale has no marker');
});

test('detail: per-bale lines, totals, payment, backdated stamp, approval + invoice link', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('sbr:itm:0'));
  const text = plain(bot);
  assert.match(text, /Sale — ALHAJI MUSA/);
  assert.match(text, /512 sh 3 — 25 yds \(Kano office\)/);
  assert.match(text, /618 — 30 yds/);
  assert.match(text, /Total: \*55 yds\* · \*₦55,000\*/);
  assert.match(text, /Payment: ZENITH — AFP LTD/);
  assert.match(text, /BACKDATED-5d/, 'backdated stamp surfaced to the admin');
  assert.match(text, /Approval: approved/);
  assert.match(text, /Invoice: \*INV-0042\* — https:\/\/afp\.example\/i\/tok123/);
});

test('supplies tab: resolved supply requests only, with cart drill-down', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('sbr:tab:supplies'));
  assert.match(plain(bot), /Supplies Browser/);
  await controller.handleCallbackQuery(bot, cb(`sbr:day:${TODAY}`));
  const kb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup)
    .pop().args.opts.reply_markup.inline_keyboard.flat();
  const itemBtns = kb.filter((b) => b.callback_data.startsWith('sbr:itm:'));
  assert.equal(itemBtns.length, 1, 'add_bank resolved row filtered out');
  assert.match(itemBtns[0].text, /BELLO TRADERS — 4 bale\(s\) · Kano office · approved/);
  await controller.handleCallbackQuery(bot, cb('sbr:itm:0'));
  const text = plain(bot);
  assert.match(text, /Supply — BELLO TRADERS/);
  assert.match(text, /512 sh 2 × 3/);
  assert.match(text, /Total: \*4 bale\(s\)\*/);
});

test('calendar renders a month grid; expired session gets the re-open alert', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb(`sbr:cal:${TODAY.slice(0, 7)}`));
  const kb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup)
    .pop().args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === `sbr:day:${TODAY}`), 'today tappable in the grid');
  sessionStore.clear('777');
  const bot2 = createFakeBot();
  await controller.handleCallbackQuery(bot2, cb('sbr:back'));
  const alert = bot2.calls.find((c) => c.method === 'answerCallbackQuery' && c.args.opts && c.args.opts.show_alert);
  assert.match(alert.args.opts.text, /Expired — open 📈 Sales Browser again/);
});

/* ── RPT-3 — 👤 Customer tab ── */

function lastKb(bot) {
  return bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method) && c.args.opts && c.args.opts.reply_markup)
    .pop().args.opts.reply_markup.inline_keyboard.flat();
}

test('customer tab: chips most-recent buyer first, tab row marked', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:sales_browser'));
  await controller.handleCallbackQuery(bot, cb('sbr:tab:customer'));
  assert.match(plain(bot), /Customer Browser/);
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b.callback_data === 'sbr:tab:customer' && b.text.startsWith('●')), 'active tab marked');
  const chips = kb.filter((b) => b.callback_data.startsWith('sbr:cu:'));
  assert.equal(chips.length, 2, 'distinct soldTo customers from sold Inventory rows');
  assert.match(chips[0].text, /ALHAJI MUSA/);
  assert.match(chips[1].text, /MAMA K/);
});

test('customer → designs: real design chips, distinct physical bales, biggest first', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('sbr:cu:0'));
  const text = plain(bot);
  assert.match(text, /ALHAJI MUSA\* — designs supplied/);
  assert.match(text, /Total: 4 bales · 680 yds · 2 design\(s\)/);
  const chips = lastKb(bot).filter((b) => b.callback_data.startsWith('sbr:dg:'));
  assert.equal(chips.length, 2);
  assert.match(chips[0].text, /🧵 512 — 3 bales \(650 yds\)/, '4 thans of 512 = 3 physical bales');
  assert.match(chips[1].text, /🧵 618 — 1 bale \(30 yds\)/);
});

test('design → dates (mixed formats merge, newest first) → card with bale numbers + ₦', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('sbr:dg:0'));
  const dateChips = lastKb(bot).filter((b) => b.callback_data.startsWith('sbr:cd:'));
  assert.equal(dateChips.length, 2, 'ISO + DD-MM-YYYY same-day rows = ONE chip');
  assert.equal(dateChips[0].text, `${TODAY_PRETTY} — 2 bales (450 yds)`);
  assert.equal(dateChips[1].text, `${OLDER_PRETTY} — 1 bale (200 yds)`);
  await controller.handleCallbackQuery(bot, cb('sbr:cd:0'));
  const text = plain(bot);
  assert.match(text, new RegExp(`ALHAJI MUSA\\* — 🧵 \\*512\\* — \\*${TODAY_PRETTY}`));
  assert.match(text, /Bales \(yards\):\n824 \(150\), 831 \(300\)/, 'real bale numbers, per-bale than sums');
  assert.match(text, /Day total: 2 bales · 450 yds · ₦450,000/);
});

test('unprinted bale falls back to baleUid tail; ₦ omitted without rates', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('sbr:tab:customer'));
  await controller.handleCallbackQuery(bot, cb('sbr:cu:1')); // MAMA K
  const dChips = lastKb(bot).filter((b) => b.callback_data.startsWith('sbr:dg:'));
  assert.equal(dChips.length, 1);
  assert.match(dChips[0].text, /🧵 700 — 2 bales \(60 yds\)/, 'ISO + DD-MM-YYYY rows both counted');
  await controller.handleCallbackQuery(bot, cb('sbr:dg:0'));
  const dateChips = lastKb(bot).filter((b) => b.callback_data.startsWith('sbr:cd:'));
  assert.equal(dateChips.length, 1, 'same real day = ONE chip despite mixed formats');
  assert.equal(dateChips[0].text, `${TODAY_PRETTY} — 2 bales (60 yds)`);
  await controller.handleCallbackQuery(bot, cb('sbr:cd:0'));
  const text = plain(bot);
  assert.match(text, /Bales \(yards\):\n7 \(20\), 77 \(40\)/, 'BAL-LEGACY-7 → tail label 7');
  assert.match(text, /Day total: 2 bales · 60 yds/);
  assert.ok(!text.includes('₦'), 'no ₦ line when the day has no rates');
});

test('back-chain: card → dates → designs → customers → tab screen', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('sbr:dg:0')); // card back → dates
  assert.match(plain(bot), /Tap a supply date/);
  assert.ok(lastKb(bot).some((b) => b.text === '⬅ Designs' && b.callback_data === 'sbr:cu:1'));
  await controller.handleCallbackQuery(bot, cb('sbr:cu:1')); // dates back → designs
  assert.match(plain(bot), /MAMA K\* — designs supplied/);
  assert.ok(lastKb(bot).some((b) => b.text === '⬅ Customers' && b.callback_data === 'sbr:tab:customer'));
  await controller.handleCallbackQuery(bot, cb('sbr:tab:customer')); // designs back → customers
  assert.match(plain(bot), /Customer Browser/);
  await controller.handleCallbackQuery(bot, cb('sbr:tab:sales')); // tab row leaves the customer tab
  assert.match(plain(bot), /Sales Browser/, 'Sales tab byte-identical entry still reachable');
});
