'use strict';

/**
 * RET-8 GUIDES — the screens of "a return whose sale has no rate", captured
 * from the bot's REAL code, for the two test sheets
 * (docs/RET-8_TEST_ABDUL.pdf and docs/RET-8_TEST_ADMINS.pdf).
 *
 * Run (from telegram-ops-bot/; BOT_ROOT = the bot folder, default the folder
 * two levels above this script):
 *   node scripts/ret8-capture/capture.js > ret8.json
 *
 * The fixture mirrors the owner's case of 20-Nov-2026: store IDUMOTA, buyer
 * "solder madam" (outstanding 500,000), design 44200 shade BLACK; bale 631 =
 * five thans of 30 yd, all sold to her on 02-Nov-2026 with NO rate; bale 614
 * = three thans, 614/1 sold to her with NO rate, 614/2 and 614/3 in stock;
 * bale 700 = two thans sold to ABBA at 1,000/yd (a return with a rate). The
 * rate she last paid for 44200 is 1,450.
 *
 * Scenes (one process; the session is cleared between scenes):
 *   A  Abdul: `Return 631/1+2+3+4+5` → the card → ❌ Cancel.
 *   B  Abdul: `Return 614/1` → the card → ❌ Cancel.
 *   C  Abdul: `Return 631/1+2+3+4+5, 614/1` → Continue → Today → Good →
 *      Skip photo → the confirm card → Submit → his receipt.
 *   D  Musa: the approval message → ✅ Approve → types 0 → types 1,450 →
 *      ✅ Approve with this credit. Abdul: 🔏 Approval 1 of 2.
 *   E  Krishna: the card again → ✅ Approve → ✅ Approve · credit … ;
 *      Abdul: ✅ Approved · 2 of 2.
 *   F  A fresh workbook, the same return again; Musa: ⏭ No credit for these
 *      → approve; Krishna: ✅ Approve · no credit; Abdul's closing card.
 *   G  Abdul: `Return 700` (goods with a rate) → the confirm card → ❌ Cancel.
 *   H  Abdul (the workbook after E): 📨 My Requests → ✅ Approved → the
 *      return; then he types `631` → the bale card.
 *   I  Krishna types `Price 44200 BLACK 1500` → Musa's approval message (the
 *      new first lines on another kind of request).
 *
 * Prints ONE JSON document on stdout. Every log line goes to stderr.
 *
 * What is real: the controller, the typed-line reader, the return flow, the
 * rate step, the approval gate, approvalEvents, the executor, every
 * repository, the navigation guard. What is faked: the Sheets client
 * (in-memory rows — test/helpers/fakeSheets), the Telegram bot (the
 * recording test/helpers/fakeBot, wrapped so a tap can only land on a button
 * that is really on screen), the intent parser (never reached — counted),
 * the customer ledger (outstanding 500,000; each credit is recorded, not
 * posted), the "last paid" lookup (1,450), the clock (21-Nov-2026, Lagos)
 * and the random ids. Nothing in the repository is written.
 */

/* ── 0. stdout is for the JSON only ─────────────────────────────────────── */
const util = require('util');
const toErr = (...a) => { process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 3 }))).join(' ')}\n`); };
console.log = toErr; console.info = toErr; console.warn = toErr; console.error = toErr; console.debug = toErr;

/* ── 1. fixed clock: 21-Nov-2026, Lagos wall clock (UTC+1, no DST) ──────── */
const RealDate = Date;
let NOW = RealDate.UTC(2026, 10, 21, 9, 0, 0);
class FixedDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
}
global.Date = FixedDate;
let LAGOS = '10:00:00';
/** Set the clock to HH:MM:SS Lagos time on 21-Nov-2026. */
function at(hms) {
  const [h, m, s] = String(hms).split(':').map(Number);
  NOW = RealDate.UTC(2026, 10, 21, h - 1, m, s || 0);
  LAGOS = hms;
}

/* ── 2. deterministic ids (no short reference is R-C677, the owner's real one) */
const crypto = require('crypto');
let uuidN = 0;
const UUID_HEADS = ['4b2e7f10', '9d51a3c8', 'a7f3e290', '5c8b1d47', 'e06f9b32', '3a9d7c15'];
crypto.randomUUID = () => {
  const head = UUID_HEADS[uuidN] || `0000${String(uuidN).padStart(4, '0')}`;
  const u = `${head}-2b4d-4f86-a1c0-${String(uuidN).padStart(12, '0')}`;
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
const ABDUL = '555';
const MUSA = '888';
const KRISHNA = '777';
const CAST = { [ABDUL]: 'Abdul', [KRISHNA]: 'Krishna', [MUSA]: 'Musa' };
process.env.ADMIN_IDS = `${MUSA},${KRISHNA}`;
process.env.EMPLOYEE_IDS = ABDUL;
for (const k of ['FINANCE_IDS', 'SUPER_ADMIN_IDS', 'ANALYTICS_ENABLED', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'TELEGRAM_TOKEN', 'GOOGLE_CREDENTIALS_JSON', 'GOOGLE_CREDENTIALS_PATH', 'GOOGLE_SHEET_ID', 'DATABASE_URL']) delete process.env[k];

const path = require('path');
const REPO = process.env.BOT_ROOT || path.resolve(__dirname, '..', '..');
const { createFakeBot } = require(path.join(REPO, 'test/helpers/fakeBot'));
const { createFakeSheets } = require(path.join(REPO, 'test/helpers/fakeSheets'));
const { installFakeSheets, installFakeIntent, loadController, SRC } = require(path.join(REPO, 'test/helpers/controllerHarness'));

/* ── 4. the workbook, as rows ───────────────────────────────────────────── */
const SEEDED = '2026-07-01T08:00:00.000Z';
const INV_HEADERS = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
function invRow(pkg, than, status, soldTo, design, shade, rate) {
  return [pkg, '', '', design, shade, String(than), '30', status, 'IDUMOTA', rate === '' ? '' : String(rate), '2026-07-01',
    soldTo, soldTo ? '2026-11-02' : '', '', '', '', 'fabric', `UID-${pkg}-${than}`, '2026-07-01', '', '', 'Jul26', ''];
}
const INVENTORY = [
  INV_HEADERS,
  // solder madam bought bale 631 (all five thans) and 614/1 on 02-Nov-2026 — NO rate on the sale.
  ...[1, 2, 3, 4, 5].map((t) => invRow('631', t, 'sold', 'solder madam', '44200', 'BLACK', '')),
  invRow('614', 1, 'sold', 'solder madam', '44200', 'BLACK', 0),
  invRow('614', 2, 'available', '', '44200', 'BLACK', ''),
  invRow('614', 3, 'available', '', '44200', 'BLACK', ''),
  // ABBA bought bale 700 WITH a rate (the "nothing new" case).
  invRow('700', 1, 'sold', 'ABBA', '9006', '1', 1000),
  invRow('700', 2, 'sold', 'ABBA', '9006', '1', 1000),
];
const QUEUE_HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'];
const fake = createFakeSheets({
  Users: [
    ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs', 'store_sales_places'],
    [ABDUL, 'Abdul', 'employee', 'Lagos', 'branch_only', 'active', SEEDED, 'Operations', 'Lagos,IDUMOTA', '', '', ''],
    [MUSA, 'Musa', 'admin', '', 'all', 'active', SEEDED, 'Admin', '', '', '', ''],
    [KRISHNA, 'Krishna', 'admin', '', 'all', 'active', SEEDED, 'Admin', '', '', '', ''],
  ],
  Settings: [['Key', 'Value', 'UpdatedAt']],
  Inventory: INVENTORY.map((r) => r.slice()),
  Customers: [
    ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases', 'stores', 'first_sale_at'],
    ['CUS-S', 'solder madam', '08030000011', 'Idumota, Lagos', 'Wholesale', 0, 500000, '', '', 'Active', SEEDED, SEEDED, '', 'IDUMOTA', '2026-11-02'],
    ['CUS-A', 'ABBA', '08030000001', 'Lagos', 'Wholesale', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'IDUMOTA', '2026-07-14'],
  ],
  ApprovalQueue: [QUEUE_HEADERS],
});
installFakeSheets(fake);
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return { action: 'unknown', confidence: 0 }; });
require(path.join(SRC, 'utils/typedRouter')).forceMode(null); // production default: no AI for typed text
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const approvalGate = require(path.join(SRC, 'services/approvalGate'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));

// The ledger: outstanding 500,000 for every buyer; a credit is recorded here, not posted.
const CREDITS = [];
accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 500000 });
accountingService.recordReturn = async (data) => { CREDITS.push({ customer: data.customer, yards: data.yards, rate: data.pricePerYard }); };
// The rate she last paid for 44200 (the sale wizard's Step 2 lookup).
approvalEvents.getLastPaidRate = async () => 1450;

/* ── 5. the recording bot ───────────────────────────────────────────────── */
const base = createFakeBot();
const LOG = [];
let STEP = { key: '', label: '', actor: '' };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const bot = {};
const SCREEN = new Map();
const bubbleOf = (chat) => { const k = String(chat); if (!SCREEN.has(k)) SCREEN.set(k, new Map()); return SCREEN.get(k); };
const kbOf = (rm) => ((rm && Array.isArray(rm.inline_keyboard)) ? rm.inline_keyboard : []);
function track(method, args, res) {
  if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument') {
    const o = args[2] || {};
    if (res && res.message_id) bubbleOf(args[0]).set(res.message_id, { kb: clone(kbOf(o.reply_markup)) });
  } else if (method === 'editMessageText' || method === 'editMessageCaption') {
    const o = args[1] || {};
    if (o.message_id) bubbleOf(o.chat_id).set(o.message_id, { kb: clone(kbOf(o.reply_markup)) });
  } else if (method === 'editMessageReplyMarkup') {
    const o = args[1] || {};
    if (o.message_id) bubbleOf(o.chat_id).set(o.message_id, { kb: clone(kbOf(args[0])) });
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
  STEP = { key, label: label || `${CAST[uid]} types: ${text}`, actor: CAST[uid] };
  userMsgId += 1;
  await controller.handleMessage(bot, {
    message_id: userMsgId, date: Math.floor(Date.now() / 1000),
    chat: { id: uid, type: 'private' }, from: { id: uid, first_name: CAST[uid] }, text,
  });
  await settle();
}
function findButton(uid, text) {
  const hits = [];
  const ok = (t) => (text instanceof RegExp ? text.test(t) : t === text);
  for (const [id, b] of bubbleOf(uid).entries()) {
    for (const btn of b.kb.flat()) if (ok(btn.text)) hits.push({ id, data: btn.callback_data, text: btn.text });
  }
  if (!hits.length) throw new Error(`no bubble in ${CAST[uid]}'s chat shows a button "${text}"`);
  return hits.sort((x, y) => y.id - x.id)[0];
}
async function taps(key, uid, text, label) {
  const hit = findButton(uid, text);
  STEP = { key, label: label || `${CAST[uid]} taps ${hit.text}`, actor: CAST[uid] };
  updateN += 1;
  const id = `cbq-${updateN}`;
  CB_ACTOR[id] = CAST[uid];
  const here = bubbleOf(uid).get(hit.id) || { kb: [] };
  await controller.handleCallbackQuery(bot, {
    id, data: hit.data, from: { id: uid, first_name: CAST[uid] },
    message: { message_id: hit.id, chat: { id: uid, type: 'private' }, reply_markup: { inline_keyboard: clone(here.kb) } },
  });
  await settle();
}
const queueRows = () => fake._store.get('ApprovalQueue').slice(1);
const ajOf = (row) => { try { return JSON.parse(row[2]); } catch (_) { return {}; } };
const FACTS = { refs: {} };
const newScene = () => { for (const id of Object.keys(CAST)) sessionStore.clear(id); SCREEN.clear(); };
const invStatus = () => fake._store.get('Inventory').slice(1).map((r) => `${r[0]}/${r[5]}:${r[7]}`).join(' ');
function freshWorkbook() {
  fake._store.set('Inventory', INVENTORY.map((r) => r.slice()));
  fake._store.set('ApprovalQueue', [[...QUEUE_HEADERS]]);
  fake._store.set('Transactions', []);
  if (approvalGate._internals && approvalGate._internals.recent) approvalGate._internals.recent.clear();
  CREDITS.length = 0;
}
async function walkToConfirm(prefix, uid) {
  await taps(`${prefix}_go`, uid, '✅ Continue — date, condition, photo');
  await taps(`${prefix}_date`, uid, /^📅 Today/);
  await taps(`${prefix}_cond`, uid, '✅ Good — back to stock');
  await taps(`${prefix}_photo`, uid, '⏭ Skip photo');
}

/* ── 7. the scenes ──────────────────────────────────────────────────────── */
async function sceneA() {
  newScene();
  at('09:30:00');
  const before = queueRows().length;
  await types('a_line', ABDUL, 'Return 631/1+2+3+4+5');
  await taps('a_cancel', ABDUL, '❌ Cancel');
  FACTS.a = { new_requests: queueRows().length - before };
}

async function sceneB() {
  newScene();
  at('09:35:00');
  const before = queueRows().length;
  await types('b_line', ABDUL, 'Return 614/1');
  await taps('b_cancel', ABDUL, '❌ Cancel');
  FACTS.b = { new_requests: queueRows().length - before };
}

async function sceneC() {
  newScene();
  at('10:00:00');
  const before = invStatus();
  await types('c_line', ABDUL, 'Return 631/1+2+3+4+5, 614/1');
  await walkToConfirm('c', ABDUL);
  at('10:02:00');
  await taps('c_submit', ABDUL, '✅ Submit for approval');
  const row = queueRows()[queueRows().length - 1];
  FACTS.c = {
    requests: queueRows().length,
    status: row && row[4],
    action: row && ajOf(row).action,
    stock_unchanged_by_submit: invStatus() === before,
  };
  FACTS.refs.main = approvalCards.shortRequestRef(row[0]);
}

async function sceneD() {
  SCREEN.delete(ABDUL);
  at('10:15:00');
  await taps('d_approve', MUSA, '✅ Approve');
  const row = () => queueRows()[queueRows().length - 1];
  FACTS.d = { signed_at_first_tap: (ajOf(row()).approvals || []).length };
  await types('d_zero', MUSA, '0');
  await types('d_rate', MUSA, '1,450');
  FACTS.d.signed_after_typing = (ajOf(row()).approvals || []).length;
  at('10:16:00');
  await taps('d_confirm', MUSA, '✅ Approve with this credit');
  const aj = ajOf(row());
  FACTS.d.signed_after_confirm = (aj.approvals || []).length;
  FACTS.d.rate_saved = (aj.rateFill || []).map((f) => f.rate);
  FACTS.d.status = row()[4];
}

async function sceneE() {
  at('10:40:00');
  await taps('e_approve', KRISHNA, '✅ Approve');
  const row = () => queueRows()[queueRows().length - 1];
  FACTS.e = { signed_before_chip: (ajOf(row()).approvals || []).length };
  at('10:41:00');
  await taps('e_confirm', KRISHNA, /^✅ Approve · credit /);
  FACTS.e.status = row()[4];
  FACTS.e.credits = CREDITS.slice();
  FACTS.e.inventory_after = invStatus();
}

async function sceneH() {
  newScene();
  at('11:00:00');
  await types('h_menu', ABDUL, '/menu');
  await taps('h_hub', ABDUL, '📋 Tasks & Planning');
  await taps('h_tile', ABDUL, '📨 My Requests');
  await taps('h_approved', ABDUL, /^✅ Approved/);
  await taps('h_open', ABDUL, /^1\b/);
  newScene();
  at('11:05:00');
  await types('h_bale', ABDUL, '631');
}

async function sceneF() {
  freshWorkbook();
  newScene();
  at('12:00:00');
  await types('f_line', ABDUL, 'Return 631/1+2+3+4+5, 614/1');
  await walkToConfirm('f', ABDUL);
  await taps('f_submit', ABDUL, '✅ Submit for approval');
  const row = () => queueRows()[queueRows().length - 1];
  FACTS.refs.nocredit = approvalCards.shortRequestRef(row()[0]);
  SCREEN.delete(ABDUL);
  at('12:10:00');
  await taps('f_approve', MUSA, '✅ Approve');
  await taps('f_nocredit', MUSA, '⏭ No credit for these');
  await taps('f_confirm', MUSA, '✅ Approve with no credit');
  at('12:20:00');
  await taps('f_k_approve', KRISHNA, '✅ Approve');
  await taps('f_k_confirm', KRISHNA, '✅ Approve · no credit');
  FACTS.f = { status: row()[4], credits: CREDITS.slice(), rate_saved: (ajOf(row()).rateFill || []).map((f) => (f.noCredit ? 'no credit' : f.rate)) };
}

async function sceneG() {
  newScene();
  at('13:00:00');
  const before = queueRows().length;
  await types('g_line', ABDUL, 'Return 700');
  await walkToConfirm('g', ABDUL);
  await taps('g_cancel', ABDUL, '❌ Cancel');
  FACTS.g = { new_requests: queueRows().length - before };
}

async function sceneI() {
  newScene();
  at('14:00:00');
  const before = queueRows().length;
  await types('i_price', KRISHNA, 'Price 44200 BLACK 1500');
  const row = queueRows()[queueRows().length - 1];
  FACTS.i = { new_requests: queueRows().length - before, action: row && ajOf(row).action };
  if (row) FACTS.refs.price = approvalCards.shortRequestRef(row[0]);
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
  const card = { n: i + 1, stepKey: e.stepKey, step: e.step, actor: e.actor, recipient: '', kind: KIND[e.method] || e.method, method: e.method, text: '', parse_mode: null, clock_lagos: `21-Nov-2026 ${e.lagos}` };
  let opts = null;
  let kb = null;
  if (e.method === 'sendMessage') {
    card.recipient = who(a[0]); card.text = a[1]; opts = a[2] || {};
    card.message_id = e.result && e.result.message_id;
    if (opts.reply_to_message_id) card.reply_to = opts.reply_to_message_id;
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

(async () => {
  await sceneA();
  await sceneB();
  await sceneC();
  await sceneD();
  await sceneE();
  await sceneH();
  await sceneF();
  await sceneG();
  await sceneI();
})().then(() => {
  FACTS.ai_asked_total = intentCalls;
  const all = LOG.map(toCard);
  const out = {
    clock: '21-Nov-2026, Lagos wall clock (UTC+1); global Date replaced by a subclass set before each step',
    cast: CAST,
    admin_ids: process.env.ADMIN_IDS,
    employee_ids: process.env.EMPLOYEE_IDS,
    facts: FACTS,
    cards: visible(all),
    all_calls: all,
    approval_queue_after: fake._store.get('ApprovalQueue'),
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`, () => process.exit(0));
}).catch((e) => {
  process.stderr.write(`CAPTURE FAILED: ${e && e.stack ? e.stack : e}\n`);
  for (const [chat, m] of SCREEN.entries()) {
    for (const [id, b] of m.entries()) process.stderr.write(`  ${who(chat)} #${id}: ${b.kb.flat().map((x) => x.text).join(' | ')}\n`);
  }
  for (const c of LOG.slice(-8).map(toCard)) process.stderr.write(`  last: ${c.kind} → ${c.recipient}: ${String(c.text).slice(0, 400)}\n`);
  process.exit(1);
});
