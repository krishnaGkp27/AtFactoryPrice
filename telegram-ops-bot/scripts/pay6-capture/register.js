'use strict';

/**
 * PAYMENT JOURNEY — segment "register"
 * Abdul registers his own bank account; Krishna and Musa approve it.
 *
 * Run (from telegram-ops-bot/; BOT_ROOT = the bot folder, default the folder
 * two levels above this script):
 *   node scripts/pay6-capture/register.js > register.json
 *
 * Prints ONE JSON document on stdout. Every log line goes to stderr.
 *
 * What is real: the controller (handleMessage / handleCallbackQuery), the
 * payment flow, the approval gate, approvalEvents, the executor, every
 * repository, the navigation guard. What is faked: the Sheets client
 * (in-memory rows — the project's own test/helpers/fakeSheets), the Telegram
 * bot (the project's own recording test/helpers/fakeBot), the intent parser
 * (never reached; the typed-text mode is put back to the production
 * default), the clock and the random ids (so two runs give the same bytes).
 * Nothing in the repository is written.
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
// idGenerator.requestId() is crypto.randomUUID(); the PAC-… account id takes
// four random bytes. Both are pinned so the request reads R-4F72 every run.
const crypto = require('crypto');
const FIXED_UUIDS = [
  '4f72c1d8-9a3e-4b6f-8c21-7d5e0a9b3c14',
  'b118e6a2-55cd-4f0e-9b7a-2c64d1f0a8e3',
  '77e8d0c4-1b2a-4c3d-8e9f-0a1b2c3d4e5f',
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
// The tiles on Abdul's greeting menu come from his department's row. The
// brief fixes the department NAME (Operations) but not its activity list;
// this is the list seeded here. 💳 Payments is injected for everyone by the
// controller and is NOT in the list; `payment_received` is, so the Finance
// hub holds two tiles and is drawn as a hub (a hub with one tile is promoted
// to a top-level tile instead).
const OPERATIONS_ACTIVITIES = [
  'supply_request', 'sell_bale', 'my_orders', 'check_stock', 'list_packages',
  'transfer_stock', 'transfers_view', 'customer_details', 'add_customer',
  'payment_received', 'office_expense',
].join(',');
const SEEDED = '2026-07-01T08:00:00.000Z';
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
  PaymentAccounts: [
    ['account_id', 'owner_name', 'owner_type', 'owner_telegram_id', 'account_number', 'bank', 'status', 'registered_by', 'approval_request_id', 'approved_by', 'created_at', 'notes'],
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
for (const key of Object.keys(base)) {
  if (typeof base[key] !== 'function' || key === 'callsTo' || key === 'allText') { bot[key] = base[key]; continue; }
  bot[key] = async (...args) => {
    const entry = { stepKey: STEP.key, step: STEP.label, actor: STEP.actor, method: key, args: clone(args), lagos: LAGOS };
    LOG.push(entry);
    const res = await base[key](...args);
    entry.result = clone(res);
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
/** A person taps the button carrying `data` on message `messageId` in their chat. */
async function taps(key, uid, data, messageId, label) {
  STEP = { key, label, actor: CAST[uid] };
  updateN += 1;
  const id = `cbq-${updateN}`;
  CB_ACTOR[id] = CAST[uid];
  await controller.handleCallbackQuery(bot, {
    id, data, from: { id: uid, first_name: CAST[uid] },
    message: { message_id: messageId, chat: { id: uid, type: 'private' } },
  });
  await settle();
}
/** message_id of the first / last message SENT to a chat whose text matches `re`. */
function sentTo(uid, re, first) {
  const hits = LOG.filter((e) => e.method === 'sendMessage' && String(e.args[0]) === String(uid) && (!re || re.test(String(e.args[1] || ''))));
  if (!hits.length) throw new Error(`no message to ${uid} matching ${re}`);
  const e = first ? hits[0] : hits[hits.length - 1];
  return e.result && e.result.message_id;
}

/* ── 7. the walk ────────────────────────────────────────────────────────── */
async function main() {
  // Abdul opens the menu → Finance → Payments (he has no account yet)
  at('10:20:00');
  await types('menu', ABDUL, 'menu', 'Abdul types: menu');
  const menuId = sentTo(ABDUL);
  at('10:20:06');
  await taps('finance', ABDUL, 'act:__hub__:finance', menuId, 'Abdul taps 💰 Finance');
  at('10:20:10');
  await taps('payments', ABDUL, 'act:payments', menuId, 'Abdul taps 💳 Payments (he has no registered account yet)');

  // Register account
  at('10:20:15');
  await taps('reg', ABDUL, 'pay:start:reg', menuId, 'Abdul taps 🏦 Register account');
  at('10:20:34');
  await types('num1', ABDUL, '0123456789', 'Abdul types the account number: 0123456789');
  at('10:20:47');
  await types('wrong', ABDUL, '0123456780', 'Abdul types it again with the last digit wrong: 0123456780');
  at('10:21:02');
  await types('num2', ABDUL, '0123456789', 'Abdul types the account number again, correctly: 0123456789');
  at('10:21:11');
  await types('num3', ABDUL, '0123456789', 'Abdul types the same number once more: 0123456789');
  at('10:21:18');
  await taps('bank', ABDUL, 'pay:bank:0', menuId, 'Abdul taps 🏛 GTBank');
  at('10:21:27');
  await taps('submit', ABDUL, 'pay:submit', menuId, 'Abdul taps ✅ Submit for approval');

  const queue = fake._store.get('ApprovalQueue').slice(1);
  if (queue.length !== 1) throw new Error(`expected one queued request, found ${queue.length}`);
  const REQ = String(queue[0][0]);

  // EXTRA — the confirm card is still on screen with its Submit button.
  at('10:21:40');
  await taps('submit_again', ABDUL, 'pay:submit', menuId, 'EXTRA — Abdul taps ✅ Submit for approval a second time, on the confirm card that is still on screen');
  if (fake._store.get('ApprovalQueue').slice(1).length !== 1) throw new Error('the second Submit raised a second request');

  // Krishna gives the first approval, on the card he was sent.
  at('10:34:00');
  await taps('k_approve', KRISHNA, `approve:${REQ}`, sentTo(KRISHNA, /Approval required/), 'Krishna taps ✅ Approve on his approval card (the first of two approvals)');

  // Abdul, on his "Approval 1 of 2" card: Status, Remind approvers, Status again, Remind again.
  const progressCard = sentTo(ABDUL, /Approval 1 of 2/);
  at('10:36:00');
  await taps('status1', ABDUL, `apg:st:${REQ}`, progressCard, 'Abdul taps 📋 Status on his "Approval 1 of 2" card (no reminder sent yet)');
  at('12:05:00');
  await taps('nudge', ABDUL, `apg:nudge:${REQ}`, progressCard, 'Abdul taps 🔔 Remind approvers on his "Approval 1 of 2" card');
  at('12:05:20');
  await taps('status2', ABDUL, `apg:st:${REQ}`, progressCard, 'Abdul taps 📋 Status again, after the reminder');
  at('12:06:00');
  await taps('nudge2', ABDUL, `apg:nudge:${REQ}`, progressCard, 'EXTRA — Abdul taps 🔔 Remind approvers a second time, a minute later');

  // Musa gives the second approval, on the reminder copy of the card.
  at('12:40:00');
  await taps('m_approve', MUSA, `approve:${REQ}`, sentTo(MUSA, /asks for a decision/), 'Musa taps ✅ Approve on the reminder copy of the approval card (the second of two approvals)');

  // Abdul opens Payments again.
  at('12:45:00');
  await types('menu2', ABDUL, 'menu', 'Abdul types: menu (after both approvals)');
  const menu2 = sentTo(ABDUL);
  at('12:45:05');
  await taps('finance2', ABDUL, 'act:__hub__:finance', menu2, 'Abdul taps 💰 Finance again');
  at('12:45:09');
  await taps('payments2', ABDUL, 'act:payments', menu2, 'Abdul taps 💳 Payments again (his account is now approved)');

  // EXTRA — the first copy of Musa's card still has live buttons.
  at('12:50:00');
  await taps('m_stale', MUSA, `approve:${REQ}`, sentTo(MUSA, /Approval required/, true), 'EXTRA — Musa taps ✅ Approve on his FIRST copy of the approval card, which still shows its buttons');

  return REQ;
}

/* ── 8. notes: when the wording differs ─────────────────────────────────── */
// Keyed `<stepKey>|<method>|<recipient>`.
const NOTES = {
  'menu|sendMessage|Abdul': 'New message. Name and "(Operations)" come from Abdul\'s Users row. The tiles depend on the Departments sheet: this capture seeded Operations with supply_request, sell_bale, my_orders, check_stock, list_packages, transfer_stock, transfers_view, customer_details, add_customer, payment_received, office_expense. The bot adds 💳 Payments (inside Finance) for everyone, 📋 My Tasks, and 📍 Mark Attendance (department members are in the attendance audience by default). Six tiles fit; the rest sit behind 📋 More Options (N). When Finance holds only the Payments tile (a department without payment_received) the grid shows 💳 Payments directly instead of 💰 Finance. Typing /menu (what Telegram\'s Menu button sends) gives the same card.',
  'finance|answerCallbackQuery|Abdul': 'Silent acknowledgement of the tap — nothing is shown.',
  'finance|editMessageText|Abdul': 'The menu message itself is rewritten in place (same bubble). 💵 Payment Received shows only because Abdul\'s department lists payment_received; 💳 Payments is there for every user.',
  'payments|answerCallbackQuery|Abdul': 'Silent acknowledgement of the tap — nothing is shown.',
  'payments|editMessageReplyMarkup|Abdul': 'The buttons are stripped from the tapped menu bubble for an instant, before the same bubble is rewritten as the Payments card (next card). Not visible as a separate screen.',
  'payments|editMessageText|Abdul': 'Same bubble, rewritten. This is the wording for a person with NO approved account. With an approved account the italic line is replaced by "You have *1* registered account." (see the last Payments card). An admin also sees a line "Finance: *<name>* pays and marks done." (or a ⚠️ line when no single finance person is set); the finance seat also gets a button "💳 Waiting for me to pay (N)".',
  'reg|answerCallbackQuery|Abdul': 'Silent acknowledgement of the tap — nothing is shown.',
  'reg|editMessageText|Abdul': 'Same bubble, rewritten. An employee is never asked whose account it is: the name is taken from his Users row. An ADMIN first gets "🏦 *Register an account* — Whose account is this?" with 👤 Mine / 🧰 A contractor’s.',
  'num1|editMessageText|Abdul': 'Same bubble, rewritten (it now sits ABOVE the number Abdul typed). Shown after any valid 10-digit entry. An entry that is not 10 digits redraws the bubble as a one-line ⚠️ refusal with the same two buttons instead.',
  'wrong|editMessageText|Abdul': 'Shown only when the second entry differs from the first. Neither number is displayed and the first entry is discarded — he starts again from the first entry.',
  'num2|editMessageText|Abdul': 'Identical to the earlier "Type it once more" card.',
  'num3|editMessageText|Abdul': 'Shown when both entries match. The bold title is the number as typed. One 🏛 button per bank in Settings BANK_LIST, two per row, in the sheet\'s order; with an empty BANK_LIST the built-in list GTBank, Zenith, FirstBank, Access, UBA is used.',
  'bank|answerCallbackQuery|Abdul': 'Silent acknowledgement of the tap — nothing is shown.',
  'bank|editMessageText|Abdul': 'Same bubble, rewritten. "employee" is the owner type; an admin registering a contractor sees "<name> · contractor".',
  'submit|answerCallbackQuery|Abdul': 'Silent acknowledgement of the tap — nothing is shown.',
  'submit|sendMessage|Krishna': 'MarkdownV2: the backslashes are escape characters and are not displayed; the Ref is the full request id in monospace. Sent to every admin id except an admin who raised the request himself. The italic line is the reason the request needs approval. When another pending request carries the same account number + bank the card opens with "⚠️ *Possible duplicate* — …" and gains a second button row "⧉ Reject as duplicate". If Telegram refuses the MarkdownV2 text the same lines are sent as plain text.',
  'submit|sendMessage|Musa': 'Identical to Krishna\'s card (each admin gets his own copy with his own buttons).',
  'submit|sendMessage|Abdul': 'Sent as a NEW bubble at the bottom of the chat. The wizard bubble ("Register this account?") is NOT removed or rewritten: it stays above with ✅ Submit for approval, ⬅ Back and ❌ Cancel still showing. If the same number + bank is already registered or waiting, he gets "⚠️ *Already registered*" instead and nothing is submitted.',
  'submit_again|answerCallbackQuery|Abdul': 'Silent acknowledgement of the tap — nothing is shown.',
  'submit_again|sendMessage|Abdul': 'EXTRA, not in the requested list. A new bubble; the old confirm bubble is left as it was, buttons still showing. No second request is raised and no admin is sent anything.',
  'k_approve|answerCallbackQuery|Krishna': 'A small banner that fades, not an alert box. "of 2" is the number of signatures the request needs: 2 when an employee raised it. When an admin raised it one other admin is enough, and that tap goes straight to "Approving...".',
  'k_approve|editMessageReplyMarkup|Krishna': 'Krishna\'s approval card loses its ✅ Approve / ❌ Reject buttons; its text is unchanged. Musa\'s copy keeps its buttons.',
  'k_approve|sendMessage|Krishna': 'Plain text with the full request id. The 🏠 Back to menu button is appended by the navigation guard (NAV-1) because this is a bare reply to a tap.',
  'k_approve|sendMessage|Abdul': 'Plain text, new bubble. Line 2 is the one-line description every request type carries. The time is the Lagos clock, DD-Mon HH:MM. "1 more admin" reads "N more admins" when more than one signature is still missing.',
  'k_approve|sendMessage|Musa': 'Plain text, no buttons, to every other admin who has not signed. "(register payment account)" is the action\'s label; the full request id is printed.',
  'status1|answerCallbackQuery|Abdul': 'Silent acknowledgement of the tap — nothing is shown.',
  'status1|sendMessage|Abdul': 'Plain text, new bubble. "under an hour waiting" becomes "Nh waiting" after an hour and "Nd waiting" after a day. The 🔔 Remind approvers button shows only to the person who raised the request, and only while it is still waiting.',
  'nudge|sendMessage|Musa': 'The same approval card as at Submit with one line on top. Goes only to admins who have NOT signed — Krishna, who signed, receives nothing. "waiting 1h" is the time since the request was raised ("under an hour", "Nh", "Nd"); "reminder 1" counts the reminders on this request. Musa now holds two live copies of the card.',
  'nudge|answerCallbackQuery|Abdul': 'With several unsigned admins the names are joined: "A and B" / "A, B and C".',
  'nudge|sendMessage|Abdul': 'Plain text, new bubble. "24h" is Settings REQUEST_NUDGE_HOURS (default 24). The row "⬅ Back to Finance · 🏠 Menu" is appended by the navigation guard; "Finance" is the hub Abdul last opened — with no hub remembered it is a single "🏠 Back to menu" button.',
  'status2|answerCallbackQuery|Abdul': 'Silent acknowledgement of the tap — nothing is shown.',
  'status2|sendMessage|Abdul': 'Same card as before, with the wait now "1h waiting" and the extra line "🔔 Reminded 1× · last …" (only present once a reminder has been sent).',
  'nudge2|answerCallbackQuery|Abdul': 'EXTRA, not in the requested list. A box with an OK button. Nothing is sent to anyone. "less than an hour" becomes "Nh" once an hour has passed since the last reminder, and "again in 24h" counts down.',
  'm_approve|answerCallbackQuery|Musa': 'A small banner that fades.',
  'm_approve|editMessageReplyMarkup|Musa': 'The reminder copy Musa tapped loses its buttons. His first copy (from Submit) keeps ✅ Approve / ❌ Reject.',
  'm_approve|sendMessage|Musa': 'Plain text with the full request id; both signers are named "Krishna + Musa". 🏠 Back to menu is appended by the navigation guard.',
  'm_approve|sendMessage|Abdul': 'Plain text, new bubble, no buttons. Krishna, the first signer, is sent nothing at this point.',
  'menu2|sendMessage|Abdul': 'Identical to the first menu card.',
  'finance2|answerCallbackQuery|Abdul': 'Silent acknowledgement of the tap — nothing is shown.',
  'finance2|editMessageText|Abdul': 'Identical to the first Finance card.',
  'payments2|answerCallbackQuery|Abdul': 'Silent acknowledgement of the tap — nothing is shown.',
  'payments2|editMessageReplyMarkup|Abdul': 'The buttons are stripped from the tapped menu bubble for an instant before it is rewritten. Not visible as a separate screen.',
  'payments2|editMessageText|Abdul': 'The Payments card once an account is approved. The count is bold; with two or more it reads "You have *2* registered accounts."',
  'm_stale|answerCallbackQuery|Musa': 'EXTRA, not in the requested list. Nothing is approved twice.',
  'm_stale|editMessageReplyMarkup|Musa': 'EXTRA. The stale first copy loses its buttons.',
  'm_stale|sendMessage|Musa': 'EXTRA, not in the requested list. Plain text; 🏠 Back to menu is appended by the navigation guard.',
};

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
  card.notes = `${NOTES[`${e.stepKey}|${e.method}|${card.recipient}`] || ''}${bubble}`.trim();
  card.from_source = false;
  return card;
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

main().then((REQ) => {
  const sheet = (name) => fake._store.get(name) || [];
  const out = {
    segment: 'register',
    how_the_clock_is_fixed: 'global Date is replaced by a subclass whose no-argument constructor and Date.now() return a value the script sets before every step (11-Nov-2026, Lagos wall clock = UTC+1, from 10:20).',
    how_ids_are_fixed: 'crypto.randomUUID (the request id) and the four random bytes of the PAC-… account id are replaced by fixed values.',
    cast: CAST,
    admin_ids: process.env.ADMIN_IDS,
    employee_ids: process.env.EMPLOYEE_IDS,
    finance_ids_env: process.env.FINANCE_IDS || null,
    settings_bank_list: BANK_LIST,
    operations_allowed_activities: OPERATIONS_ACTIVITIES,
    request_id: REQ,
    cards: LOG.map(toCard),
    structured_cards: LOG.map(toCard).map(toStructured),
    sheets_after: {
      PaymentAccounts: sheet('PaymentAccounts'),
      ApprovalQueue: sheet('ApprovalQueue'),
    },
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`, () => process.exit(0));
}).catch((e) => {
  process.stderr.write(`CAPTURE FAILED: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
