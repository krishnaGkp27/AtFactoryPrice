'use strict';

/**
 * SELL-K1 (owner, 10-Aug-2026) — "Yes, date, salesperson and bill on the
 * same than-sale card. Yes, the sales bill is always required. Make it
 * mandatory everywhere."
 *
 * The Kano than sale used to queue with three silent assumptions: today's
 * date, the submitter as the salesperson, and no bill at all. Lagos's Sell
 * Bale has asked for all three since July. Pinned here:
 *
 *  - the cart cannot reach the queue without passing salesperson → date →
 *    bill, in that order;
 *  - the date is the one he TAPPED and the salesperson the one he PICKED —
 *    both reach the queue row, and a backdated date is flagged;
 *  - NO bill, NO queue: a submit attempt with no document re-arms the bill
 *    prompt instead of queueing;
 *  - the admin card is the CARD-3 card, and the bill is forwarded after it.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { lastKb } = require('../helpers/charFixture');

function than(pkg, thanNo, design, shade) {
  return {
    packageNo: pkg, thanNo, design, shade, warehouse: 'Kano office',
    status: 'available', yards: 30, baleUid: `U-${pkg}-${thanNo}`,
    arrivalBatch: 'Jul26', rowIndex: Number(`${pkg}${thanNo}`),
  };
}

const ROWS = [
  than('1100', 1, '77014', '11'),
  than('1100', 2, '77014', '11'),
  than('1091', 1, '9043-B', '4'),
];

const INV_HEADER = [
  'PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs',
  'NetWeight', 'UpdatedAt', 'ProductType', 'bale_uid', 'addedAt', 'grn_id',
  'bin_location', 'arrival_batch', 'design_category',
];
const invSheetRows = ROWS.map((r) => ([
  r.packageNo, '', '', r.design, r.shade, r.thanNo, r.yards, r.status,
  r.warehouse, 0, '2026-07-01', '', '', 0, 0, '', 'fabric', r.baleUid,
  '2026-07-01', '', '', r.arrivalBatch, '',
]));

installFakeSheets(createFakeSheets({ Inventory: [INV_HEADER, ...invSheetRows] }));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const shadesRepository = require(path.join(SRC, 'repositories/shadesRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const bundleSaleFlow = require(path.join(SRC, 'flows/bundleSaleFlow'));

shadesRepository.getAll = async () => [];
designAssetsRepository.findActive = async () => null;
auditLogRepository.append = async () => {};
inventoryRepository.getAll = async () => ROWS.map((r) => ({ ...r }));
usersRepository.getAll = async () => ([
  { user_id: '4242', name: 'Abdul', status: 'active' },
  { user_id: '5151', name: 'Yarima', status: 'active' },
]);
usersRepository.findByUserId = async (id) => (String(id) === '4242'
  ? { user_id: '4242', name: 'Abdul', status: 'active' } : null);

let queued = [];
approvalQueueRepository.append = async (row) => { queued.push(row); return row; };
// SUB-1 — the bundle door now submits through the idempotent front door.
approvalQueueRepository.appendOnce = async (row) => {
  const existing = queued.find((q) => String(q.requestId) === String(row.requestId));
  if (existing) return { created: false, existing };
  queued.push(row);
  return { created: true, existing: null };
};

function msg(text, uid = '4242') { return { from: { id: uid }, chat: { id: uid }, text }; }
function cb(data, uid = '4242') {
  return { id: `cb-${data}`, data, from: { id: uid }, message: { chat: { id: uid }, message_id: 1 } };
}
function lastText(bot) {
  const c = bot.calls.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)).pop();
  return String((c && c.args.text) || '');
}
function todayIso() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
}

/** Type the sale, then walk the chain up to (not through) the bill. */
async function toConfirm(bot, { dateIso } = {}) {
  sessionStore.clear('4242');
  await controller.handleMessage(bot, msg('sell 1100/1, 1091/1 kano'));
  await controller.handleCallbackQuery(bot, cb('bs:proceed'));
  await controller.handleCallbackQuery(bot, cb('bs:sp:0'));
  await controller.handleCallbackQuery(bot, cb(`bs:dd:${dateIso || todayIso()}`));
}

test('the cart cannot skip salesperson → date → bill on the way to the queue', async () => {
  const bot = createFakeBot();
  sessionStore.clear('4242');
  await controller.handleMessage(bot, msg('sell 1100/1, 1091/1 kano'));

  await controller.handleCallbackQuery(bot, cb('bs:proceed'));
  assert.equal(sessionStore.get('4242').step, 'pick_salesperson');
  assert.match(lastText(bot), /Who sold this/i);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'bs:sp:0'), 'salesperson chips offered');

  await controller.handleCallbackQuery(bot, cb('bs:sp:0'));
  assert.equal(sessionStore.get('4242').step, 'pick_date');
  assert.match(lastText(bot), /When was it sold/i);

  await controller.handleCallbackQuery(bot, cb(`bs:dd:${todayIso()}`));
  const s = sessionStore.get('4242');
  assert.equal(s.step, 'confirm');
  assert.equal(s.salesPerson, 'Abdul');
  assert.equal(s.salesDate, todayIso());
  const raw = lastText(bot);
  assert.match(raw, /🧑 Abdul/, 'the seller he picked is on the confirm card');
  assert.match(raw, /📅 \d{2}-[A-Za-z]{3}-\d{4}/, 'the date he tapped, unescaped');
  // SELL-T3b lesson: this card is Markdown v1 — no v2 escapes may leak.
  assert.ok(!/\\-/.test(raw), `no stray backslashes on the date: ${raw}`);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'bs:fin'), 'bill is the only way on');
});

test('no bill, no queue — submit without a document re-arms the prompt', async () => {
  queued = [];
  const bot = createFakeBot();
  await toConfirm(bot);
  await controller.handleCallbackQuery(bot, cb('bs:fin'));
  assert.equal(sessionStore.get('4242').step, 'await_doc');

  // Force the submit door directly, as a stale card or a replayed callback would.
  await controller.handleCallbackQuery(bot, cb('bs:submit'));
  assert.equal(queued.length, 0, 'nothing was queued without a bill');
  assert.equal(sessionStore.get('4242').step, 'await_doc', 'back on the bill prompt');
  assert.match(lastText(bot), /sales bill/i);
});

test('the bill submits the sale, carrying the picked seller and tapped date', async () => {
  queued = [];
  const bot = createFakeBot();
  await toConfirm(bot);
  await controller.handleCallbackQuery(bot, cb('bs:fin'));
  await controller.handleFileMessage(bot, {
    from: { id: '4242' }, chat: { id: '4242' },
    photo: [{ file_id: 'bill-file-1' }],
  });

  assert.equal(queued.length, 1, 'exactly one approval request');
  const aj = queued[0].actionJSON;
  assert.equal(aj.action, 'sale_bundle');
  assert.equal(aj.salesPerson, 'Abdul');
  assert.equal(aj.salesDate, todayIso());
  assert.equal(aj.customer, '', 'DSP-1 — the buyer is still the admin’s call');
  assert.equal(aj.sale_doc_file_id, 'bill-file-1', 'the bill rides the queue row');
  assert.equal(aj.sale_doc_type, 'image');
  assert.ok(!aj.backdated, 'a same-day sale is not backdated');
  assert.ok(!sessionStore.get('4242'), 'session cleared after submit');

  // CARD-3 — the admin gets the compact card, then the bill itself.
  const adminText = bot.calls
    .filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777')
    .map((c) => c.args.text).join('\n').replace(/\\/g, '');
  assert.match(adminText, /🧾 Sale · Kano office/);
  assert.match(adminText, /🧑 Abdul/);
  assert.match(adminText, /🧵 77014 — 1 than · 30 yd/);
  assert.match(adminText, /#11 → 1100\/1/);
  assert.match(adminText, /Σ 2 than · 60 yd · 2 bale/);
  assert.match(adminText, /Sent for approval/, 'no "requires admin approval" boilerplate');
  const photos = bot.calls.filter((c) => c.method === 'sendPhoto' && String(c.args.chatId) === '777');
  assert.equal(photos.length, 1, 'the bill follows the card');
  assert.equal(photos[0].args.photo, 'bill-file-1');
});

test('a backdated sale is flagged to the approver and stamped on the row', async () => {
  queued = [];
  const bot = createFakeBot();
  const fourBack = new Date(Date.now() - 4 * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  await toConfirm(bot, { dateIso: fourBack });
  assert.match(lastText(bot).replace(/\\/g, ''), /BACKDATED — 4 days back/);

  await controller.handleCallbackQuery(bot, cb('bs:fin'));
  await controller.handleFileMessage(bot, {
    from: { id: '4242' }, chat: { id: '4242' },
    document: { file_id: 'bill-pdf-1', mime_type: 'application/pdf' },
  });
  const aj = queued[0].actionJSON;
  assert.equal(aj.salesDate, fourBack);
  assert.equal(aj.backdated, true);
  assert.equal(aj.daysBack, 4);
  assert.equal(aj.sale_doc_type, 'document');
  const adminText = bot.calls
    .filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === '777')
    .map((c) => c.args.text).join('\n').replace(/\\/g, '');
  assert.match(adminText, /BACKDATED/);
});

test('BKD-1: a five-months-back Kano sale is accepted and loudly backdated', async () => {
  queued = [];
  const bot = createFakeBot();
  const deepBack = new Date(Date.now() - 150 * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  await toConfirm(bot, { dateIso: deepBack });
  assert.equal(sessionStore.get('4242').salesDate, deepBack, 'pre-May backfill date accepted');
  assert.match(lastText(bot).replace(/\\/g, ''), /BACKDATED — 150 days back/);

  await controller.handleCallbackQuery(bot, cb('bs:fin'));
  await controller.handleFileMessage(bot, {
    from: { id: '4242' }, chat: { id: '4242' }, photo: [{ file_id: 'bill-old-1' }],
  });
  const aj = queued[0].actionJSON;
  assert.equal(aj.salesDate, deepBack);
  assert.equal(aj.daysBack, 150, 'the approver sees exactly how deep the backfill goes');
});

test('a future date is refused — the picker asks again', async () => {
  const bot = createFakeBot();
  sessionStore.clear('4242');
  await controller.handleMessage(bot, msg('sell 1100/1 kano'));
  await controller.handleCallbackQuery(bot, cb('bs:proceed'));
  await controller.handleCallbackQuery(bot, cb('bs:sp:0'));
  const tomorrow = new Date(Date.now() + 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  await controller.handleCallbackQuery(bot, cb(`bs:dd:${tomorrow}`));
  assert.equal(sessionStore.get('4242').step, 'pick_date', 'still on the date step');
  assert.ok(!sessionStore.get('4242').salesDate, 'no future date was accepted');
  assert.match(lastText(bot).replace(/\\/g, ''), /FUTURE/);
});

test('the seller can be changed from the confirm card without losing the date', async () => {
  const bot = createFakeBot();
  await toConfirm(bot);
  await controller.handleCallbackQuery(bot, cb('bs:spx'));
  assert.equal(sessionStore.get('4242').step, 'pick_salesperson');
  await controller.handleCallbackQuery(bot, cb('bs:sp:1'));
  const s = sessionStore.get('4242');
  assert.equal(s.step, 'confirm', 're-picking returns straight to the card');
  assert.equal(s.salesPerson, 'Yarima');
  assert.equal(s.salesDate, todayIso(), 'the tapped date survived');
});

test('shortReason strips the boilerplate but keeps a real fact', () => {
  const approvalCards = require(path.join(SRC, 'services/approvalCards'));
  assert.equal(approvalCards.shortReason('All sale operations require admin approval.'),
    'Sent for approval');
  assert.equal(approvalCards.shortReason('Bale transfer requires admin approval'),
    'Sent for approval');
  assert.equal(approvalCards.shortReason(''), 'Sent for approval');
  assert.equal(
    approvalCards.shortReason('Backdated sale (4 days in past). All sale operations require admin approval.'),
    'Backdated sale (4 days in past).');
});

test('bundleSaleFlow exposes the bill handler the controller routes to', () => {
  assert.equal(typeof bundleSaleFlow.handleFile, 'function');
});
