'use strict';

/**
 * RET-7 GUIDE — the screens of "type a return one way", captured from the
 * bot's REAL code.
 *
 * Run (from telegram-ops-bot/; BOT_ROOT = the bot folder, default the folder
 * two levels above this script):
 *   node scripts/ret7-capture/capture.js > ret7.json
 *
 * Scenes (one process, one workbook, in this order; the session is cleared
 * between scenes, as a fresh typed line does):
 *   one    Abdul types the one line `Return 631/1+2+3+4+5, 614/1` and walks
 *          the whole return: ✅ Continue → 📅 Today → ✅ Good → ⏭ Skip photo
 *          → the confirm card → ✅ Submit for approval → his receipt.
 *   old    His three lines of 20-Nov (words around the numbers) → the
 *          one-way card each.
 *   whole  `Return 614` → the card.
 *   wrong  `Return 631-635` → the card with ❓ Could not read.
 *   add    `Return 631/1+2+3+4+5`, then he types `614/1` (added) and then
 *          `700 to Idumota` (refused: ❓ Numbers only here).
 *   cancel The one line again, up to the confirm card, then ❌ Cancel —
 *          what the test sheet asks him to do (nothing is submitted).
 *
 * Prints ONE JSON document on stdout. Every log line goes to stderr.
 *
 * What is real: the controller (handleMessage / handleCallbackQuery), the
 * typed-line reader (thanListParser), the return flow, the approval gate,
 * approvalEvents, every repository, the navigation guard.
 * What is faked: the Sheets client (in-memory rows — the project's own
 * test/helpers/fakeSheets), the Telegram bot (the project's own recording
 * test/helpers/fakeBot, wrapped so a tap can only land on a button that is
 * really on screen), the intent parser (it must never be reached — counted),
 * the clock (20-Nov-2026, Lagos) and the random ids. Nothing in the
 * repository is written.
 */

/* ── 0. stdout is for the JSON only ─────────────────────────────────────── */
const util = require('util');
const toErr = (...a) => { process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : util.inspect(x, { depth: 3 }))).join(' ')}\n`); };
console.log = toErr; console.info = toErr; console.warn = toErr; console.error = toErr; console.debug = toErr;

/* ── 1. fixed clock: 20-Nov-2026, Lagos wall clock (UTC+1, no DST) ──────── */
const RealDate = Date;
let NOW = RealDate.UTC(2026, 10, 20, 9, 0, 0);
class FixedDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
}
global.Date = FixedDate;
let LAGOS = '10:00:00';
/** Set the clock to HH:MM:SS Lagos time on 20-Nov-2026. */
function at(hms) {
  const [h, m, s] = String(hms).split(':').map(Number);
  NOW = RealDate.UTC(2026, 10, 20, h - 1, m, s || 0);
  LAGOS = hms;
}

/* ── 2. deterministic ids ───────────────────────────────────────────────── */
const crypto = require('crypto');
const FIXED_UUIDS = ['7e3a9c51-2b4d-4f86-a1c0-5d9e8b7f6a24'];
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
const ABDUL = '555';
const KRISHNA = '777';
const MUSA = '888';
const CAST = { [ABDUL]: 'Abdul', [KRISHNA]: 'Krishna', [MUSA]: 'Musa' };
process.env.ADMIN_IDS = `${KRISHNA},${MUSA}`;
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
function invRow(pkg, than, status, soldTo, wh, design, shade, rate) {
  return [pkg, '', '', design, shade, String(than), '30', status, wh, String(rate), '2026-07-01',
    soldTo, soldTo ? '2026-11-12' : '', '', '', '', 'fabric', `UID-${pkg}-${than}`, '2026-07-01', '', '', 'Jul26', ''];
}
const INVENTORY = [
  INV_HEADERS,
  // Soldier Madam bought bale 631 thans 1–5 and bale 614 than 1, from IDUMOTA.
  ...[1, 2, 3, 4, 5].map((t) => invRow('631', t, 'sold', 'Soldier Madam', 'IDUMOTA', '9043-B', '4', 1500)),
  invRow('631', 6, 'available', '', 'IDUMOTA', '9043-B', '4', 1500),
  invRow('614', 1, 'sold', 'Soldier Madam', 'IDUMOTA', '9043-A', '7', 1500),
  invRow('614', 2, 'available', '', 'IDUMOTA', '9043-A', '7', 1500),
  // Two bales sold to someone else, for the mistakes.
  invRow('700', 1, 'sold', 'ABBA', 'Lagos', '9006', '1', 1000),
  invRow('635', 1, 'sold', 'ABBA', 'Lagos', '9006', '1', 1000),
];
const fake = createFakeSheets({
  Users: [
    ['user_id', 'name', 'role', 'branch', 'access_level', 'status', 'created_at', 'department', 'warehouses', 'manages', 'notification_prefs', 'store_sales_places'],
    [ABDUL, 'Abdul', 'employee', 'Lagos', 'branch_only', 'active', SEEDED, 'Operations', 'Lagos,IDUMOTA', '', '', ''],
    [KRISHNA, 'Krishna', 'admin', '', 'all', 'active', SEEDED, 'Admin', '', '', '', ''],
    [MUSA, 'Musa', 'admin', '', 'all', 'active', SEEDED, 'Admin', '', '', '', ''],
  ],
  Settings: [['Key', 'Value', 'UpdatedAt']],
  Inventory: INVENTORY,
  Customers: [
    ['customer_id', 'name', 'phone', 'address', 'category', 'credit_limit', 'outstanding_balance', 'payment_terms', 'notes', 'status', 'created_at', 'updated_at', 'aliases', 'stores', 'first_sale_at'],
    ['CUS-S', 'Soldier Madam', '08030000011', 'Idumota, Lagos', 'Wholesale', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'IDUMOTA', '2026-11-12'],
    ['CUS-A', 'ABBA', '08030000001', 'Lagos', 'Wholesale', 0, 0, '', '', 'Active', SEEDED, SEEDED, '', 'Lagos', '2026-07-14'],
  ],
  ApprovalQueue: [
    ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'],
  ],
});
installFakeSheets(fake);
let intentCalls = 0;
installFakeIntent(() => { intentCalls += 1; return { action: 'unknown', confidence: 0 }; });
require(path.join(SRC, 'utils/typedRouter')).forceMode(null); // production default: no AI for typed text
const controller = loadController();
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

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
const FACTS = {};
const newScene = () => { sessionStore.clear(ABDUL); SCREEN.clear(); };
const invStatus = () => fake._store.get('Inventory').slice(1).map((r) => `${r[0]}/${r[5]}:${r[7]}`).join(' ');

/* ── 7. the scenes ──────────────────────────────────────────────────────── */
async function sceneOne() {
  newScene();
  at('10:00:00');
  const before = invStatus();
  await types('one_line', ABDUL, 'Return 631/1+2+3+4+5, 614/1');
  await taps('one_go', ABDUL, '✅ Continue — date, condition, photo');
  await taps('one_date', ABDUL, /^📅 Today/);
  await taps('one_cond', ABDUL, '✅ Good — back to stock');
  await taps('one_photo', ABDUL, '⏭ Skip photo');
  at('10:02:00');
  await taps('one_submit', ABDUL, '✅ Submit for approval');
  FACTS.one = {
    requests: queueRows().length,
    status: queueRows()[0] && queueRows()[0][4],
    action: queueRows()[0] && JSON.parse(queueRows()[0][2]).action,
    stock_unchanged_by_submit: invStatus() === before,
    admin_cards: LOG.filter((e) => e.stepKey === 'one_submit' && e.method === 'sendMessage' && [KRISHNA, MUSA].includes(String(e.args[0]))).length,
  };
}

const OLD_LINES = [
  'Return 631/1+2+3+4+5,614/1 to Idumota',
  'Return package 631/1+2+3+4+5,614/1 to Idumota',
  'Return package from soldier madam 631/1+2+3+4+5,614/1 to Idumota',
];
async function sceneOld() {
  FACTS.old = [];
  for (let i = 0; i < OLD_LINES.length; i += 1) {
    newScene();
    at(`10:1${i}:00`);
    const before = intentCalls;
    await types(`old_${i + 1}`, ABDUL, OLD_LINES[i]);
    FACTS.old.push({ line: OLD_LINES[i], ai_asked: intentCalls - before, card_opened: !!sessionStore.get(ABDUL) });
  }
}

async function sceneWhole() {
  newScene();
  at('10:20:00');
  await types('whole', ABDUL, 'Return 614');
}

async function sceneWrong() {
  newScene();
  at('10:25:00');
  await types('wrong', ABDUL, 'Return 631-635');
}

async function sceneAdd() {
  newScene();
  at('10:30:00');
  await types('add_open', ABDUL, 'Return 631/1+2+3+4+5');
  await types('add_ok', ABDUL, '614/1');
  await types('add_bad', ABDUL, '700 to Idumota');
  const s = sessionStore.get(ABDUL);
  FACTS.add = { bales_after: s ? s.bales.map((b) => b.packageNo) : null };
}

async function sceneCancel() {
  newScene();
  at('10:40:00');
  const before = queueRows().length;
  await types('cx_line', ABDUL, 'Return 631/1+2+3+4+5, 614/1');
  await taps('cx_go', ABDUL, '✅ Continue — date, condition, photo');
  await taps('cx_date', ABDUL, /^📅 Today/);
  await taps('cx_cond', ABDUL, '✅ Good — back to stock');
  await taps('cx_photo', ABDUL, '⏭ Skip photo');
  await taps('cx_cancel', ABDUL, '❌ Cancel');
  FACTS.cancel = { new_requests: queueRows().length - before, session_left: !!sessionStore.get(ABDUL) };
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
  const card = { n: i + 1, stepKey: e.stepKey, step: e.step, actor: e.actor, recipient: '', kind: KIND[e.method] || e.method, method: e.method, text: '', parse_mode: null, clock_lagos: `20-Nov-2026 ${e.lagos}` };
  let opts = null;
  let kb = null;
  if (e.method === 'sendMessage') {
    card.recipient = who(a[0]); card.text = a[1]; opts = a[2] || {};
    card.message_id = e.result && e.result.message_id;
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
  await sceneOne();
  await sceneOld();
  await sceneWhole();
  await sceneWrong();
  await sceneAdd();
  await sceneCancel();
})().then(() => {
  FACTS.ai_asked_total = intentCalls;
  const all = LOG.map(toCard);
  const out = {
    clock: '20-Nov-2026, Lagos wall clock (UTC+1); global Date replaced by a subclass set before each step',
    cast: CAST,
    admin_ids: process.env.ADMIN_IDS,
    employee_ids: process.env.EMPLOYEE_IDS,
    old_lines: OLD_LINES,
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
  for (const c of LOG.slice(-6).map(toCard)) process.stderr.write(`  last: ${c.kind} → ${c.recipient}: ${String(c.text).slice(0, 300)}\n`);
  process.exit(1);
});
