'use strict';

/**
 * PRC-2 GUIDE — the screens of "Payment Received: ask an admin", captured
 * from the bot's REAL code, one scene per run.
 *
 * Run (from telegram-ops-bot/; BOT_ROOT = the bot folder, default the folder
 * two levels above this script):
 *   node scripts/prc2-capture/capture.js --scene A > A.json
 *
 * Scenes (each in its own process, on the same seeded workbook):
 *   A  Abdul knows the amount and asks Musa; Musa approves, Krishna approves.
 *   B  Abdul does not know the amount; Musa types it; Krishna checks it.
 *   C  Musa does not answer: reminders, 🔔 Remind approvers, the widen hour,
 *      Krishna approves first from 🛂 Approvals.
 *   D  Abdul taps 👥 Any admin: both admins get the ordinary card.
 *
 * Prints ONE JSON document on stdout. Every log line goes to stderr.
 *
 * What is real: the controller (handleMessage / handleCallbackQuery), the
 * payment-received flow, the approval gate, approvalEvents, risk/evaluate,
 * the reminder sweep (approvalReminder.sweep — what server.js runs on its
 * timer), the executor and every repository, the navigation guard.
 * What is faked: the Sheets client (in-memory rows — the project's own
 * test/helpers/fakeSheets), the Telegram bot (the project's own recording
 * test/helpers/fakeBot, wrapped so a tap can only land on a button that is
 * really on screen, and a tap on a reply carries the message it replies to,
 * as Telegram does), the intent parser (never reached), the clock (16-Nov-2026,
 * Lagos) and the random ids. Nothing in the repository is written.
 */

/* ── 0. stdout is for the JSON only ─────────────────────────────────────── */
const util = require('util');
const toErr = (...a) => { process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 3 }))).join(' ')}\n`); };
console.log = toErr; console.info = toErr; console.warn = toErr; console.error = toErr; console.debug = toErr;

const SCENE = (() => {
  const i = process.argv.indexOf('--scene');
  const s = i > 0 ? String(process.argv[i + 1] || '').toUpperCase() : '';
  if (!['A', 'B', 'C', 'D'].includes(s)) {
    process.stderr.write('usage: node scripts/prc2-capture/capture.js --scene A|B|C|D\n');
    process.exit(2);
  }
  return s;
})();

/* ── 1. fixed clock: 16-Nov-2026, Lagos wall clock (UTC+1, no DST) ──────── */
const RealDate = Date;
let NOW = RealDate.UTC(2026, 10, 16, 9, 0, 0);
class FixedDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
}
global.Date = FixedDate;
let LAGOS = '10:00:00';
/** Set the clock to HH:MM:SS Lagos time on 16-Nov-2026. */
function at(hms) {
  const [h, m, s] = String(hms).split(':').map(Number);
  NOW = RealDate.UTC(2026, 10, 16, h - 1, m, s || 0);
  LAGOS = hms;
}

/* ── 2. deterministic ids ───────────────────────────────────────────────── */
// One fixed request id per scene, so the ref (R-XXXX) is the same every run.
const crypto = require('crypto');
const FIXED_UUIDS = {
  A: ['4f72a0c1-5e3b-4d8a-9c21-7b0e6d3f1a52'],
  B: ['b81e4c07-2a9d-4f63-8e15-3c7a0d9b6f24'],
  C: ['c5d93a1e-7f04-4b2c-a6e8-1d2f9b0c4e73'],
  D: ['d27b6e90-3c1f-4a85-b4d2-8e6a1f0c9b35'],
}[SCENE];
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
  b.writeUInt32BE((0x5a3c91e7 + bytesN * 0x01000193) >>> 0);
  return b;
};

/* ── 3. the cast, as environment (BEFORE the harness is required) ───────── */
const ABDUL = '5001';
const KRISHNA = '9001';
const MUSA = '9002';
const CAST = { [ABDUL]: 'Abdul', [KRISHNA]: 'Krishna', [MUSA]: 'Musa' };
process.env.ADMIN_IDS = `${KRISHNA},${MUSA}`;
process.env.EMPLOYEE_IDS = ABDUL;
for (const k of ['FINANCE_IDS', 'SUPER_ADMIN_IDS', 'ANALYTICS_ENABLED', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'TELEGRAM_TOKEN', 'GOOGLE_CREDENTIALS_JSON', 'GOOGLE_CREDENTIALS_PATH', 'GOOGLE_SHEET_ID', 'DATABASE_URL',
  'INVOICE_RATE_MULTIPLIER']) delete process.env[k];

const path = require('path');
const REPO = process.env.BOT_ROOT || path.resolve(__dirname, '..', '..');
const { createFakeBot } = require(path.join(REPO, 'test/helpers/fakeBot'));
const { createFakeSheets } = require(path.join(REPO, 'test/helpers/fakeSheets'));
const { installFakeSheets, installFakeIntent, loadController, SRC } = require(path.join(REPO, 'test/helpers/controllerHarness'));

/* ── 4. the workbook, as rows ───────────────────────────────────────────── */
// Same bank list as the PAY-6 guides: 🏦 Manage Banks holds these.
const BANK_LIST = 'GTBank,Zenith,FirstBank,Access,UBA,OPAY,ZENITH — BLACK PANTHER,GTBANK — BLACK PANTHER';
const OPERATIONS_ACTIVITIES = [
  'supply_request', 'sell_bale', 'my_orders', 'check_stock', 'list_packages',
  'transfer_stock', 'transfers_view', 'customer_details', 'add_customer',
  'payment_received', 'office_expense',
].join(',');
const SEEDED = '2026-07-01T08:00:00.000Z';
const ABBA_ID = 'CUST-20260701-0A1B2C3D';
const CUSTOMER_ROWS = [
  [ABBA_ID, 'ABBA', '08030000001', 'Idumota, Lagos', 'Wholesale', 500000, 120000, '', '', 'Active', SEEDED, SEEDED, '', 'Lagos,IDUMOTA', '2026-07-14'],
  ['CUST-20260701-0B000002', 'Bello Textiles', '08030000002', '', 'Wholesale', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Lagos', '2026-07-20'],
  ['CUST-20260701-0C000003', 'Chika Fabrics', '08030000003', '', 'Retail', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'IDUMOTA', '2026-08-02'],
  ['CUST-20260701-0D000004', 'Danjuma Stores', '08030000004', '', 'Wholesale', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Kano office', '2026-08-09'],
];
const fake = createFakeSheets({
  Users: [
    ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs', 'store_sales_places'],
    [ABDUL, 'Abdul', 'employee', 'Lagos', 'branch_only', 'active', SEEDED, 'Operations', 'Lagos,IDUMOTA', '', '', ''],
    [KRISHNA, 'Krishna', 'admin', '', 'all', 'active', SEEDED, 'Admin', '', '', '', ''],
    [MUSA, 'Musa', 'admin', '', 'all', 'active', SEEDED, 'Admin', '', '', '', ''],
  ],
  Departments: [
    ['dept_id', 'dept_name', 'allowed_activities', 'status', 'created_at', 'parent_department', 'warehouses'],
    ['DEPT-OPS', 'Operations', OPERATIONS_ACTIVITIES, 'active', SEEDED, '', ''],
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
  // ABBA owes 120,000: one earlier sale on the ledger (the admin card reads
  // "Outstanding today" from the ledger's Customer Receivable balance).
  Ledger_Entries: [
    ['entry_id', 'txn_id', 'date', 'account_code', 'ledger_name', 'debit', 'credit', 'narration', 'created_by', 'created_at', 'customer_id'],
    ['LE-20261020-00000001', 'SALE-20261020-1', '2026-10-20', '1100', 'Customer Receivable', 120000, 0,
      'Sale: 800 yds 9006 to ABBA | Not yet paid', KRISHNA, '2026-10-20T10:00:00.000Z', ABBA_ID],
  ],
  ApprovalQueue: [
    ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'],
  ],
});
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
require(path.join(SRC, 'utils/typedRouter')).forceMode(null); // production default: no AI for typed text
const controller = loadController();
const approvalReminder = require(path.join(SRC, 'services/approvalReminder'));

/* ── 5. the recording bot ───────────────────────────────────────────────── */
const base = createFakeBot();
const LOG = [];
let STEP = { key: '', label: '', actor: '' };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const bot = {};
/** chat → Map(message_id → { kb, replyTo }) — what is on each bubble right now. */
const SCREEN = new Map();
const bubbleOf = (chat) => { const k = String(chat); if (!SCREEN.has(k)) SCREEN.set(k, new Map()); return SCREEN.get(k); };
const kbOf = (rm) => ((rm && Array.isArray(rm.inline_keyboard)) ? rm.inline_keyboard : []);
function track(method, args, res) {
  if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument') {
    const o = args[2] || {};
    if (res && res.message_id) bubbleOf(args[0]).set(res.message_id, { kb: clone(kbOf(o.reply_markup)), replyTo: o.reply_to_message_id || null });
  } else if (method === 'editMessageText' || method === 'editMessageCaption') {
    const o = args[1] || {};
    if (o.message_id) {
      const prev = bubbleOf(o.chat_id).get(o.message_id) || { replyTo: null };
      bubbleOf(o.chat_id).set(o.message_id, { kb: clone(kbOf(o.reply_markup)), replyTo: prev.replyTo });
    }
  } else if (method === 'editMessageReplyMarkup') {
    const o = args[1] || {};
    if (o.message_id) {
      const prev = bubbleOf(o.chat_id).get(o.message_id) || { replyTo: null };
      bubbleOf(o.chat_id).set(o.message_id, { kb: clone(kbOf(args[0])), replyTo: prev.replyTo });
    }
  } else if (method === 'deleteMessage') {
    bubbleOf(args[0]).delete(args[1]);
  }
}
for (const key of Object.keys(base)) {
  if (typeof base[key] !== 'function') { bot[key] = base[key]; continue; }
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
const settle = () => new Promise((r) => setImmediate(r));
async function types(key, uid, text, label) {
  STEP = { key, label, actor: CAST[uid] };
  userMsgId += 1;
  await controller.handleMessage(bot, {
    message_id: userMsgId, date: Math.floor(Date.now() / 1000),
    chat: { id: uid, type: 'private' }, from: { id: uid, first_name: CAST[uid] }, text,
  });
  await settle();
}
/** The newest bubble in a person's chat that shows a button with exactly this TEXT. */
function findButton(uid, text) {
  const hits = [];
  const ok = (t) => (text instanceof RegExp ? text.test(t) : t === text);
  for (const [id, b] of bubbleOf(uid).entries()) {
    for (const btn of b.kb.flat()) if (ok(btn.text)) hits.push({ id, data: btn.callback_data, text: btn.text });
  }
  if (!hits.length) throw new Error(`no bubble in ${CAST[uid]}'s chat shows a button "${text}"`);
  return hits.sort((x, y) => y.id - x.id)[0];
}
function tapUpdate(uid, data, messageId) {
  updateN += 1;
  const id = `cbq-${updateN}`;
  CB_ACTOR[id] = CAST[uid];
  const here = bubbleOf(uid).get(messageId) || { kb: [], replyTo: null };
  const message = { message_id: messageId, chat: { id: uid, type: 'private' }, reply_markup: { inline_keyboard: clone(here.kb) } };
  if (here.replyTo) {
    const parent = bubbleOf(uid).get(here.replyTo);
    message.reply_to_message = {
      message_id: here.replyTo, chat: { id: uid, type: 'private' },
      ...(parent ? { reply_markup: { inline_keyboard: clone(parent.kb) } } : {}),
    };
  }
  return { id, data, from: { id: uid, first_name: CAST[uid] }, message };
}
/** A person taps the button with this TEXT — it must be on screen in their chat. */
async function taps(key, uid, text, label) {
  const hit = findButton(uid, text);
  STEP = { key, label: label || `${CAST[uid]} taps ${hit.text}`, actor: CAST[uid] };
  await controller.handleCallbackQuery(bot, tapUpdate(uid, hit.data, hit.id));
  await settle();
}
/** The bot's own timer (server.js runs approvalReminder.sweep every hour). */
async function timer(key, label) {
  STEP = { key, label, actor: 'Bot' };
  await approvalReminder.sweep(bot);
  await settle();
}
const queueRows = () => fake._store.get('ApprovalQueue').slice(1);
const jsonOf = (r) => JSON.parse(r[2]);
const sentIn = (stepKey, uid) => LOG.filter((e) => e.stepKey === stepKey && e.method === 'sendMessage' && String(e.args[0]) === String(uid));
const FACTS = {};
const ledgerBalance = () => fake._store.get('Ledger_Entries').slice(1)
  .filter((r) => String(r[3]) === '1100' && r[10] === ABBA_ID)
  .reduce((s, r) => s + Number(r[5] || 0) - Number(r[6] || 0), 0);

/* ── 7. the scenes ──────────────────────────────────────────────────────── */
async function sceneA() {
  at('10:20:00');
  await types('a_bal0', KRISHNA, 'Balance ABBA', 'Krishna types: Balance ABBA (before)');
  FACTS.ledger_balance_before = ledgerBalance();
  at('10:21:00');
  await types('a_menu', ABDUL, 'menu', 'Abdul types: menu');
  await taps('a_fin', ABDUL, '💰 Finance');
  await taps('a_open', ABDUL, '💵 Payment Received');
  await taps('a_pick', ABDUL, '👤 ABBA');
  await types('a_amount', ABDUL, '50000', 'Abdul types: 50000');
  await taps('a_bank', ABDUL, '🏦 Zenith');
  await taps('a_ask', ABDUL, '🛂 Musa');
  at('10:22:00');
  await taps('a_submit', ABDUL, '✅ Submit for approval');
  if (queueRows().length !== 1) throw new Error('scene A: expected one request');
  const REQ = String(queueRows()[0][0]);
  FACTS.request = REQ;
  FACTS.krishna_messages_at_submit = sentIn('a_submit', KRISHNA).length;
  FACTS.musa_messages_at_submit = sentIn('a_submit', MUSA).length;

  at('10:25:00');
  await types('a_kmenu', KRISHNA, 'menu', 'Krishna types: menu');
  await taps('a_more', KRISHNA, /^📋 More Options/);
  await taps('a_inbox', KRISHNA, /^🛂 Approvals/);
  const cat = findCategory(KRISHNA);
  await taps('a_cat', KRISHNA, cat);
  await tapRow('a_item', KRISHNA, REQ);

  at('10:30:00');
  await taps('a_mok', MUSA, '✅ Approve', 'Musa taps ✅ Approve on his card');
  FACTS.after_musa = { approvals: jsonOf(queueRows()[0]).approvals, status: queueRows()[0][4], ledger_balance: ledgerBalance() };

  at('10:40:00');
  await taps('a_kok', KRISHNA, '✅ Approve', 'Krishna taps ✅ Approve on the card he received');
  FACTS.after_krishna = { status: queueRows()[0][4], ledger_balance: ledgerBalance(), customers_cell: fake._store.get('Customers')[1][6] };
  at('10:45:00');
  await types('a_bal1', KRISHNA, 'Balance ABBA', 'Krishna types: Balance ABBA (after)');
}

/** The 🛂 Approvals category button that holds the payment received. */
function findCategory(uid) {
  const b = [...bubbleOf(uid).values()].pop();
  const all = [...bubbleOf(uid).entries()].sort((x, y) => y[0] - x[0])[0][1].kb.flat();
  const hit = all.find((x) => /Payment/i.test(x.text) && !/^🏠/.test(x.text)) || all.find((x) => /Finance|💵/.test(x.text));
  if (!hit) throw new Error(`no payment category on the inbox: ${all.map((x) => x.text).join(' | ')} ${!!b}`);
  return hit.text;
}
/** Tap the inbox row of this request (the row whose button names its ref or customer). */
async function tapRow(key, uid, req) {
  const ref = `R-${req.slice(0, 4).toUpperCase()}`;
  const newest = [...bubbleOf(uid).entries()].sort((x, y) => y[0] - x[0])[0];
  const btns = newest[1].kb.flat();
  const hit = btns.find((x) => x.text.includes(ref)) || btns.find((x) => /ABBA/.test(x.text)) || btns.find((x) => /^abx:i:/.test(x.callback_data));
  if (!hit) throw new Error(`no inbox row for ${req}: ${btns.map((x) => x.text).join(' | ')}`);
  STEP = { key, label: `${CAST[uid]} taps the row ${hit.text}`, actor: CAST[uid] };
  await controller.handleCallbackQuery(bot, tapUpdate(uid, hit.callback_data, newest[0]));
  await settle();
}

async function sceneB() {
  at('11:00:00');
  await types('b_menu', ABDUL, 'menu', 'Abdul types: menu');
  await taps('b_fin', ABDUL, '💰 Finance');
  await taps('b_open', ABDUL, '💵 Payment Received');
  await taps('b_pick', ABDUL, '👤 ABBA');
  await taps('b_noamt', ABDUL, '⏭ Amount not known');
  await taps('b_bank', ABDUL, '🏦 Zenith');
  await taps('b_ask', ABDUL, '🛂 Musa');
  at('11:01:00');
  await taps('b_submit', ABDUL, '✅ Submit for approval');
  const REQ = String(queueRows()[0][0]);
  FACTS.request = REQ;
  FACTS.krishna_messages_at_submit = sentIn('b_submit', KRISHNA).length;
  at('11:10:00');
  await taps('b_mok', MUSA, '✅ Approve', 'Musa taps ✅ Approve on his card');
  FACTS.after_musa_first_tap = { approvals: jsonOf(queueRows()[0]).approvals || [], amount: jsonOf(queueRows()[0]).amount };
  at('11:11:00');
  await types('b_bad', MUSA, 'abc', 'Musa types: abc');
  await types('b_amt', MUSA, '50000', 'Musa types: 50000');
  at('11:12:00');
  await taps('b_ay', MUSA, '✅ Approve with 50,000');
  FACTS.after_musa = { approvals: jsonOf(queueRows()[0]).approvals, amount: jsonOf(queueRows()[0]).amount, amountBy: jsonOf(queueRows()[0]).amountBy, status: queueRows()[0][4] };
  at('11:20:00');
  await taps('b_kok', KRISHNA, '✅ Approve', 'Krishna taps ✅ Approve on the card he received');
  FACTS.after_krishna_first_tap = { status: queueRows()[0][4], approvals: jsonOf(queueRows()[0]).approvals };
  at('11:21:00');
  await taps('b_kok2', KRISHNA, '✅ Approve 50,000');
  FACTS.after_krishna = { status: queueRows()[0][4], ledger_balance: ledgerBalance() };
}

async function sceneC() {
  at('10:00:00');
  await types('c_menu', ABDUL, 'menu', 'Abdul types: menu');
  await taps('c_fin', ABDUL, '💰 Finance');
  await taps('c_open', ABDUL, '💵 Payment Received');
  await taps('c_pick', ABDUL, '👤 ABBA');
  await types('c_amount', ABDUL, '50000', 'Abdul types: 50000');
  await taps('c_bank', ABDUL, '🏦 Zenith');
  await taps('c_ask', ABDUL, '🛂 Musa');
  await taps('c_submit', ABDUL, '✅ Submit for approval');
  const REQ = String(queueRows()[0][0]);
  FACTS.request = REQ;
  at('11:00:00');
  await timer('c_rem1', 'The bot\'s reminder timer runs (1 hour after the request)');
  FACTS.reminder_1 = { musa: sentIn('c_rem1', MUSA).length, krishna: sentIn('c_rem1', KRISHNA).length, abdul: sentIn('c_rem1', ABDUL).length };
  at('11:10:00');
  await taps('c_nudge', ABDUL, '🔔 Remind approvers');
  FACTS.nudge = { musa: sentIn('c_nudge', MUSA).length, krishna: sentIn('c_nudge', KRISHNA).length };
  // The timer runs every hour: it checks the asked admin's wait every time
  // (the widen card, PRC-2b) and re-sends reminders every
  // APPROVAL_REMINDER_HOURS (6). Each hour is run, so the guide shows when
  // each really arrives.
  const hourly = [];
  for (const h of [12, 13, 14, 15, 16, 17]) {
    at(`${h}:00:00`);
    await timer(`c_hour${h}`, `The bot's reminder timer runs at ${h}:00`);
    hourly.push({ at: `${h}:00`, musa: sentIn(`c_hour${h}`, MUSA).length, krishna: sentIn(`c_hour${h}`, KRISHNA).length });
  }
  FACTS.hourly_timer = hourly;
  at('17:10:00');
  await types('c_kmenu', KRISHNA, 'menu', 'Krishna types: menu');
  await taps('c_more', KRISHNA, /^📋 More Options/);
  await taps('c_inbox', KRISHNA, /^🛂 Approvals/);
  await taps('c_cat', KRISHNA, findCategory(KRISHNA));
  await tapRow('c_item', KRISHNA, REQ);
  at('17:11:00');
  await taps('c_kok', KRISHNA, '✅ Approve', 'Krishna taps ✅ Approve on the 🛂 Approvals card');
  FACTS.after_krishna = { approvals: jsonOf(queueRows()[0]).approvals, status: queueRows()[0][4] };
}

async function sceneD() {
  at('12:00:00');
  await types('d_menu', ABDUL, 'menu', 'Abdul types: menu');
  await taps('d_fin', ABDUL, '💰 Finance');
  await taps('d_open', ABDUL, '💵 Payment Received');
  await taps('d_pick', ABDUL, '👤 ABBA');
  await types('d_amount', ABDUL, '50000', 'Abdul types: 50000');
  await taps('d_bank', ABDUL, '🏦 Zenith');
  await taps('d_ask', ABDUL, '👥 Any admin');
  await taps('d_submit', ABDUL, '✅ Submit for approval');
  FACTS.request = String(queueRows()[0][0]);
  FACTS.asked_admin_on_row = jsonOf(queueRows()[0]).askedAdmin || null;
}

/* ── 8. the log → cards ─────────────────────────────────────────────────── */
const KIND = {
  sendMessage: 'message', editMessageText: 'edit', editMessageCaption: 'edit', editMessageReplyMarkup: 'edit',
  editMessageMedia: 'edit', answerCallbackQuery: 'popup', sendPhoto: 'photo', sendMediaGroup: 'photo',
  sendDocument: 'document', deleteMessage: 'delete', sendChatAction: 'chat_action', getFile: 'get_file',
};
const who = (chatId) => CAST[String(chatId)] || `chat ${chatId}`;
function toCard(e, i) {
  const a = e.args;
  const card = { n: i + 1, stepKey: e.stepKey, step: e.step, actor: e.actor, recipient: '', kind: KIND[e.method] || e.method, method: e.method, text: '', parse_mode: null, clock_lagos: `16-Nov-2026 ${e.lagos}` };
  let opts = null;
  let kb = null;
  if (e.method === 'sendMessage') {
    card.recipient = who(a[0]); card.text = a[1]; opts = a[2] || {};
    card.message_id = e.result && e.result.message_id;
    card.reply_to = opts.reply_to_message_id || null;
  } else if (e.method === 'editMessageText' || e.method === 'editMessageCaption') {
    opts = a[1] || {}; card.recipient = who(opts.chat_id); card.text = a[0]; card.edits_message_id = opts.message_id;
  } else if (e.method === 'editMessageReplyMarkup') {
    opts = a[1] || {}; card.recipient = who(opts.chat_id); card.edits_message_id = opts.message_id;
    kb = kbOf(a[0]);
    card.keyboard_only = true;
  } else if (e.method === 'answerCallbackQuery') {
    const o = a[1] || {};
    card.recipient = CB_ACTOR[a[0]] || e.actor;
    card.text = o.text || '';
    card.alert = !!o.show_alert;
    card.silent = !o.text;
  } else if (e.method === 'deleteMessage') {
    card.recipient = who(a[0]); card.deletes_message_id = a[1];
  } else {
    card.recipient = who(a[0]);
  }
  if (opts) {
    card.parse_mode = opts.parse_mode || null;
    if (kb == null) kb = kbOf(opts.reply_markup);
  }
  card.buttons = (kb || []).map((row) => row.map((b) => b.text));
  card.callbacks = (kb || []).map((row) => row.map((b) => b.callback_data));
  return card;
}
/** What a person actually sees: no silent pop-ups, deletes, chat actions, or a button strip that is redrawn in the same step. */
function visible(all) {
  return all.filter((c, i) => {
    if (c.kind === 'popup') return !c.silent;
    if (['delete', 'chat_action', 'get_file'].includes(c.kind)) return false;
    if (c.keyboard_only) {
      return !all.slice(i + 1).some((d) => d.stepKey === c.stepKey && !d.keyboard_only && d.edits_message_id === c.edits_message_id && d.recipient === c.recipient);
    }
    return true;
  });
}

const MAIN = { A: sceneA, B: sceneB, C: sceneC, D: sceneD }[SCENE];
MAIN().then(() => {
  const all = LOG.map(toCard);
  const out = {
    scene: SCENE,
    clock: '16-Nov-2026, Lagos wall clock (UTC+1); global Date replaced by a subclass set before each step',
    cast: CAST,
    admin_ids: process.env.ADMIN_IDS,
    employee_ids: process.env.EMPLOYEE_IDS,
    settings_bank_list: BANK_LIST,
    operations_allowed_activities: OPERATIONS_ACTIVITIES,
    facts: FACTS,
    cards: visible(all),
    all_calls: all,
    approval_queue_after: fake._store.get('ApprovalQueue'),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`, () => process.exit(0));
}).catch((e) => {
  process.stderr.write(`CAPTURE FAILED (scene ${SCENE}): ${e && e.stack ? e.stack : e}\n`);
  for (const [chat, m] of SCREEN.entries()) {
    for (const [id, b] of m.entries()) process.stderr.write(`  ${who(chat)} #${id}: ${b.kb.flat().map((x) => x.text).join(' | ')}\n`);
  }
  for (const c of LOG.slice(-6).map(toCard)) process.stderr.write(`  last: ${c.kind} → ${c.recipient}: ${String(c.text).slice(0, 300)}\n`);
  process.exit(1);
});
