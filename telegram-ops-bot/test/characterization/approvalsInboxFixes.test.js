'use strict';

/**
 * FIX-INBOX (11-Nov-2026) — four faults of the 🛂 Approvals inbox, found
 * while every step of the staff test script was checked against the code:
 *
 *  1. a tap that landed on an EMPTY list threw
 *     `ReferenceError: Cannot access 'isDecided' before initialization`
 *     instead of drawing `Nothing left here` (the last request of a group
 *     just decided, or another admin emptied the group);
 *  2. the record of a DECIDED sale (and the `Revert this sale?` card built
 *     from it) was rebuilt from LIVE stock, so a completed sale's bales sat
 *     under `no available stock` with the QTA-2 restart line;
 *  3. an office-expense batch and a payee-account registration opened as the
 *     bare words `record office expense` / `register payment account` — the
 *     second admin signed without seeing items, total, holder, number, bank;
 *  4. a supply request an admin rejected before approving it read
 *     `Already rejected` with nobody named and kept its `Waiting on …` line.
 *
 * Pending rows must read exactly as before: the last test of item 2 pins it.
 */

process.env.ADMIN_IDS = '777,888';
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

const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const crmService = require(path.join(SRC, 'services/crmService'));
const flow = require(path.join(SRC, 'flows/approvalsInboxFlow'));

const ADMIN = '777';
const NAMES = { 4242: 'Abdul', 777: 'Krishna', 888: 'Musa' };
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);
crmService.getCustomer = async () => null;
designAssetsRepository.findActive = async () => null;
designAssetsRepository.findLatest = async () => null;

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

let PENDING = [];
let RESOLVED = [];
approvalQueueRepository.getAllPending = async () => PENDING;
approvalQueueRepository.getResolved = async () => RESOLVED;
approvalQueueRepository.getByRequestId = async (id) => [...PENDING, ...RESOLVED].find((r) => r.requestId === id) || null;
approvalQueueRepository.getAllWithRowIndex = async () => [...PENDING, ...RESOLVED];

let INVENTORY = [];
inventoryRepository.getAll = async () => INVENTORY;

function reset({ pending = [], resolved = [], inventory = [] } = {}) {
  PENDING = pending;
  RESOLVED = resolved;
  INVENTORY = inventory;
  flow._internals._resetResolvedCache();
  sessionStore.clear(ADMIN);
}

function lastKb(bot) {
  const withKb = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)
    && c.args.opts && c.args.opts.reply_markup);
  const last = withKb[withKb.length - 1];
  return last ? last.args.opts.reply_markup.inline_keyboard.flat() : [];
}
function lastText(bot) {
  const withText = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
  // The inbox escapes card text for Markdown; the reader sees it unescaped.
  return withText.length ? withText[withText.length - 1].args.text.replace(/\\/g, '') : '';
}
/** Open a group and the card of one request in it. */
async function openCard(bot, category, requestId) {
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb(`abx:cat:${category}`, ADMIN));
  const items = sessionStore.get(ADMIN)._items;
  const idx = items.findIndex((r) => r.requestId === requestId);
  assert.ok(idx >= 0, `${requestId} is listed in ${category}`);
  await flow.handleCallback(bot, cb(`abx:i:${idx}`, ADMIN));
  return idx;
}

const CONTACT = { requestId: 'P-CONTACT', user: '4242', status: 'pending', createdAt: daysAgo(1), actionJSON: { action: 'add_contact', name: 'ACME' } };

/* ───────────────────────── 1. the empty list ───────────────────────── */

test('item 1: a group another admin has just emptied draws "Nothing left here" with its way back', async () => {
  reset({ pending: [CONTACT] });
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  // The Finance chip was on an older screen; by the tap nothing is left in it.
  await flow.handleCallback(bot, cb('abx:cat:finance', ADMIN));
  assert.match(lastText(bot), /^💵 Finance\n\n✅ _Nothing left here\._$/, `got: ${lastText(bot)}`);
  const kb = lastKb(bot);
  assert.ok(kb.some((b) => b.callback_data === 'abx:back' && /Categories/.test(b.text)), 'the way back to the categories');
  assert.ok(kb.some((b) => b.callback_data === 'abx:close'), 'and Close');
});

test('item 1: the same tap through the real controller — tile, group, empty screen, back to the categories', async () => {
  reset({ pending: [CONTACT] });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:approvals_inbox', ADMIN));
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'abx:cat:crm'), 'the inbox opened on its categories');
  await controller.handleCallbackQuery(bot, cb('abx:cat:finance', ADMIN));
  assert.match(lastText(bot), /Nothing left here/, `got: ${lastText(bot)}`);
  await controller.handleCallbackQuery(bot, cb('abx:back', ADMIN));
  assert.match(lastText(bot), /Approvals — 1 pending/, 'and the way back works');
});

test('item 1: back to the list after the LAST request of a group was decided draws the empty screen', async () => {
  reset({ pending: [CONTACT] });
  const bot = createFakeBot();
  await openCard(bot, 'crm', 'P-CONTACT');
  PENDING = []; // decided meanwhile (this admin's tap, or the other admin's)
  await flow.handleCallback(bot, cb('abx:back', ADMIN));
  assert.match(lastText(bot), /Nothing left here/, `got: ${lastText(bot)}`);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'abx:back'), 'with its way back');
});

test('item 1: an empty Decided group says so and keeps its way back', async () => {
  reset({ pending: [CONTACT], resolved: [] });
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('abx:cat:decided', ADMIN));
  assert.match(lastText(bot), /^✅❌ Decided\n\n_Nothing decided in this window\. Every decision stays on the ApprovalQueue sheet — widen it with Settings_ `APPROVALS_DECIDED_DAYS`\.$/,
    `the knob is a code span OUTSIDE the italic, so its underscores are printed, got: ${lastText(bot)}`);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'abx:back'), 'with its way back');
});

/* ─────────────────── 2. the record of a decided sale ─────────────────── */

const sold = (pkg, thanNo, extra = {}) => ({
  packageNo: pkg, thanNo, design: '9006', shade: '3', warehouse: 'IDUMOTA', yards: 30,
  status: 'sold', soldTo: 'Ayubal Ansari', soldDate: '2026-09-25', ...extra,
});
const SALE_AJ = {
  action: 'sale_bundle', customer: 'Ayubal Ansari', salesDate: '2026-09-25', salesPerson: 'Abdul',
  items: [
    { type: 'package', packageNo: '771', warehouse: 'IDUMOTA' },
    { type: 'than', packageNo: '6189', thanNo: 5, warehouse: 'IDUMOTA' },
  ],
  totalYards: 180,
};
// 771 was sold whole (five thans); 6189 gave its 5th than, its 1st went to
// someone else months before.
const SOLD_STOCK = [
  ...[1, 2, 3, 4, 5].map((t) => sold('771', t)),
  sold('6189', 1, { soldTo: 'CJE', soldDate: '2026-03-02' }),
  sold('6189', 5),
];
const WARNINGS = /no available stock|half-done run|Approve restarts it|NOTHING in this request|check before approving|⚠️/;

test('item 2: the record of an APPROVED sale lists its goods with no stock warning and no restart line', async () => {
  reset({
    pending: [CONTACT],
    resolved: [{ requestId: 'SALE-DONE', user: '4242', status: 'approved', createdAt: daysAgo(2), resolvedAt: daysAgo(1), approver: 'Krishna', actionJSON: SALE_AJ }],
    inventory: SOLD_STOCK,
  });
  const bot = createFakeBot();
  await openCard(bot, 'decided', 'SALE-DONE');
  const text = lastText(bot);
  assert.match(text, /^🧾 Sale · IDUMOTA · 1B \+ 1t · 180 yd\n👤 Ayubal Ansari\n🧑 Abdul · 📅 25-Sep-2026\n\n9006\n Shade 3\n {2}1\. 771 · 150 yd\n {2}2\. 6189\/5 · 30 yd\n\n✅ _Already approved by Krishna/,
    `the goods as the request recorded them, got: ${text}`);
  assert.ok(!WARNINGS.test(text), `a completed sale carries no live-stock warning, got: ${text}`);
});

test('item 2: the "Revert this sale?" card built from that record is as clean', async () => {
  reset({
    pending: [CONTACT],
    resolved: [{ requestId: 'SALE-DONE', user: '4242', status: 'approved', createdAt: daysAgo(2), resolvedAt: daysAgo(1), approver: 'Krishna', actionJSON: SALE_AJ }],
    inventory: SOLD_STOCK,
  });
  const bot = createFakeBot();
  const idx = await openCard(bot, 'decided', 'SALE-DONE');
  assert.ok(lastKb(bot).some((b) => b.callback_data === `abx:rev:${idx}`), 'the record offers the revert');
  await flow.handleCallback(bot, cb(`abx:rev:${idx}`, ADMIN));
  const text = lastText(bot);
  assert.match(text, /^↩️ \*Revert this sale\?\*\n\n🧾 Sale · IDUMOTA · 1B \+ 1t · 180 yd/, `got: ${text}`);
  assert.match(text, /\n {2}1\. 771 · 150 yd\n {2}2\. 6189\/5 · 30 yd\n\nEvery bale and than of it goes back to available\./, `got: ${text}`);
  assert.ok(!WARNINGS.test(text), `no live-stock warning on the revert question, got: ${text}`);
});

test('item 2: the record of a REJECTED sale reads the same way — goods, no warning', async () => {
  reset({
    pending: [CONTACT],
    // Rejected, and the bale was sold to someone else since.
    resolved: [{ requestId: 'SALE-NO', user: '4242', status: 'rejected', createdAt: daysAgo(2), resolvedAt: daysAgo(1), approver: 'Krishna', actionJSON: { ...SALE_AJ, items: [SALE_AJ.items[0]], totalYards: 150 } }],
    inventory: [1, 2, 3, 4, 5].map((t) => sold('771', t, { soldTo: 'CJE', soldDate: '2026-10-02' })),
  });
  const bot = createFakeBot();
  await openCard(bot, 'decided', 'SALE-NO');
  const text = lastText(bot);
  assert.match(text, /\n9006\n Shade 3\n {2}1\. 771 · 150 yd\n\n❌ _Already rejected by Krishna/, `got: ${text}`);
  assert.ok(!WARNINGS.test(text), `got: ${text}`);
});

test('item 2: a decided sale whose bale is on no Inventory row prints the bare number, no claim about it', async () => {
  reset({
    pending: [CONTACT],
    resolved: [{ requestId: 'SALE-TYPO', user: '4242', status: 'rejected', createdAt: daysAgo(2), resolvedAt: daysAgo(1), approver: 'Krishna', actionJSON: { action: 'sale_bundle', salesDate: '2026-09-25', items: [{ type: 'package', packageNo: '99999' }], totalYards: 150 } }],
    inventory: [],
  });
  const bot = createFakeBot();
  await openCard(bot, 'decided', 'SALE-TYPO');
  const text = lastText(bot);
  assert.match(text, /^🧾 Sale · 1B\n📅 25-Sep-2026\n\n {2}1\. 99999\nQueued total: 150 yards\n\n❌ _Already rejected by Krishna/, `got: ${text}`);
  assert.ok(!/not resolved|no available stock|NOTHING/.test(text), `got: ${text}`);
});

test('item 2: a PENDING sale reads exactly as before — the warning and the restart line stay', async () => {
  reset({
    pending: [{ requestId: 'SALE-HALF', user: '4242', status: 'pending', createdAt: daysAgo(1), actionJSON: SALE_AJ }],
    inventory: SOLD_STOCK,
  });
  const bot = createFakeBot();
  await openCard(bot, 'sales', 'SALE-HALF');
  const text = lastText(bot);
  assert.match(text, /⚠️ no available stock \(sold already, or unknown number\)/, `got: ${text}`);
  assert.match(text, /⚠️ 2 of 2 item\(s\) marked ⚠️ are sold to Ayubal Ansari on 25-Sep-2026 — this request's own half-done run\. Approve restarts it/, `got: ${text}`);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'abx:ok:SALE-HALF'), 'and Approve is still offered');
});

/* ──────────── 3. request types that had no card of their own ──────────── */

const EXPENSE = {
  requestId: 'P-EXP', user: '4242', status: 'pending', createdAt: daysAgo(1),
  actionJSON: {
    action: 'record_office_expense', branch: 'Kano office', manager_id: '4242', manager_name: 'Abdul', date: '2026-11-10',
    items: [
      { kind: 'expense', title: 'Generator fuel', amount: 12500, ref_id: '' },
      { kind: 'person_allowance', title: 'Sani', amount: 3000, ref_id: '5551' },
      { kind: 'commission', title: 'Broker', amount: 2000.5, ref_id: '' },
    ],
    total_amount: 17500.5,
  },
};
const ACCOUNT = {
  requestId: 'P-ACC', user: '4242', status: 'pending', createdAt: daysAgo(1),
  actionJSON: {
    action: 'register_payment_account', owner_name: 'Sani Loader', owner_type: 'employee',
    account_number: '0123456789', bank: 'GTBank', owner_telegram_id: '5551', account_id: 'ACC-0007',
  },
};

test('item 3: an office-expense batch opens with the office, every item, its amount and the total', async () => {
  reset({ pending: [EXPENSE, ACCOUNT] });
  const bot = createFakeBot();
  await openCard(bot, 'finance', 'P-EXP');
  const text = lastText(bot);
  assert.match(text, /^💸 Office expenses \(Kano office\) — 3 item\(s\), ₦17,500\.5\n🧾 Generator fuel — ₦12,500\n👤 Sani — ₦3,000\n🤝 Broker — ₦2,000\.5\n\n_Requested by Abdul/,
    `the card the first admin got, rebuilt from the row, got: ${text}`);
  assert.ok(lastKb(bot).some((b) => b.callback_data === 'abx:ok:P-EXP'), 'and it can still be approved from here');
});

test('item 3: a payee-account registration opens with holder, kind, number, bank and the linked Telegram user', async () => {
  reset({ pending: [EXPENSE, ACCOUNT] });
  const bot = createFakeBot();
  await openCard(bot, 'payments', 'P-ACC');
  const text = lastText(bot);
  assert.match(text, /^Register payment account: Sani Loader \(employee\)\nAccount: 0123456789 · GTBank\nLinked Telegram: Sani Loader · 5551 ✓ registered employee\nOnce approved, payments can be raised against this account\.\n\n_Requested by Abdul/,
    `got: ${text}`);
});

/* ───────────── 4. a supply request an admin rejected early ───────────── */

const SUPPLY_AJ = {
  action: 'supply_request', warehouse: 'IDUMOTA', customer: 'CJE', salesperson: 'Abdul', stage: 'admin_review',
  requestedAssignee: { user_id: '901', name: 'Musa' },
  confirmedByDispatch: { user_id: '902', name: 'Emeka', ts: daysAgo(1) },
  cart: [{ design: '9006', shade: '3', quantity: 2 }],
};

test('item 4: the record of a supply request an admin rejected names the rejecter and waits on nobody', async () => {
  reset({
    pending: [CONTACT],
    resolved: [{ requestId: 'SUP-NO', user: '4242', status: 'rejected', createdAt: daysAgo(2), resolvedAt: daysAgo(1), approver: 'Musa', actionJSON: SUPPLY_AJ }],
  });
  const bot = createFakeBot();
  await openCard(bot, 'decided', 'SUP-NO');
  const text = lastText(bot);
  assert.match(text, /❌ _Already rejected by Musa/, `got: ${text}`);
  assert.ok(!/Waiting on/.test(text), `a decided request waits on nobody, got: ${text}`);
  assert.match(text, /^Supply Request · 🏭 IDUMOTA\n👤 CJE/, 'the request itself is still shown');
});

test('item 4: a PENDING supply request keeps its waiting line; a completed one keeps who accepted it', async () => {
  reset({
    pending: [{ requestId: 'SUP-WAIT', user: '4242', status: 'pending', createdAt: daysAgo(1), actionJSON: SUPPLY_AJ }],
    resolved: [{ requestId: 'SUP-DONE', user: '4242', status: 'approved', createdAt: daysAgo(3), resolvedAt: daysAgo(1), approver: 'Krishna',
      actionJSON: { ...SUPPLY_AJ, stage: 'completed', assignedDispatch: { user_id: '901', name: 'Musa' } } }],
  });
  const bot = createFakeBot();
  await openCard(bot, 'sales', 'SUP-WAIT');
  assert.match(lastText(bot), /🛂 Waiting on an admin to approve · confirmed by Emeka/, `got: ${lastText(bot)}`);
  sessionStore.clear(ADMIN);
  const bot2 = createFakeBot();
  await openCard(bot2, 'decided', 'SUP-DONE');
  assert.match(lastText(bot2), /✅ Accepted by Musa/, `the outcome line is a record, not a wait, got: ${lastText(bot2)}`);
  assert.match(lastText(bot2), /✅ _Already approved by Krishna/);
});
