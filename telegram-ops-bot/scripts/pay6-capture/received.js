'use strict';

/**
 * PAYMENT JOURNEY — segment "received"
 * A customer's payment is recorded (💰 Finance → 💵 Payment Received) and approved.
 *
 * Run (from telegram-ops-bot/; BOT_ROOT = the bot folder, default the folder
 * two levels above this script):
 *   node scripts/pay6-capture/received.js > received.json
 *
 * Prints ONE JSON document on stdout. Every log line goes to stderr.
 *
 * What is real: the controller (handleMessage / handleCallbackQuery), the
 * payment-received flow, the approval gate, approvalEvents (the admin card,
 * the two approval taps), risk/evaluate, the executor
 * (inventoryService.executeApprovedAction → crmService.recordPayment →
 * accountingService), every repository, the navigation guard.
 * What is faked: the Sheets client (in-memory rows — the project's own
 * test/helpers/fakeSheets), the Telegram bot (the project's own recording
 * test/helpers/fakeBot), the intent parser (never reached; the typed-text
 * mode is put back to the production default), the clock and the random
 * ids (so two runs give the same bytes). Nothing in the repository is written.
 */

/* ── 0. stdout is for the JSON only ─────────────────────────────────────── */
const util = require('util');
const toErr = (...a) => { process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 3 }))).join(' ')}\n`); };
console.log = toErr; console.info = toErr; console.warn = toErr; console.error = toErr; console.debug = toErr;

/* ── 1. fixed clock: 11-Nov-2026, Lagos wall clock (UTC+1, no DST) ──────── */
const RealDate = Date;
let NOW = RealDate.parse('2026-11-11T09:20:00.000Z'); // 10:20 in Lagos
class FixedDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
}
global.Date = FixedDate;
let LAGOS = '10:20:00';
/** Set the clock to HH:MM:SS Lagos time on 11-Nov-2026. */
function at(hms) {
  const [h, m, s] = String(hms).split(':').map(Number);
  NOW = RealDate.UTC(2026, 10, 11, h - 1, m, s || 0);
  LAGOS = hms;
}

/* ── 2. deterministic ids ───────────────────────────────────────────────── */
// idGenerator.requestId() is crypto.randomUUID(); the ledger entry ids take
// four random bytes. Both are pinned so the first request reads R-C3A9 every run.
const crypto = require('crypto');
const FIXED_UUIDS = [
  'c3a95e10-7b2d-4e8a-9f61-0d4c2b7a8e35', // the worked example: ABBA pays 50,000 by Zenith
  'e61d07b4-2f9a-4c58-b3e7-9a1c5d8f2046', // the second identical payment (Submit tapped twice)
  '5b7f2a90-c4d1-4e36-8a05-71e9d3c6f2b8', // minted for the re-entry within 20 s, never used (merged)
  'a2f08c7e-13b5-4d69-9e42-6c0f8b1d5a73', // the same payment entered again a minute later (flagged)
];
let uuidN = 0;
crypto.randomUUID = () => {
  const u = FIXED_UUIDS[uuidN] || `00000000-0000-4000-8000-${String(uuidN).padStart(12, '0')}`;
  uuidN += 1;
  return u;
};
let bytesN = 0;
const realRandomBytes = crypto.randomBytes;
crypto.randomBytes = (n, cb) => {
  if (n !== 4 || typeof cb === 'function') return realRandomBytes(n, cb);
  bytesN += 1;
  const b = Buffer.alloc(4);
  b.writeUInt32BE((0x9c41a7e3 + bytesN * 0x01000193) >>> 0);
  return b;
};

/* ── 3. the cast, as environment (BEFORE the harness is required) ───────── */
const ABDUL = '5001';
const KRISHNA = '9001';
const MUSA = '9002';
const FINANCE = '7001';
const CAST = { [ABDUL]: 'Abdul', [KRISHNA]: 'Krishna', [MUSA]: 'Musa', [FINANCE]: 'Finance' };
process.env.ADMIN_IDS = `${KRISHNA},${MUSA}`;
process.env.EMPLOYEE_IDS = `${ABDUL},${FINANCE}`;
for (const k of ['FINANCE_IDS', 'SUPER_ADMIN_IDS', 'ANALYTICS_ENABLED', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'TELEGRAM_TOKEN', 'GOOGLE_CREDENTIALS_JSON', 'GOOGLE_CREDENTIALS_PATH', 'GOOGLE_SHEET_ID', 'DATABASE_URL',
  'INVOICE_RATE_MULTIPLIER']) delete process.env[k];

const REPO = process.env.BOT_ROOT || require('path').resolve(__dirname, '..', '..');
const path = require('path');
const { createFakeBot } = require(path.join(REPO, 'test/helpers/fakeBot'));
const { createFakeSheets } = require(path.join(REPO, 'test/helpers/fakeSheets'));
const { installFakeSheets, installFakeIntent, loadController, SRC } = require(path.join(REPO, 'test/helpers/controllerHarness'));

/* ── 4. the workbook, as rows ───────────────────────────────────────────── */
const BANK_LIST = 'GTBank,Zenith,FirstBank,Access,UBA,OPAY,ZENITH — BLACK PANTHER,GTBANK — BLACK PANTHER';
// The brief fixes the department NAME (Operations) and that its
// allowed_activities include payment_received; the rest of the list is the
// one the other segments of this capture seed, so every segment draws the
// same greeting menu. 💳 Payments is injected for everyone by the controller.
const OPERATIONS_ACTIVITIES = [
  'supply_request', 'sell_bale', 'my_orders', 'check_stock', 'list_packages',
  'transfer_stock', 'transfers_view', 'customer_details', 'add_customer',
  'payment_received', 'office_expense',
].join(',');
const SEEDED = '2026-07-01T08:00:00.000Z';
const ABBA_ID = 'CUST-20260701-0A1B2C3D';
// ABBA is the brief's customer. The other names are FILLER, there only so the
// "Who paid?" list has more than eight entries and shows its pager row; one
// inactive row shows that a removed customer is not offered.
const CUSTOMER_ROWS = [
  [ABBA_ID, 'ABBA', '08030000001', 'Idumota, Lagos', 'Wholesale', 500000, 140000, '', '', 'Active', SEEDED, SEEDED, '', 'Lagos,IDUMOTA', '2026-07-14'],
  ['CUST-20260701-0B000002', 'Bello Textiles', '08030000002', '', 'Wholesale', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Lagos', '2026-07-20'],
  ['CUST-20260701-0C000003', 'Chika Fabrics', '08030000003', '', 'Retail', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'IDUMOTA', '2026-08-02'],
  ['CUST-20260701-0D000004', 'Danjuma Stores', '08030000004', '', 'Wholesale', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Kano office', '2026-08-09'],
  ['CUST-20260701-0E000005', 'Emeka & Sons', '08030000005', '', 'Wholesale', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Lagos', '2026-08-15'],
  ['CUST-20260701-0F000006', 'Fatima Wholesale', '08030000006', '', 'Wholesale', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Kano office', '2026-08-21'],
  ['CUST-20260701-0G000007', 'Garba Kano', '08030000007', '', 'Retail', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Kano office', '2026-09-01'],
  ['CUST-20260701-0H000008', 'Hauwa Fashion', '08030000008', '', 'Retail', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Lagos', '2026-09-12'],
  ['CUST-20260701-0I000009', 'Ibrahim Kano', '08030000009', '', 'Wholesale', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Kano office', '2026-09-20'],
  ['CUST-20260701-0J000010', 'Jide Lagos', '08030000010', '', 'Retail', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Lagos', '2026-10-03'],
  ['CUST-20260701-0K000011', 'Old Buyer', '', '', 'Retail', 0, 0, '', 'removed 23-Sep-2026', 'inactive', SEEDED, SEEDED, '', 'Lagos', '2026-07-05'],
];
const fake = createFakeSheets({
  Users: [
    ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs', 'store_sales_places'],
    [ABDUL, 'Abdul', 'employee', 'Lagos', 'branch_only', 'active', SEEDED, 'Operations', 'Lagos,IDUMOTA', '', '', ''],
    [FINANCE, 'Finance', 'employee', 'Lagos', 'branch_only', 'active', SEEDED, 'Finance', '', '', '', ''],
    [KRISHNA, 'Krishna', 'admin', '', 'all', 'active', SEEDED, 'Admin', '', '', '', ''],
    [MUSA, 'Musa', 'admin', '', 'all', 'active', SEEDED, 'Admin', '', '', '', ''],
  ],
  Departments: [
    ['dept_id', 'dept_name', 'allowed_activities', 'status', 'created_at', 'parent_department', 'warehouses'],
    ['DEPT-OPS', 'Operations', OPERATIONS_ACTIVITIES, 'active', SEEDED, '', ''],
    ['DEPT-FIN', 'Finance', 'payments', 'active', SEEDED, '', ''],
  ],
  Settings: [
    ['Key', 'Value', 'UpdatedAt'],
    ['BANK_LIST', BANK_LIST, SEEDED],
  ],
  Customers: [
    ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases', 'stores', 'first_sale_at'],
    ...CUSTOMER_ROWS,
  ],
  Chart_of_Accounts: [
    ['account_code', 'account_name', 'account_type', 'parent_code', 'is_active'],
    ['1001', 'Cash', 'Asset', '', 'TRUE'],
    ['1002', 'Bank', 'Asset', '', 'TRUE'],
    ['1100', 'Customer Receivable', 'Asset', '', 'TRUE'],
    ['3001', 'Sales Revenue', 'Income', '', 'TRUE'],
  ],
  // The admin card reads "Outstanding today" from the LEDGER (the running
  // balance of the customer's Customer Receivable entries), not from the
  // Customers sheet's outstanding_balance cell. One earlier sale of 140,000.
  Ledger_Entries: [
    ['entry_id', 'txn_id', 'date', 'account_code', 'ledger_name', 'debit', 'credit', 'narration', 'created_by', 'created_at', 'customer_id'],
    ['LE-20261020-00000001', 'SALE-20261020-1', '2026-10-20', '1100', 'Customer Receivable', 140000, 0,
      'Sale: 1000 yds 9006 3 pkg 1111 to ABBA | Not yet paid', KRISHNA, '2026-10-20T10:00:00.000Z', ABBA_ID],
  ],
  ApprovalQueue: [
    ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'],
  ],
});
installFakeSheets(fake);
// No OpenAI, ever — and then the typed-text switch goes back to what
// production runs with (Settings AI_TEXT_PARSER = 0): installFakeIntent pins
// the pre-01-Nov AI mode for the test-suite, which is not what staff see.
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
require(path.join(SRC, 'utils/typedRouter')).forceMode(null);
const controller = loadController();

/* ── 5. the recording bot ───────────────────────────────────────────────── */
const base = createFakeBot();
const LOG = [];
let STEP = { key: '', label: '', actor: '' };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const bot = {};
/** chat → Map(message_id → the buttons currently on that bubble) — so a tap can only land on a button that is really on screen. */
const SCREEN = new Map();
const bubbleOf = (chat) => { const k = String(chat); if (!SCREEN.has(k)) SCREEN.set(k, new Map()); return SCREEN.get(k); };
const flat = (rm) => ((rm && Array.isArray(rm.inline_keyboard)) ? rm.inline_keyboard.flat().map((b) => b.callback_data) : []);
function track(method, args, res) {
  if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument') {
    if (res && res.message_id) bubbleOf(args[0]).set(res.message_id, flat(args[2] && args[2].reply_markup));
  } else if (method === 'editMessageText' || method === 'editMessageCaption') {
    const o = args[1] || {};
    if (o.message_id) bubbleOf(o.chat_id).set(o.message_id, flat(o.reply_markup));
  } else if (method === 'editMessageReplyMarkup') {
    const o = args[1] || {};
    if (o.message_id) bubbleOf(o.chat_id).set(o.message_id, flat(args[0]));
  } else if (method === 'deleteMessage') {
    bubbleOf(args[0]).delete(args[1]);
  }
}
for (const key of Object.keys(base)) {
  if (typeof base[key] !== 'function' || key === 'callsTo' || key === 'allText') { bot[key] = base[key]; continue; }
  bot[key] = async (...args) => {
    const entry = { stepKey: STEP.key, step: STEP.label, actor: STEP.actor, method: key, args: clone(args), lagos: LAGOS };
    LOG.push(entry);
    const res = await base[key](...args);
    entry.result = clone(res);
    track(key, args, res);
    return res;
  };
}

/* ── 6. driving helpers ─────────────────────────────────────────────────── */
let updateN = 0;
let userMsgId = 500;
const CB_ACTOR = {};
/** Let fire-and-forget work a handler started (usage tracking, cache refresh) settle. */
const settle = () => new Promise((r) => setImmediate(r));
/** A person types `text` in their private chat with the bot. */
async function types(key, uid, text, label) {
  STEP = { key, label, actor: CAST[uid] };
  userMsgId += 1;
  await controller.handleMessage(bot, {
    message_id: userMsgId, date: Math.floor(Date.now() / 1000),
    chat: { id: uid, type: 'private' }, from: { id: uid, first_name: CAST[uid] }, text,
  });
  await settle();
}
/** The newest bubble in a person's chat that currently shows a button carrying `data`. */
function bubbleWith(uid, data) {
  const ids = [...bubbleOf(uid).entries()].filter(([, cbs]) => cbs.includes(data)).map(([id]) => id);
  if (!ids.length) throw new Error(`no bubble in ${CAST[uid]}'s chat shows a button "${data}"`);
  return Math.max(...ids);
}
function tapUpdate(uid, data, messageId) {
  updateN += 1;
  const id = `cbq-${updateN}`;
  CB_ACTOR[id] = CAST[uid];
  return {
    id, data, from: { id: uid, first_name: CAST[uid] },
    message: { message_id: messageId, chat: { id: uid, type: 'private' } },
  };
}
/** A person taps the button carrying `data` — it must be on screen in their chat. */
async function taps(key, uid, data, label, messageId) {
  STEP = { key, label, actor: CAST[uid] };
  await controller.handleCallbackQuery(bot, tapUpdate(uid, data, messageId || bubbleWith(uid, data)));
  await settle();
}
/** Two taps on the same button with no wait between them (a double tap). */
async function tapsTwice(key, uid, data, label) {
  STEP = { key, label, actor: CAST[uid] };
  const messageId = bubbleWith(uid, data);
  await Promise.all([
    controller.handleCallbackQuery(bot, tapUpdate(uid, data, messageId)),
    controller.handleCallbackQuery(bot, tapUpdate(uid, data, messageId)),
  ]);
  await settle();
}
const queueRows = () => fake._store.get('ApprovalQueue').slice(1);
const expectQueue = (n, why) => { if (queueRows().length !== n) throw new Error(`${why}: expected ${n} queue row(s), found ${queueRows().length}`); };

/* ── 7. the walk ────────────────────────────────────────────────────────── */
// Steps listed here are REPLAYS: the bot redraws screens that are byte for
// byte the ones already captured earlier in the walk. They stay in `cards`
// (the complete log) and are left out of `structured_cards`.
const REPLAY = new Set(['pick2', 'amount2', 'method2', 'again3', 'pick3', 'amount3', 'method3',
  'again4', 'pick4', 'amount4', 'method4', 'again5']);
const FACTS = {};
async function main() {
  /* A — Abdul records the payment */
  at('10:20:00');
  await types('menu', ABDUL, 'menu', 'Abdul types: menu');
  at('10:20:06');
  await taps('finance', ABDUL, 'act:__hub__:finance', 'Abdul taps 💰 Finance');
  at('10:20:10');
  await taps('open', ABDUL, 'act:payment_received', 'Abdul taps 💵 Payment Received');
  at('10:20:14');
  await taps('next', ABDUL, 'prc:pg:1', 'EXTRA — Abdul taps Next ▶ (page 2 of the customer list)');
  at('10:20:18');
  await types('nomatch', ABDUL, 'zzz', 'EXTRA — Abdul types letters no customer name contains: zzz');
  at('10:20:22');
  await types('search', ABDUL, 'abb', 'Abdul types part of the name: abb');
  at('10:20:27');
  await taps('pick', ABDUL, 'prc:c:0', 'Abdul taps 👤 ABBA');
  at('10:20:33');
  await types('badamount', ABDUL, 'fifty thousand', 'EXTRA — Abdul types the amount in words: fifty thousand');
  at('10:20:38');
  await types('amount', ABDUL, '50000', 'Abdul types the amount: 50000');
  at('10:20:45');
  await taps('method', ABDUL, 'prc:m:2', 'Abdul taps 🏦 Zenith');
  expectQueue(0, 'before Submit');
  at('10:20:52');
  await taps('submit', ABDUL, 'prc:submit', 'Abdul taps ✅ Submit for approval');
  expectQueue(1, 'after Submit');
  const REQ1 = String(queueRows()[0][0]);
  FACTS.after_submit = { queue_rows: 1, customers_sheet_outstanding_cell: fake._store.get('Customers')[1][6], ledger_rows: fake._store.get('Ledger_Entries').length - 1 };

  /* B — the two approvals */
  at('10:26:00');
  await taps('k_approve', KRISHNA, `approve:${REQ1}`, 'Krishna taps ✅ Approve on his approval card (the first of two approvals)');
  FACTS.after_first_approval = {
    queue_row: clone(queueRows()[0]),
    customers_sheet_outstanding_cell: fake._store.get('Customers')[1][6],
    ledger_rows: fake._store.get('Ledger_Entries').length - 1,
  };
  at('10:28:00');
  await taps('status1', ABDUL, `apg:st:${REQ1}`, 'EXTRA — Abdul taps 📋 Status on his "Approval 1 of 2" card');
  at('10:34:00');
  await taps('m_approve', MUSA, `approve:${REQ1}`, 'Musa taps ✅ Approve on his approval card (the second of two approvals)');
  FACTS.after_second_approval = {
    queue_row: clone(queueRows()[0]),
    customers_sheet_outstanding_cell: fake._store.get('Customers')[1][6],
    ledger_rows: fake._store.get('Ledger_Entries').length - 1,
  };
  at('10:36:00');
  await taps('status_done', ABDUL, `apg:st:${REQ1}`, 'EXTRA — Abdul taps 📋 Status again, after both approvals');

  /* C — a second identical payment; Submit tapped twice quickly */
  at('10:40:00');
  await taps('again', ABDUL, 'act:payment_received', 'Abdul taps 💵 Record another on his "Sent for approval" card (a second, identical payment)');
  at('10:40:06');
  await taps('pick2', ABDUL, 'prc:c:0', 'Abdul taps 👤 ABBA (second payment)');
  at('10:40:14');
  await types('amount2', ABDUL, '50000', 'Abdul types the same amount: 50000 (second payment)');
  at('10:40:20');
  await taps('method2', ABDUL, 'prc:m:2', 'Abdul taps 🏦 Zenith (second payment)');
  expectQueue(1, 'before the second Submit');
  const confirmBubble = bubbleWith(ABDUL, 'prc:submit');
  at('10:40:26');
  await tapsTwice('submit2', ABDUL, 'prc:submit', 'Abdul taps ✅ Submit for approval TWICE quickly on the second, identical payment (both taps arrive before the bot has answered the first)');
  expectQueue(2, 'after the double tap');
  const REQ2 = String(queueRows()[1][0]);
  at('10:40:29');
  await taps('submit_late', ABDUL, 'prc:submit', 'EXTRA — a third tap on ✅ Submit for approval three seconds later (a phone that has not yet redrawn the card)', confirmBubble);
  expectQueue(2, 'after the late third tap');
  FACTS.double_tap = {
    queue_rows_before: 1, queue_rows_after: 2, new_requests_raised: 1,
    approval_cards_sent_to_admins: LOG.filter((e) => ['submit2', 'submit_late'].includes(e.stepKey) && e.method === 'sendMessage' && [KRISHNA, MUSA].includes(String(e.args[0]))).length,
    receipts_drawn_for_abdul: LOG.filter((e) => ['submit2', 'submit_late'].includes(e.stepKey) && e.method === 'editMessageText' && /Sent for approval/.test(String(e.args[0]))).length,
  };

  /* E1 — EXTRA: the same payment entered again within 20 seconds → the gate hands back the open request */
  at('10:40:31');
  await taps('again3', ABDUL, 'act:payment_received', 'EXTRA — Abdul taps 💵 Record another straight away');
  at('10:40:34');
  await taps('pick3', ABDUL, 'prc:c:0', 'EXTRA — Abdul taps 👤 ABBA');
  at('10:40:38');
  await types('amount3', ABDUL, '50000', 'EXTRA — Abdul types 50000');
  at('10:40:41');
  await taps('method3', ABDUL, 'prc:m:2', 'EXTRA — Abdul taps 🏦 Zenith');
  at('10:40:44');
  await taps('submit3', ABDUL, 'prc:submit', 'EXTRA — Abdul enters the very same payment a third time and taps ✅ Submit for approval 18 seconds after the second one was sent');
  expectQueue(2, 'after the re-entry within 20 seconds');
  FACTS.same_payment_again_within_20s = {
    seconds_after_the_open_request: 18, queue_rows_after: 2, new_requests_raised: 0,
    approval_cards_sent_to_admins: LOG.filter((e) => e.stepKey === 'submit3' && e.method === 'sendMessage').length,
  };

  /* D — what the buttons on his card do, on the request that is still waiting */
  at('10:41:00');
  await taps('status2', ABDUL, `apg:st:${REQ2}`, 'EXTRA — Abdul taps 📋 Status on his "Sent for approval" card (nobody has signed yet)');
  at('10:41:10');
  await taps('nudge', ABDUL, `apg:nudge:${REQ2}`, 'EXTRA — Abdul taps 🔔 Remind approvers on his "Sent for approval" card');

  /* E2 — EXTRA: the same payment entered again two minutes later → raised, and flagged to the admins */
  at('10:43:00');
  await taps('again4', ABDUL, 'act:payment_received', 'EXTRA — Abdul taps 💵 Record another two minutes later');
  at('10:43:05');
  await taps('pick4', ABDUL, 'prc:c:0', 'EXTRA — Abdul taps 👤 ABBA');
  at('10:43:10');
  await types('amount4', ABDUL, '50000', 'EXTRA — Abdul types 50000');
  at('10:43:15');
  await taps('method4', ABDUL, 'prc:m:2', 'EXTRA — Abdul taps 🏦 Zenith');
  at('10:43:20');
  await taps('submit4', ABDUL, 'prc:submit', 'EXTRA — Abdul enters the very same payment again and taps ✅ Submit for approval about three minutes after the open one (outside the 20-second window)');
  expectQueue(3, 'after the re-entry outside the window');
  const REQ3 = String(queueRows()[2][0]);
  FACTS.same_payment_again_after_3_minutes = { queue_rows_after: 3, new_requests_raised: 1, flagged_on_the_admin_card: true };
  at('10:45:00');
  await taps('k_dup', KRISHNA, `apg:dup:${REQ3}`, 'EXTRA — Krishna taps ⧉ Reject as duplicate on the flagged card');
  FACTS.after_reject_as_duplicate = { queue_row: clone(queueRows()[2]) };

  /* F — EXTRA: Cancel */
  at('10:50:00');
  await taps('again5', ABDUL, 'act:payment_received', 'EXTRA — Abdul taps 💵 Record another');
  at('10:50:05');
  await taps('cancel', ABDUL, 'prc:cancel', 'EXTRA — Abdul taps ❌ Cancel on the "Who paid?" card');
  expectQueue(3, 'after Cancel');

  return { REQ1, REQ2, REQ3 };
}

/* ── 8. notes: when the wording differs ─────────────────────────────────── */
// Keyed `<stepKey>|<method>|<recipient>`.
const NOTES = {
  'method|editMessageText|Abdul': 'PAY-6 check: money coming IN — after the bank chip the next screen is this confirm card; no "Pay from which account?" picker is drawn anywhere in this segment (that picker is for request_payment only, spec §2). The two company accounts in BANK_LIST (ZENITH — BLACK PANTHER, GTBANK — BLACK PANTHER) appear on the previous screen as ordinary 🏦 chips because the door lists every BANK_LIST entry. The line "An admin approves it" is the flow\'s wording; the code requires TWO admins for an employee\'s record_payment.',
  'amount|editMessageText|Abdul': '"How was it paid?": 💵 Cash then one 🏦 chip per BANK_LIST entry, in sheet order (prc:m:<i>).',
  'submit|sendMessage|Krishna': 'Sent to every admin (Krishna and Musa get the same card). Outstanding today is read from the ledger (Customer Receivable running balance).',
  'submit|sendMessage|Musa': 'Same card as Krishna\'s.',
  'k_approve|answerCallbackQuery|Krishna': 'Pop-up (toast). No paying-account picker on this or the completing approval — PAY-6 does not apply to record_payment.',
  'k_approve|editMessageReplyMarkup|Krishna': 'The buttons are taken off Krishna\'s approval card; its text stays.',
  'm_approve|editMessageReplyMarkup|Musa': 'The buttons are taken off Musa\'s approval card; its text stays. No "Pay from which account?" picker before this — the completing approval executes at once.',
  'm_approve|sendMessage|Musa': '',
  'submit2|sendMessage|Krishna': 'ONE approval card per admin although Submit was tapped twice — the second tap raises nothing.',
  'submit2|editMessageText|Abdul': 'ONE "Sent for approval" redraw for the two taps; the second tap was answered silently.',
};
const REPLAY_NOTE = 'Same screen as the first payment (byte-identical text and buttons).';

/* ── 9. the log → cards ─────────────────────────────────────────────────── */
const KIND = {
  sendMessage: 'message', editMessageText: 'edit', editMessageCaption: 'edit', editMessageReplyMarkup: 'edit',
  editMessageMedia: 'edit', answerCallbackQuery: 'popup', sendPhoto: 'photo', sendMediaGroup: 'photo',
  sendDocument: 'document', deleteMessage: 'delete', sendChatAction: 'chat_action', getFile: 'get_file',
};
const who = (chatId) => CAST[String(chatId)] || `chat ${chatId}`;
const rowsOf = (rm) => ((rm && Array.isArray(rm.inline_keyboard)) ? rm.inline_keyboard : null);
function toCard(e, i) {
  const a = e.args;
  const card = { n: i + 1, step: e.step, actor: e.actor, recipient: '', kind: KIND[e.method] || e.method, method: e.method, text: '', parse_mode: null };
  let opts = null;
  let kb = null;
  if (e.method === 'sendMessage') {
    card.recipient = who(a[0]); card.text = a[1]; opts = a[2] || {};
    card.message_id = e.result && e.result.message_id;
  } else if (e.method === 'editMessageText' || e.method === 'editMessageCaption') {
    opts = a[1] || {}; card.recipient = who(opts.chat_id); card.text = a[0]; card.edits_message_id = opts.message_id;
  } else if (e.method === 'editMessageReplyMarkup') {
    opts = a[1] || {}; card.recipient = who(opts.chat_id); card.edits_message_id = opts.message_id;
    kb = rowsOf(a[0]) || [];
    card.keyboard_only = true;
  } else if (e.method === 'answerCallbackQuery') {
    const o = a[1] || {};
    card.recipient = CB_ACTOR[a[0]] || e.actor;
    card.text = o.text || '';
    card.alert = !!o.show_alert;
    card.silent = !o.text;
    card.callback_query_id = a[0];
  } else if (e.method === 'sendPhoto' || e.method === 'sendDocument') {
    opts = a[2] || {}; card.recipient = who(a[0]); card.text = opts.caption || ''; card.file = a[1];
    card.message_id = e.result && e.result.message_id;
  } else if (e.method === 'deleteMessage') {
    card.recipient = who(a[0]); card.deletes_message_id = a[1];
  } else {
    card.recipient = who(a[0]);
  }
  if (opts) {
    card.parse_mode = opts.parse_mode || null;
    if (kb == null) kb = rowsOf(opts.reply_markup);
  }
  card.keyboard = kb ? kb.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callback_data }))) : null;
  card.buttons = kb ? kb.map((row) => row.map((b) => b.text)) : [];
  card.callbacks = kb ? kb.map((row) => row.map((b) => b.callback_data)) : [];
  card.clock_lagos = `11-Nov-2026 ${e.lagos}`;
  // Which bubble on the phone this call touches (ids are the fake bot's own counter).
  const bubble = card.message_id ? ` [new bubble #${card.message_id}]`
    : (card.edits_message_id ? ` [${card.keyboard_only ? 'buttons of' : 'rewrites'} bubble #${card.edits_message_id}]` : '');
  const note = [NOTES[`${e.stepKey}|${e.method}|${card.recipient}`] || '', REPLAY.has(e.stepKey) && e.method !== 'answerCallbackQuery' ? REPLAY_NOTE : ''].filter(Boolean).join(' ');
  card.notes = `${note}${bubble}`.trim();
  card.stepKey = e.stepKey;
  card.from_source = false;
  return card;
}

/**
 * Keep only what a person actually sees: drop silent pop-ups, deletes,
 * chat actions and the momentary keyboard strip (an editMessageReplyMarkup
 * that empties a bubble's buttons and is followed, in the same step, by a
 * text edit of that same bubble).
 */
function visible(all) {
  return all.filter((c, i) => {
    if (c.kind === 'popup') return !c.silent;
    if (c.kind === 'delete' || c.kind === 'chat_action' || c.kind === 'get_file') return false;
    if (c.keyboard_only) {
      const redrawn = all.slice(i + 1).some((d) => d.stepKey === c.stepKey && !d.keyboard_only && d.edits_message_id === c.edits_message_id && d.recipient === c.recipient);
      return !redrawn;
    }
    return true;
  });
}
function toRequired(c) {
  let notes = c.notes;
  if (c.kind === 'popup') notes = `${c.alert ? 'Pop-up: ALERT box (show_alert = true).' : 'Pop-up: toast (show_alert = false).'} ${notes}`.trim();
  if (c.keyboard_only) notes = `Keyboard-only edit: the bubble keeps its text, its buttons become the ones listed (none = removed). ${notes}`.trim();
  return {
    step: c.step, actor: c.actor, recipient: c.recipient, kind: c.kind,
    text: c.text, parse_mode: c.parse_mode || null,
    buttons: c.buttons, callbacks: c.callbacks, notes,
  };
}

/** The same card in the shape the workflow's structured answer takes. */
function toStructured(c) {
  const out = { step: c.step, actor: c.actor, recipient: c.recipient, kind: c.kind, text: c.text };
  if (c.kind === 'popup') out.notes = `${c.silent ? 'Pop-up: none (silent). ' : (c.alert ? 'Pop-up: ALERT box (show_alert = true). ' : 'Pop-up: toast (show_alert = false). ')}${c.notes}`.trim();
  else {
    out.parse_mode = c.parse_mode || 'plain';
    out.buttons = c.buttons;
    out.callbacks = c.callbacks;
    out.notes = c.notes;
  }
  out.from_source = false;
  return out;
}

main().then(({ REQ1, REQ2, REQ3 }) => {
  const sheet = (name) => fake._store.get(name) || [];
  const risk = require(path.join(SRC, 'risk/evaluate'));
  const out = {
    segment: 'received',
    how_the_clock_is_fixed: 'global Date is replaced by a subclass whose no-argument constructor and Date.now() return a value the script sets before every step (11-Nov-2026, Lagos wall clock = UTC+1, from 10:20).',
    how_ids_are_fixed: 'crypto.randomUUID (the request id) and the four random bytes of the LE-… ledger entry ids are replaced by fixed values.',
    cast: CAST,
    admin_ids: process.env.ADMIN_IDS,
    employee_ids: process.env.EMPLOYEE_IDS,
    finance_ids_env: process.env.FINANCE_IDS || null,
    settings_bank_list: BANK_LIST,
    operations_allowed_activities: OPERATIONS_ACTIVITIES,
    request_ids: { first: REQ1, second: REQ2, third_flagged_and_rejected: REQ3 },
    approvals_the_code_requires: {
      action: 'record_payment',
      in_ALWAYS_APPROVAL_ACTIONS: risk.ALWAYS_APPROVAL_ACTIONS.includes('record_payment'),
      in_DUAL_ADMIN_ACTIONS: risk.DUAL_ADMIN_ACTIONS.includes('record_payment'),
      employee_requester_two_admins: risk.requiredAdminApprovals({ action: 'record_payment', requesterIsAdmin: false, adminCount: 2 }),
      employee_requester_one_admin_only: risk.requiredAdminApprovals({ action: 'record_payment', requesterIsAdmin: false, adminCount: 1 }),
      admin_requester: risk.requiredAdminApprovals({ action: 'record_payment', requesterIsAdmin: true, adminCount: 1 }),
    },
    pay6_paying_account_asked: LOG.some((e) => /Pay from which account|pay:from/.test(JSON.stringify(e.args))),
    facts: FACTS,
    cards: visible(LOG.map(toCard)).map(toRequired),
    all_calls: LOG.map(toCard),
    sheets_after: {
      ApprovalQueue: sheet('ApprovalQueue'),
      Ledger_Entries: sheet('Ledger_Entries'),
      Customers_ABBA_row: sheet('Customers')[1],
    },
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`, () => process.exit(0));
}).catch((e) => {
  process.stderr.write(`CAPTURE FAILED: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
