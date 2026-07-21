'use strict';

/**
 * RPT-2 — 📈 Sales Browser: admin-only date-wise drill-down. Day chips
 * with mini summaries, one tappable row per sale (grouped by SaleRefId)
 * with the ⚠️BD backdated marker, full detail with per-bale lines +
 * approval status + invoice link, the Supplies tab, and the calendar.
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

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const invoicesRepository = require(path.join(SRC, 'repositories/invoicesRepository'));

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

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

function cb(data, uid = '777') {
  return { id: 'cb', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 9 } };
}
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
