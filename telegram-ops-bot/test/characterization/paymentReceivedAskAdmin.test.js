'use strict';

/**
 * PRC-2 (owner, 16-Nov-2026) — 💵 Payment Received: "the employee will
 * select the admin from the admin list to send for approval"; "if the amount
 * is known … I will attach the amount also". Rulings R1–R3: the named admin
 * is asked first and two approvals stay; the request is never stuck on one
 * person; the amount may be left blank and the FIRST approving admin types it.
 *
 * Driven through the REAL controller, the real approval handler, the real
 * executor and the real ApprovalQueue repository on the in-memory sheet.
 * Only the customer book (crmService.recordPayment) and the ledger read are
 * stand-ins.
 */

process.env.ADMIN_IDS = '777,888,555';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

const fake = createFakeSheets({});
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const config = require(path.join(SRC, 'config'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const fmtDate = require(path.join(SRC, 'utils/formatDate'));
const { todayInLagos } = require(path.join(SRC, 'utils/dates'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const crmService = require(path.join(SRC, 'services/crmService'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const approvalGate = require(path.join(SRC, 'services/approvalGate'));
const approvalReminder = require(path.join(SRC, 'services/approvalReminder'));

const ABDUL = '4242';
const KRISHNA = '777';
const MUSA = '888';
const JOHN = '555';
const ADMINS = [KRISHNA, MUSA, JOHN];
let NAMES = {};
const BASE_NAMES = { [KRISHNA]: 'Krishna', [MUSA]: 'Musa', [JOHN]: 'John', [ABDUL]: 'Abdul' };

let SETTINGS = {};
let BOOKED = [];
let AUDIT = [];

customersRepository.getAll = async () => [
  { customer_id: 'C-1', name: 'ABBA', phone: '0801', status: 'Active', outstanding_balance: 120000 },
  { customer_id: 'C-9', name: 'A_B*BA', phone: '0809', status: 'Active', outstanding_balance: 0 },
];
settingsRepository.getAll = async () => ({ ...SETTINGS });
usersRepository.findByUserId = async () => null;
usersRepository.getAll = async () => [];
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);
auditLogRepository.append = async (event, payload, by) => { AUDIT.push({ event, payload, by }); };
accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 120000 });
crmService.recordPayment = async (p) => { BOOKED.push(p); return { status: 'completed', customer: 'ABBA', paid: p.amount }; };

const QUEUE_HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'];

function reset(settings = {}) {
  SETTINGS = { BANK_LIST: 'Zenith, GTB', ...settings };
  NAMES = { ...BASE_NAMES };
  BOOKED = [];
  AUDIT = [];
  fake._store.set('ApprovalQueue', [[...QUEUE_HEADERS]]);
  [ABDUL, ...ADMINS].forEach((id) => sessionStore.clear(id));
  approvalGate._internals.recent.clear();
  approvalReminder._resetForTests();
}

const msg = (uid, text) => ({ message_id: 5, chat: { id: uid, type: 'private' }, from: { id: uid, first_name: 'X' }, text });
const rows = () => fake._store.get('ApprovalQueue').slice(1);
const rowOf = (id) => rows().find((r) => r[0] === id);
const jsonOf = (id) => JSON.parse(rowOf(id)[2]);
const statusOf = (id) => rowOf(id)[4];
const setCreatedAt = (id, iso) => { rowOf(id)[5] = iso; };

const sentTo = (bot, id, from = 0) => bot.calls.slice(from)
  .filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(id));
const textsTo = (bot, id, from = 0) => sentTo(bot, id, from).map((c) => String(c.args.text));
const cardsTo = (bot, id, from = 0) => sentTo(bot, id, from).filter((c) => /Approval required/.test(c.args.text));
const chipsOf = (call) => ((call.args.opts && call.args.opts.reply_markup && call.args.opts.reply_markup.inline_keyboard) || []).flat()
  .map((b) => `${b.text}|${b.callback_data}`);
const toasts = (bot, from = 0) => bot.calls.slice(from)
  .filter((c) => c.method === 'answerCallbackQuery').map((c) => (c.args.opts && c.args.opts.text) || '');
function lastScreen(bot, uid) {
  const c = bot.calls.filter((x) => (x.method === 'sendMessage' && String(x.args.chatId) === String(uid))
    || (x.method === 'editMessageText' && String(x.args.opts && x.args.opts.chat_id) === String(uid)));
  const last = c[c.length - 1];
  if (!last) return { text: '', chips: [] };
  const opts = last.method === 'sendMessage' ? last.args.opts : last.args.opts;
  return { text: String(last.args.text), chips: ((opts && opts.reply_markup && opts.reply_markup.inline_keyboard) || []).flat().map((b) => `${b.text}|${b.callback_data}`), call: last };
}
/** MarkdownV2 escape, as the admin card does. */
const esc = (s) => String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

/**
 * PRC-2 review 1 — read a legacy-Markdown text the way Telegram does and fail
 * on a backslash inside a *bold* entity (Telegram honours no escape there:
 * the backslash shows, and an escaped * is refused with a 400).
 */
function noEscapeInBold(text) {
  let mode = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (mode === '') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '*') mode = '*';
      else if (ch === '`') mode = '`';
      continue;
    }
    if (ch === mode) { mode = ''; continue; }
    if (mode === '*' && ch === '\\') assert.fail(`a backslash inside *bold* at ${i}: ${JSON.stringify(text)}`);
  }
  assert.equal(mode, '', `every entity is closed: ${JSON.stringify(text)}`);
}

/**
 * Abdul (employee) or an admin raises a payment received for ABBA.
 * @param {{amount?:string|null, ask?:string, customer?:string, uid?:string}} o
 *   amount null = ⏭ Amount not known; ask = the chip text after 🛂, or 'any'
 */
async function raise(bot, { amount = '50000', ask = 'Musa', customer = 'ABBA', uid = ABDUL } = {}) {
  await controller.handleCallbackQuery(bot, cb('act:payment_received', uid));
  const pick = lastScreen(bot, uid).chips.find((c) => c.startsWith(`👤 ${customer}|`));
  await controller.handleCallbackQuery(bot, cb(pick.split('|')[1], uid));
  if (amount === null) await controller.handleCallbackQuery(bot, cb('prc:noamt', uid));
  else await controller.handleMessage(bot, msg(uid, amount));
  await controller.handleCallbackQuery(bot, cb('prc:m:1', uid));
  const scr = lastScreen(bot, uid);
  if (/Who should approve it\?/.test(scr.text)) {
    const chip = ask === 'any' ? scr.chips.find((c) => c.startsWith('👥 Any admin|'))
      : scr.chips.find((c) => c.startsWith(`🛂 ${ask}|`));
    assert.ok(chip, `chip for ${ask} in ${scr.chips.join(', ')}`);
    await controller.handleCallbackQuery(bot, cb(chip.split('|')[1], uid));
  }
  await controller.handleCallbackQuery(bot, cb('prc:submit', uid));
  const r = rows()[rows().length - 1];
  return r[0];
}

async function pickAbba(bot, uid) {
  const pick = lastScreen(bot, uid).chips.find((c) => c.startsWith('👤 ABBA|'));
  await controller.handleCallbackQuery(bot, cb(pick.split('|')[1], uid));
}

/** An admin's ✅ Approve on their DM card (message `msgId`). */
const approveDm = (bot, admin, id, msgId = 71) => controller.handleCallbackQuery(bot, cb(`approve:${id}`, admin, msgId));

/** A tap on the admin's amount step: the message is a reply to the approval card. */
function stepCb(data, uid, msgId, cardId, cardChips) {
  return {
    ...cb(data, uid, msgId),
    message: {
      chat: { id: uid }, message_id: msgId,
      ...(cardId ? { reply_to_message: { message_id: cardId, chat: { id: uid }, reply_markup: { inline_keyboard: cardChips || [] } } } : {}),
    },
  };
}
const dmChips = (id) => [[{ text: '✅ Approve', callback_data: `approve:${id}` }, { text: '❌ Reject', callback_data: `reject:${id}` }]];

/* ── 1–2. asked, amount typed ─────────────────────────────────────────── */

test('PRC-2 #1: an employee asks Musa — ONLY Musa is DM\'d; the inbox shows "Asked: Musa"; the receipt says "Sent to Musa"', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payment_received', ABDUL));
  await pickAbba(bot, ABDUL);
  // Step 2 for an employee
  assert.equal(lastScreen(bot, ABDUL).text, [
    '💵 *Payment received*', '', 'Customer: *ABBA*', '', 'How much did they pay?',
    'Type the amount, for example `50000`.', 'If you do not know it, tap ⏭ Amount not known — the admin enters it.',
  ].join('\n'));
  assert.deepEqual(lastScreen(bot, ABDUL).chips, ['⏭ Amount not known|prc:noamt', '⬅ Back|prc:back', '❌ Cancel|prc:cancel']);
  await controller.handleMessage(bot, msg(ABDUL, '50,000'));
  await controller.handleCallbackQuery(bot, cb('prc:m:1', ABDUL));
  // Step 4 — who should approve
  assert.equal(lastScreen(bot, ABDUL).text, [
    '💵 *Payment received*', '', 'Customer: *ABBA*', 'Amount: *50,000*', 'Paid by: Bank — Zenith', '',
    'Who should approve it?', 'The admin you pick is asked first.',
  ].join('\n'));
  assert.deepEqual(lastScreen(bot, ABDUL).chips, ['🛂 Krishna|prc:ad:0', '🛂 Musa|prc:ad:1', '🛂 John|prc:ad:2',
    '👥 Any admin|prc:ad:any', '⬅ Back|prc:back', '❌ Cancel|prc:cancel'], 'never the requester');
  // Back walks the new step too
  await controller.handleCallbackQuery(bot, cb('prc:ad:1', ABDUL));
  await controller.handleCallbackQuery(bot, cb('prc:back', ABDUL));
  assert.match(lastScreen(bot, ABDUL).text, /Who should approve it\?/);
  await controller.handleCallbackQuery(bot, cb('prc:back', ABDUL));
  assert.match(lastScreen(bot, ABDUL).text, /How was it paid\?/);
  await controller.handleCallbackQuery(bot, cb('prc:m:1', ABDUL));
  await controller.handleCallbackQuery(bot, cb('prc:ad:1', ABDUL));
  assert.equal(lastScreen(bot, ABDUL).text, [
    '💵 *Payment received*', '', 'Customer: *ABBA*', 'Amount: *50,000*', 'Paid by: Bank — Zenith', 'Ask: Musa',
    `Date: ${fmtDate(todayInLagos())}`, '',
    'Musa is asked first. Two admins approve it before the customer\'s balance moves.',
  ].join('\n'));
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('prc:submit', ABDUL));
  const id = rows()[0][0];
  const aj = jsonOf(id);
  assert.deepEqual(aj.askedAdmin, { id: MUSA, name: 'Musa' });
  assert.equal(aj.amount, 50000);
  assert.equal(aj.amountPending, undefined);

  assert.equal(cardsTo(bot, MUSA, from).length, 1, 'Musa gets the card');
  assert.equal(sentTo(bot, KRISHNA, from).length, 0, 'Krishna gets nothing');
  assert.equal(sentTo(bot, JOHN, from).length, 0, 'John gets nothing');
  const card = cardsTo(bot, MUSA, from)[0];
  assert.ok(card.args.text.startsWith(`${esc('🙋 Abdul asks YOU to approve this.')}\n\n🔔 *Approval required*`));
  assert.ok(card.args.text.includes(esc('🙋 Asked: Musa\nOutstanding today: 120,000\nAfter this payment: 70,000')));
  assert.deepEqual(chipsOf(card), [`✅ Approve|approve:${id}`, `❌ Reject|reject:${id}`]);

  const receipt = lastScreen(bot, ABDUL);
  assert.equal(receipt.text.split('\n')[0], '⏳ *Sent to Musa for approval*');
  assert.match(receipt.text, /Ask: Musa\nDate: .*\nRef R-/);
  assert.ok(!/120,000/.test(receipt.text), 'no balance on the employee\'s card');
  assert.ok(receipt.chips.includes(`🔔 Remind approvers|apg:nudge:${id}`));

  const audit = AUDIT.find((a) => a.event === 'approval_queued');
  assert.equal(audit.payload.asked, MUSA);
  assert.equal(audit.payload.amountPending, false);

  // R2 — the request is in every admin's 🛂 inbox, marked
  const inbox = createFakeBot();
  const live = await approvalQueueRepository.getByRequestId(id);
  sessionStore.set(KRISHNA, { type: 'approvals_inbox_flow', step: 'items', category: 'finance', _items: [live], flowMessageId: 77 });
  await controller.handleCallbackQuery(inbox, cb('abx:i:0', KRISHNA, 77));
  assert.match(lastScreen(inbox, KRISHNA).text, /🙋 Asked: Musa/);
  assert.ok(lastScreen(inbox, KRISHNA).chips.includes(`✅ Approve|abx:ok:${id}`));
});

test('PRC-2 #1b: an asked admin who cannot be reached — the card goes to the other admins at once and the employee is told', async () => {
  reset();
  const bot = createFakeBot();
  const realSend = bot.sendMessage.bind(bot);
  bot.sendMessage = async (chatId, text, opts) => {
    if (String(chatId) === MUSA) throw new Error('Forbidden: bot was blocked by the user');
    return realSend(chatId, text, opts);
  };
  const id = await raise(bot);
  for (const a of [KRISHNA, JOHN]) {
    const cards = cardsTo(bot, a);
    assert.equal(cards.length, 1, `${a} gets the card`);
    assert.ok(cards[0].args.text.startsWith(esc('🙋 Asked: Musa (could not be reached)')));
  }
  assert.ok(jsonOf(id).askWidenedAt, 'widened at once');
  assert.match(lastScreen(bot, ABDUL).text, /⚠️ Musa could not be reached — sent to the other admins\.$/);
});

test('PRC-2 #2: Musa approves → 1 of 2, the others get the FULL card; the second approval books the amount', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot);
  const from = bot.calls.length;
  await approveDm(bot, MUSA, id);
  assert.deepEqual(jsonOf(id).approvals, [MUSA]);
  assert.ok(jsonOf(id).askWidenedAt, 'widened in the signature\'s own write');
  assert.equal(statusOf(id), 'pending');
  assert.ok(textsTo(bot, MUSA, from).some((t) => /your approval is recorded \(1 of 2\)/.test(t)));
  const progress = textsTo(bot, ABDUL, from).find((t) => /🔏 Approval 1 of 2/.test(t));
  assert.ok(progress);
  assert.match(progress, /🙋 Asked: Musa/);
  for (const other of [KRISHNA, JOHN]) {
    const full = cardsTo(bot, other, from);
    assert.equal(full.length, 1, `${other} gets the full card`);
    assert.ok(full[0].args.text.startsWith(esc('🔏 1 of 2 — signed by Musa. Yours is the second approval.')));
    assert.deepEqual(chipsOf(full[0]), [`✅ Approve|approve:${id}`, `❌ Reject|reject:${id}`]);
    assert.ok(!textsTo(bot, other, from).some((t) => /needs a SECOND/.test(t)), 'no one-line ping on top of the card');
  }
  assert.equal(cardsTo(bot, MUSA, from).length, 0);

  const from2 = bot.calls.length;
  await approveDm(bot, KRISHNA, id, 72);
  assert.equal(statusOf(id), 'approved');
  assert.equal(BOOKED.length, 1);
  assert.equal(BOOKED[0].amount, 50000);
  assert.ok(textsTo(bot, ABDUL, from2).some((t) => /✅ Approved · 2 of 2/.test(t)), 'the requester is told');
  assert.ok(!textsTo(bot, ABDUL, from2).some((t) => /120,000|70,000|Outstanding/.test(t)), 'no balance reaches the requester');
});

test('PRC-2 #3 (R2): another admin approves first from the inbox — allowed; Musa gets the one-line ping, John the full card', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot);
  const live = await approvalQueueRepository.getByRequestId(id);
  sessionStore.set(KRISHNA, { type: 'approvals_inbox_flow', step: 'items', category: 'finance', _items: [live], flowMessageId: 77 });
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb(`abx:ok:${id}`, KRISHNA, 77));
  assert.deepEqual(jsonOf(id).approvals, [KRISHNA]);
  assert.ok(textsTo(bot, MUSA, from).some((t) => /has its first admin approval and needs a SECOND/.test(t)), 'Musa already holds the card');
  assert.equal(cardsTo(bot, MUSA, from).length, 0);
  assert.equal(cardsTo(bot, JOHN, from).length, 1);
  assert.match(cardsTo(bot, JOHN, from)[0].args.text, /signed by Krishna/);
  await approveDm(bot, MUSA, id);
  assert.equal(statusOf(id), 'approved');
  assert.equal(BOOKED[0].amount, 50000);
});

/* ── 4. the amount left blank ─────────────────────────────────────────── */

test('PRC-2 #4: ⏭ Amount not known → Musa types it at the first approval → the second admin checks it', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payment_received', ABDUL));
  await pickAbba(bot, ABDUL);
  await controller.handleCallbackQuery(bot, cb('prc:noamt', ABDUL));
  assert.equal(lastScreen(bot, ABDUL).text, '💵 *Payment received*\n\nCustomer: *ABBA*\nAmount: to be entered by the admin\n\nHow was it paid?');
  await controller.handleCallbackQuery(bot, cb('prc:m:1', ABDUL));
  await controller.handleCallbackQuery(bot, cb('prc:ad:1', ABDUL));
  assert.equal(lastScreen(bot, ABDUL).text, [
    '💵 *Payment received*', '', 'Customer: *ABBA*', 'Amount: to be entered by the admin', 'Paid by: Bank — Zenith', 'Ask: Musa',
    `Date: ${fmtDate(todayInLagos())}`, '',
    'The admin enters the amount. Musa is asked first. Two admins approve it before the customer\'s balance moves.',
  ].join('\n'));
  await controller.handleCallbackQuery(bot, cb('prc:submit', ABDUL));
  const id = rows()[0][0];
  assert.equal(jsonOf(id).amountPending, true);
  assert.equal(jsonOf(id).amount, undefined);
  const card = cardsTo(bot, MUSA)[0];
  assert.ok(card.args.text.includes(esc('Amount: not entered — typed at the first approval')));
  assert.ok(!card.args.text.includes('After this payment'));

  // ✅ Approve → nothing recorded, the amount step opens as a reply to the card
  let from = bot.calls.length;
  await approveDm(bot, MUSA, id, 71);
  assert.deepEqual(toasts(bot, from), ['Type the amount first.']);
  assert.equal(jsonOf(id).approvals, undefined, 'no signature');
  assert.equal(bot.calls.slice(from).filter((c) => c.method === 'editMessageReplyMarkup').length, 0, 'the card keeps its buttons');
  const prompt = sentTo(bot, MUSA, from)[0];
  assert.equal(prompt.args.text, [
    '💵 *Payment received · amount needed*', '', 'Customer: *ABBA*', 'Paid by: Bank — Zenith', 'Raised by: Abdul',
    'Outstanding today: 120,000', '',
    'Abdul did not know the amount. Type what ABBA paid, for example `50000`.', 'Nothing is approved until you confirm.',
    'If the bot answers with a bale card or "not found" instead, tap ✏️ Type the amount and send the number again.',
  ].join('\n'));
  assert.equal(prompt.args.opts.reply_to_message_id, 71);
  assert.deepEqual(chipsOf(prompt), [`✏️ Type the amount|prc:ae:${id}`, `✖ Not now|prc:ax:${id}`]);
  const promptId = sessionStore.get(MUSA).flowMessageId;

  // a bad figure
  await controller.handleMessage(bot, msg(MUSA, 'fifty'));
  assert.match(lastScreen(bot, MUSA).text, /⚠️ That is not an amount\. Type digits only, for example 50000\.$/);
  // a good one → the check card
  await controller.handleMessage(bot, msg(MUSA, '50,000'));
  const check = lastScreen(bot, MUSA);
  assert.equal(check.text, [
    '💵 *Payment received · check the amount*', '', 'Customer: *ABBA*', 'Amount: *50,000* · entered by you', 'Paid by: Bank — Zenith',
    'Outstanding today: 120,000', 'After this payment: 70,000', '',
    'Your approval is the first of two. A second admin checks the amount.',
  ].join('\n'));
  assert.deepEqual(check.chips, [`✅ Approve with 50,000|prc:ay:${id}:50000`, `✏️ Change amount|prc:ae:${id}`, `✖ Not now|prc:ax:${id}`]);
  assert.equal(jsonOf(id).amount, undefined, 'typing is not approving');

  // ✏️ Change amount → back to the prompt
  await controller.handleCallbackQuery(bot, stepCb(`prc:ae:${id}`, MUSA, promptId, 71, dmChips(id)));
  assert.match(lastScreen(bot, MUSA).text, /amount needed/);
  await controller.handleMessage(bot, msg(MUSA, '50000'));

  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, stepCb(`prc:ay:${id}:50000`, MUSA, promptId, 71, dmChips(id)));
  const aj = jsonOf(id);
  assert.equal(aj.amount, 50000);
  assert.equal(aj.amountPending, false);
  assert.equal(aj.amountBy.id, MUSA);
  assert.equal(aj.amountBy.name, 'Musa');
  assert.deepEqual(aj.approvals, [MUSA], 'the same tap is Musa\'s approval 1 of 2');
  assert.ok(AUDIT.some((a) => a.event === 'payment_received_amount_entered' && a.payload.amount === 50000 && a.payload.requestId === id));
  const wiped = bot.calls.slice(from).filter((c) => c.method === 'editMessageReplyMarkup').map((c) => c.args.opts.message_id);
  assert.ok(wiped.includes(71), 'the approval card is sealed');
  const closing = bot.calls.slice(from).filter((c) => c.method === 'editMessageText' && c.args.opts.message_id === promptId).pop();
  assert.equal(closing.args.text, '✅ You entered 50,000 and gave approval 1 of 2. A second admin checks it.');
  assert.deepEqual(closing.args.opts.reply_markup.inline_keyboard, []);
  assert.ok(!sessionStore.get(MUSA), 'the step is over');
  assert.ok(textsTo(bot, ABDUL, from).some((t) => /💵 Amount entered by Musa: 50,000/.test(t)), 'the requester sees who entered it');
  const second = cardsTo(bot, JOHN, from)[0];
  assert.ok(second.args.text.includes(esc('Amount: 50,000 · entered by Musa')));

  // review 1 (R3) — John's plain ✅ Approve records nothing until he has
  // seen the figure Musa typed and tapped it
  from = bot.calls.length;
  await approveDm(bot, JOHN, id, 72);
  assert.equal(statusOf(id), 'pending');
  assert.deepEqual(jsonOf(id).approvals, [MUSA]);
  const johnCheck = sentTo(bot, JOHN, from).pop();
  assert.equal(johnCheck.args.opts.reply_to_message_id, 72);
  assert.deepEqual(chipsOf(johnCheck), [`✅ Approve 50,000|prc:ok:${id}:50000`, `✖ Not now|prc:ax:${id}`]);
  await controller.handleCallbackQuery(bot, stepCb(`prc:ok:${id}:50000`, JOHN, 73, 72, dmChips(id)));
  assert.equal(statusOf(id), 'approved');
  assert.equal(BOOKED.length, 1);
  assert.equal(BOOKED[0].amount, 50000);
});

/* ── 5. fail-closed ───────────────────────────────────────────────────── */

async function blankForMusa(bot) {
  const id = await raise(bot, { amount: null });
  await approveDm(bot, MUSA, id, 71);
  await controller.handleMessage(bot, msg(MUSA, '50000'));
  return { id, promptId: sessionStore.get(MUSA).flowMessageId };
}

test('PRC-2 #5a: a refused amount save approves nothing and records no signature', async () => {
  reset();
  const bot = createFakeBot();
  const { id, promptId } = await blankForMusa(bot);
  const real = approvalQueueRepository.updateActionJSON;
  approvalQueueRepository.updateActionJSON = async (rid, patch) => {
    if (patch && patch.amount) throw new Error('quota');
    return real(rid, patch);
  };
  try {
    const from = bot.calls.length;
    await controller.handleCallbackQuery(bot, stepCb(`prc:ay:${id}:50000`, MUSA, promptId, 71, dmChips(id)));
    assert.ok(toasts(bot, from).includes('⚠️ Could not save the amount — nothing was approved. Tap again in a minute.'));
  } finally { approvalQueueRepository.updateActionJSON = real; }
  assert.equal(jsonOf(id).amount, undefined);
  assert.equal(jsonOf(id).approvals, undefined);
  assert.equal(statusOf(id), 'pending');
  const check = lastScreen(bot, MUSA);
  assert.match(check.text, /check the amount/, 'the check card stays, with its buttons, so Musa can tap again');
  assert.ok(check.chips.includes(`✅ Approve with 50,000|prc:ay:${id}:50000`));
});

test('PRC-2 #5b: the executor refuses a row with no amount', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot, { amount: null, ask: 'any' });
  const res = await inventoryService.executeApprovedAction(id, KRISHNA);
  assert.equal(res.ok, false);
  assert.equal(res.message, 'This payment has no amount yet — nothing was recorded.');
  assert.equal(BOOKED.length, 0);
  assert.equal(statusOf(id), 'pending');
});

test('PRC-2 #5c: a stale ✅ Approve with — another admin entered the amount meanwhile — approves nothing', async () => {
  reset();
  const bot = createFakeBot();
  const { id, promptId } = await blankForMusa(bot);
  // Krishna, from the inbox: Approve → his own amount step → 40,000
  await approveDm(bot, KRISHNA, id, 81);
  await controller.handleMessage(bot, msg(KRISHNA, '40000'));
  const kPrompt = sessionStore.get(KRISHNA).flowMessageId;
  await controller.handleCallbackQuery(bot, stepCb(`prc:ay:${id}:40000`, KRISHNA, kPrompt, 81, dmChips(id)));
  assert.equal(jsonOf(id).amount, 40000);
  assert.deepEqual(jsonOf(id).approvals, [KRISHNA]);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, stepCb(`prc:ay:${id}:50000`, MUSA, promptId, 71, dmChips(id)));
  assert.ok(toasts(bot, from).includes('Krishna already entered 40,000 for this payment. Open the card to approve or reject it.'));
  assert.equal(jsonOf(id).amount, 40000);
  assert.deepEqual(jsonOf(id).approvals, [KRISHNA], 'Musa signed nothing');
  // the seam itself also refuses a stale amount (a re-entry that skipped the chip's check)
  const item = await approvalQueueRepository.getByRequestId(id);
  const seam = await require(path.join(SRC, 'flows/paymentReceivedFlow')).amountSeam(createFakeBot(), cb(`approve:${id}`, MUSA), id, item, 50000);
  assert.equal(seam.stop, true);
});

test('PRC-2 #5d: ✅ Approve with on a decided request; by a non-admin; by the requester-admin', async () => {
  reset();
  const bot = createFakeBot();
  const { id, promptId } = await blankForMusa(bot);
  await approvalQueueRepository.updateStatus(id, 'rejected', new Date().toISOString(), 'Krishna');
  let from = bot.calls.length;
  await controller.handleCallbackQuery(bot, stepCb(`prc:ay:${id}:50000`, MUSA, promptId, 71, dmChips(id)));
  assert.ok(toasts(bot, from).includes('Already rejected — nothing to do.'));
  assert.equal(jsonOf(id).amount, undefined);

  // a non-admin
  reset();
  const b2 = createFakeBot();
  const id2 = await raise(b2, { amount: null });
  from = b2.calls.length;
  await controller.handleCallbackQuery(b2, stepCb(`prc:ay:${id2}:50000`, ABDUL, 9, null));
  assert.ok(toasts(b2, from).includes('Only admins can approve.'));
  assert.equal(jsonOf(id2).amount, undefined);

  // a crafted blank row raised by an admin: the requester can never enter its amount
  await approvalQueueRepository.append({ requestId: 'crafted-0001-0000-0000-000000000000', user: KRISHNA, status: 'pending',
    actionJSON: { action: 'record_payment', customer: 'ABBA', method: 'Cash', amountPending: true } });
  from = b2.calls.length;
  await controller.handleCallbackQuery(b2, stepCb('prc:ay:crafted-0001-0000-0000-000000000000:50000', KRISHNA, 9, null));
  assert.ok(toasts(b2, from).includes('🔒 You cannot enter the amount on your own request.'));
  await controller.handleCallbackQuery(b2, cb('approve:crafted-0001-0000-0000-000000000000', KRISHNA));
  assert.equal(jsonOf('crafted-0001-0000-0000-000000000000').amount, undefined);
  assert.ok(!sessionStore.get(KRISHNA) || sessionStore.get(KRISHNA).step !== 'admin_amount', 'no amount step around the self-approval guard');
});

test('PRC-2 #5e: ✖ Not now — nothing approved, the request still waits', async () => {
  reset();
  const bot = createFakeBot();
  const { id, promptId } = await blankForMusa(bot);
  const from = bot.calls.length;
  await controller.handleCallbackQuery(bot, stepCb(`prc:ax:${id}`, MUSA, promptId, 71, dmChips(id)));
  const edit = bot.calls.slice(from).find((c) => c.method === 'editMessageText');
  assert.equal(edit.args.text, 'Nothing was approved. The request still waits.');
  assert.deepEqual(edit.args.opts.reply_markup.inline_keyboard, []);
  assert.ok(!sessionStore.get(MUSA));
  assert.equal(statusOf(id), 'pending');
  assert.equal(jsonOf(id).approvals, undefined);
});

/* ── 6. who may leave the amount blank, who is listed ─────────────────── */

test('PRC-2 #6: an admin never sees ⏭ Amount not known (a crafted tap is refused); the who-step lists the others, never the requester', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payment_received', KRISHNA));
  await pickAbba(bot, KRISHNA);
  assert.ok(!lastScreen(bot, KRISHNA).chips.some((c) => /Amount not known/.test(c)));
  assert.ok(!/Amount not known/.test(lastScreen(bot, KRISHNA).text));
  await controller.handleCallbackQuery(bot, cb('prc:noamt', KRISHNA));
  assert.match(lastScreen(bot, KRISHNA).text, /How much did they pay\?/, 'redrawn, not skipped');
  assert.equal(sessionStore.get(KRISHNA).noAmount, false);
  await controller.handleMessage(bot, msg(KRISHNA, '20000'));
  await controller.handleCallbackQuery(bot, cb('prc:m:0', KRISHNA));
  assert.deepEqual(lastScreen(bot, KRISHNA).chips, ['🛂 Musa|prc:ad:0', '🛂 John|prc:ad:1', '👥 Any admin|prc:ad:any', '⬅ Back|prc:back', '❌ Cancel|prc:cancel']);
  await controller.handleCallbackQuery(bot, cb('prc:ad:0', KRISHNA));
  assert.match(lastScreen(bot, KRISHNA).text, /Musa is asked to approve it before the customer's balance moves\.$/);
  await controller.handleCallbackQuery(bot, cb('prc:back', KRISHNA));
  await controller.handleCallbackQuery(bot, cb('prc:ad:any', KRISHNA));
  assert.match(lastScreen(bot, KRISHNA).text, /Another admin approves it before the customer's balance moves\.$/);
  // an admin's own request with an asked admin: that admin's approval completes it
  await controller.handleCallbackQuery(bot, cb('prc:back', KRISHNA));
  await controller.handleCallbackQuery(bot, cb('prc:ad:0', KRISHNA));
  await controller.handleCallbackQuery(bot, cb('prc:submit', KRISHNA));
  const id = rows()[0][0];
  assert.equal(cardsTo(bot, MUSA).length, 1);
  assert.equal(cardsTo(bot, JOHN).length, 0);
  await approveDm(bot, MUSA, id);
  assert.equal(statusOf(id), 'approved');
  assert.equal(BOOKED[0].amount, 20000);
});

test('PRC-2 #6b: with ONE admin able to approve, the who-step is skipped and nothing is asked', async () => {
  reset();
  const saved = config.access.adminIds;
  config.access.adminIds = [MUSA];
  try {
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('act:payment_received', ABDUL));
    await pickAbba(bot, ABDUL);
    await controller.handleMessage(bot, msg(ABDUL, '1000'));
    await controller.handleCallbackQuery(bot, cb('prc:m:0', ABDUL));
    const scr = lastScreen(bot, ABDUL);
    assert.match(scr.text, /Two admins approve it before the customer's balance moves\.$/);
    assert.ok(!/Ask:/.test(scr.text));
    await controller.handleCallbackQuery(bot, cb('prc:back', ABDUL));
    assert.match(lastScreen(bot, ABDUL).text, /How was it paid\?/, 'Back skips the step it skipped');
    await controller.handleCallbackQuery(bot, cb('prc:m:0', ABDUL));
    await controller.handleCallbackQuery(bot, cb('prc:submit', ABDUL));
    assert.equal(jsonOf(rows()[0][0]).askedAdmin, undefined);
  } finally { config.access.adminIds = saved; }
});

/* ── 7. reminders and the nudge ───────────────────────────────────────── */

test('PRC-2 #7: reminder sweep — the asked admin alone, then everyone with the note, then the unsigned', async () => {
  reset({ REMINDER_HOURS_ADMIN: 1 });
  const bot = createFakeBot();
  const id = await raise(bot);
  const NOW = Date.now();
  const sweep = async (createdHoursAgo) => {
    setCreatedAt(id, new Date(NOW - createdHoursAgo * 3600 * 1000).toISOString());
    approvalReminder._resetForTests();
    const from = bot.calls.length;
    await approvalReminder.sweepPending(bot, { now: NOW });
    return from;
  };
  let from = await sweep(1);
  assert.equal(cardsTo(bot, MUSA, from).length, 1);
  assert.ok(cardsTo(bot, MUSA, from)[0].args.text.startsWith(esc('⏰ Reminder — Abdul asked YOU to approve this')));
  assert.equal(cardsTo(bot, KRISHNA, from).length + cardsTo(bot, JOHN, from).length, 0, 'before the widen hour: Musa only');
  assert.equal(sentTo(bot, ABDUL, from).length, 0);
  assert.equal(jsonOf(id).askWidenedAt, undefined);

  from = await sweep(5);
  for (const a of ADMINS) {
    assert.equal(cardsTo(bot, a, from).length, 1, `${a} reminded after the widen hour`);
    assert.ok(cardsTo(bot, a, from)[0].args.text.startsWith(esc('⏰ Reminder — asked: Musa · no answer for 5h. Any admin may approve.')));
  }
  assert.ok(jsonOf(id).askWidenedAt, 'stamped the first time');
  assert.equal(sentTo(bot, ABDUL, from).length, 0);

  await approveDm(bot, MUSA, id);
  from = await sweep(6);
  assert.equal(cardsTo(bot, MUSA, from).length, 0, 'a signer is never reminded');
  assert.equal(cardsTo(bot, KRISHNA, from).length, 1);
  assert.equal(cardsTo(bot, JOHN, from).length, 1);
  assert.ok(cardsTo(bot, JOHN, from)[0].args.text.startsWith(esc('⏰ Reminder — this approval is still waiting')));
});

test('PRC-2 #7b: 🔔 Remind approvers — the same audiences', async () => {
  reset();
  const bot = createFakeBot();
  const young = await raise(bot);
  let from = bot.calls.length;
  let r = await approvalGate.nudge({ bot, requestId: young, byUserId: ABDUL });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reminded, ['Musa']);
  assert.equal(cardsTo(bot, MUSA, from).length, 1);
  assert.equal(cardsTo(bot, KRISHNA, from).length + cardsTo(bot, JOHN, from).length, 0);

  approvalGate._internals.recent.clear();
  const old = await raise(bot, { amount: '60000' });
  setCreatedAt(old, new Date(Date.now() - 5 * 3600 * 1000).toISOString());
  from = bot.calls.length;
  r = await approvalGate.nudge({ bot, requestId: old, byUserId: ABDUL });
  assert.deepEqual(r.reminded.sort(), ['John', 'Krishna', 'Musa']);
  assert.ok(jsonOf(old).askWidenedAt);
  assert.equal(sentTo(bot, ABDUL, from).length, 0);

  approvalGate._internals.recent.clear();
  const signed = await raise(bot, { amount: '70000' });
  await approveDm(bot, MUSA, signed);
  r = await approvalGate.nudge({ bot, requestId: signed, byUserId: ABDUL });
  assert.deepEqual(r.reminded.sort(), ['John', 'Krishna'], 'never a signer');
});

/* ── 8. 👥 Any admin: as before ───────────────────────────────────────── */

test('PRC-2 #8: 👥 Any admin — the card, its recipients and the receipt exactly as before PRC-2', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot, { ask: 'any' });
  const aj = jsonOf(id);
  assert.equal(aj.askedAdmin, undefined);
  const legacyCard = [
    'Record Payment Request', 'Customer: ABBA', 'Amount: 50,000', 'Method: Bank — Zenith', `Date: ${fmtDate(todayInLagos())}`,
    'Outstanding today: 120,000', 'After this payment: 70,000',
  ].join('\n');
  const expected = `🔔 *Approval required*\n\nRef: \`${id}\`\nFrom: Abdul\n\n${esc(legacyCard)}\n\n_${esc(approvalCards.shortReason(rowOf(id)[3]))}_\n\nUse buttons below to approve or reject\\.`;
  for (const a of ADMINS) {
    const cards = cardsTo(bot, a);
    assert.equal(cards.length, 1, `${a} gets the card`);
    assert.equal(cards[0].args.text, expected);
  }
  assert.equal(lastScreen(bot, ABDUL).text.split('\n')[0], '⏳ *Sent for approval*');
  assert.ok(!/Ask:/.test(lastScreen(bot, ABDUL).text));
  // the first signature keeps today's one-line ping to the others
  const from = bot.calls.length;
  await approveDm(bot, MUSA, id);
  for (const a of [KRISHNA, JOHN]) {
    assert.deepEqual(textsTo(bot, a, from), [`🔔 Request ${id} (record payment) has its first admin approval and needs a SECOND. Use the approval card in your chat.`]);
  }
  assert.equal(jsonOf(id).askWidenedAt, undefined);
  // the legacy typed door's card shape is the same builder, unchanged
  assert.equal(await approvalCards.buildPaymentCard({ customer: 'ABBA', amount: 50000, method: 'Bank — Zenith' }), legacyCard);
});

/* ── 9. names and chip sizes ──────────────────────────────────────────── */

test('PRC-2 #9: names with _ and * are escaped on every new card; every new chip fits 64 bytes', async () => {
  reset();
  NAMES[MUSA] = 'Mu_sa*';
  NAMES[ABDUL] = 'Ab_dul';
  const bot = createFakeBot();
  const id = await raise(bot, { amount: null, ask: 'Mu_sa*', customer: 'A_B*BA' });
  assert.equal(id.length, 36, 'a real-length request id');
  const receipt = lastScreen(bot, ABDUL).text;
  // review 1 — a name inside *bold* carries no backslash escape (Telegram
  // honours none there; an escaped * is a 400): a * closes and reopens it.
  assert.equal(receipt.split('\n')[0], '⏳ *Sent to Mu_sa*\\** for approval*');
  assert.match(receipt, /\nCustomer: \*A_B\*\\\*\*BA\*\n/);
  assert.match(receipt, /Ask: Mu\\_sa\\\*/);
  noEscapeInBold(receipt);
  const card = cardsTo(bot, MUSA)[0].args.text;
  assert.ok(card.startsWith(esc('🙋 Ab_dul asks YOU to approve this.')));
  assert.ok(card.includes(esc('🙋 Asked: Mu_sa*')));

  await approveDm(bot, MUSA, id, 71);
  const prompt = lastScreen(bot, MUSA).text;
  assert.match(prompt, /\nCustomer: \*A_B\*\\\*\*BA\*\n/);
  noEscapeInBold(prompt);
  assert.match(prompt, /Raised by: Ab\\_dul/);
  assert.match(prompt, /Ab\\_dul did not know the amount\. Type what A\\_B\\\*BA paid/);
  await controller.handleMessage(bot, msg(MUSA, '10000000000'));
  const check = lastScreen(bot, MUSA);
  assert.match(check.text, /\nCustomer: \*A_B\*\\\*\*BA\*\n/);
  noEscapeInBold(check.text);
  for (const c of check.chips) {
    const data = c.split('|')[1];
    assert.ok(Buffer.byteLength(data) <= 64, `${data} is ${Buffer.byteLength(data)} bytes`);
  }
  assert.ok(check.chips.some((c) => c.endsWith(`prc:ay:${id}:10000000000`)), 'the largest amount still fits');
  // the employee-side chips
  reset();
  const b2 = createFakeBot();
  await controller.handleCallbackQuery(b2, cb('act:payment_received', ABDUL));
  await controller.handleCallbackQuery(b2, cb('prc:c:0', ABDUL));
  await controller.handleCallbackQuery(b2, cb('prc:noamt', ABDUL));
  await controller.handleCallbackQuery(b2, cb('prc:m:0', ABDUL));
  for (const c of lastScreen(b2, ABDUL).chips) assert.ok(Buffer.byteLength(c.split('|')[1]) <= 64);
});

/* ── review 1 (16-Nov-2026) ───────────────────────────────────────────── */

test('PRC-2 review 1 #10: the second admin approves a typed amount only after seeing it — a stale "not entered" card records nothing', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot, { amount: null, ask: 'any' });
  assert.ok(cardsTo(bot, MUSA)[0].args.text.includes(esc('Amount: not entered — typed at the first approval')));
  await approveDm(bot, KRISHNA, id, 71);
  await controller.handleMessage(bot, msg(KRISHNA, '50000'));
  const promptId = sessionStore.get(KRISHNA).flowMessageId;
  let from = bot.calls.length;
  await controller.handleCallbackQuery(bot, stepCb(`prc:ay:${id}:50000`, KRISHNA, promptId, 71, dmChips(id)));
  assert.deepEqual(jsonOf(id).approvals, [KRISHNA]);
  // every other admin's card said "not entered": each gets the FULL card now, no ping
  for (const a of [MUSA, JOHN]) {
    const full = cardsTo(bot, a, from);
    assert.equal(full.length, 1, `${a} gets the full card`);
    assert.ok(full[0].args.text.startsWith(esc('🔏 1 of 2 — signed by Krishna. Yours is the second approval.')));
    assert.ok(full[0].args.text.includes(esc('Amount: 50,000 · entered by Krishna')));
    assert.ok(!textsTo(bot, a, from).some((t) => /needs a SECOND/.test(t)));
  }
  assert.equal(jsonOf(id).askWidenedAt, undefined, 'an un-asked request is not "widened"');

  // Musa taps ✅ Approve on his ORIGINAL card (the one that said "not entered")
  from = bot.calls.length;
  await approveDm(bot, MUSA, id, 72);
  assert.equal(statusOf(id), 'pending', 'nothing approved');
  assert.equal(BOOKED.length, 0);
  assert.deepEqual(toasts(bot, from), ['Check the amount first.']);
  const check = sentTo(bot, MUSA, from).pop();
  assert.equal(check.args.text, [
    '💵 *Payment received · check the amount*', '', 'Customer: *ABBA*', 'Amount: *50,000* · entered by Krishna', 'Paid by: Bank — Zenith',
    'Outstanding today: 120,000', 'After this payment: 70,000', '',
    'Krishna typed this amount. Check it before you approve.', 'Your approval records the payment.',
  ].join('\n'));
  assert.deepEqual(chipsOf(check), [`✅ Approve 50,000|prc:ok:${id}:50000`, `✖ Not now|prc:ax:${id}`]);
  assert.ok(Buffer.byteLength(`prc:ok:${id}:10000000000`) <= 64);

  // a forged figure, and the admin who typed it, are refused
  await controller.handleCallbackQuery(bot, stepCb(`prc:ok:${id}:90000`, MUSA, 73, 72, dmChips(id)));
  assert.equal(statusOf(id), 'pending');
  await controller.handleCallbackQuery(bot, stepCb(`prc:ok:${id}:50000`, KRISHNA, 74, 71, dmChips(id)));
  assert.equal(statusOf(id), 'pending');
  assert.match(toasts(bot).pop(), /You typed this amount — a different admin must check it/);

  from = bot.calls.length;
  await controller.handleCallbackQuery(bot, stepCb(`prc:ok:${id}:50000`, MUSA, 75, 72, dmChips(id)));
  assert.equal(statusOf(id), 'approved');
  assert.equal(BOOKED.length, 1);
  assert.equal(BOOKED[0].amount, 50000);
  const closing = bot.calls.slice(from).filter((c) => c.method === 'editMessageText' && c.args.opts.message_id === 75).pop();
  assert.equal(closing.args.text, '✅ 50,000 from ABBA is recorded.');
  assert.ok(bot.calls.slice(from).some((c) => c.method === 'editMessageReplyMarkup' && c.args.opts.message_id === 72), 'the card is sealed');
});

test('PRC-2 review 1 #11: two admins confirm different amounts at once — one figure, its own admin\'s signature, the other told', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot, { amount: null, ask: 'any' });
  await approveDm(bot, KRISHNA, id, 71);
  await controller.handleMessage(bot, msg(KRISHNA, '50000'));
  const pK = sessionStore.get(KRISHNA).flowMessageId;
  await approveDm(bot, MUSA, id, 72);
  await controller.handleMessage(bot, msg(MUSA, '90000'));
  const pM = sessionStore.get(MUSA).flowMessageId;
  // a slow sheet: every write yields, so both taps overlap
  const orig = approvalQueueRepository.updateActionJSON;
  approvalQueueRepository.updateActionJSON = async (rid, patch) => {
    await new Promise((r) => setTimeout(r, 5));
    return orig(rid, patch);
  };
  const from = bot.calls.length;
  try {
    await Promise.all([
      controller.handleCallbackQuery(bot, stepCb(`prc:ay:${id}:50000`, KRISHNA, pK, 71, dmChips(id))),
      controller.handleCallbackQuery(bot, stepCb(`prc:ay:${id}:90000`, MUSA, pM, 72, dmChips(id))),
    ]);
  } finally { approvalQueueRepository.updateActionJSON = orig; }
  const aj = jsonOf(id);
  assert.equal(aj.amount, 50000, 'the first tap\'s figure');
  assert.equal(aj.amountBy.id, KRISHNA);
  assert.deepEqual(aj.approvals, [KRISHNA], 'the signature belongs to the admin who typed the figure');
  assert.deepEqual(toasts(bot, from).filter((t) => /recorded/.test(t)), ['🔏 Approval 1 of 2 recorded.']);
  const kClose = bot.calls.slice(from).filter((c) => c.method === 'editMessageText' && c.args.opts.message_id === pK).pop();
  assert.equal(kClose.args.text, '✅ You entered 50,000 and gave approval 1 of 2. A second admin checks it.');
  const mClose = bot.calls.slice(from).filter((c) => c.method === 'editMessageText' && c.args.opts.message_id === pM).pop();
  assert.equal(mClose.args.text, 'Krishna already entered 50,000 for this payment. Open the card to approve or reject it.');
  assert.equal(statusOf(id), 'pending');
});

test('PRC-2 review 1 #12: an asked admin since removed from ADMIN_IDS — the others get the FULL card at the first signature', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot); // asks Musa: only Musa got the card
  assert.equal(cardsTo(bot, KRISHNA).length + cardsTo(bot, JOHN).length, 0);
  const saved = config.access.adminIds;
  config.access.adminIds = [KRISHNA, JOHN];
  try {
    const live = await approvalQueueRepository.getByRequestId(id);
    sessionStore.set(KRISHNA, { type: 'approvals_inbox_flow', step: 'items', category: 'finance', _items: [live], flowMessageId: 77 });
    const from = bot.calls.length;
    await controller.handleCallbackQuery(bot, cb(`abx:ok:${id}`, KRISHNA, 77));
    assert.deepEqual(jsonOf(id).approvals, [KRISHNA]);
    assert.ok(jsonOf(id).askWidenedAt);
    assert.equal(cardsTo(bot, JOHN, from).length, 1, 'John holds no card: he gets the full one');
    assert.ok(!textsTo(bot, JOHN, from).some((t) => /Use the approval card in your chat/.test(t)));
    assert.equal(sentTo(bot, MUSA, from).length, 0, 'the removed admin is not messaged');
  } finally { config.access.adminIds = saved; }
});

test('PRC-2 review 1 #13: a reminder within the first hour of a widened card never says "no answer for 0h"', async () => {
  reset({ REMINDER_HOURS_ADMIN: 1 });
  const bot = createFakeBot();
  const realSend = bot.sendMessage.bind(bot);
  bot.sendMessage = async (chatId, text, opts) => {
    if (String(chatId) === MUSA) throw new Error('Forbidden: bot was blocked by the user');
    return realSend(chatId, text, opts);
  };
  const id = await raise(bot);
  assert.ok(jsonOf(id).askWidenedAt);
  const NOW = Date.now();
  setCreatedAt(id, new Date(NOW - 20 * 60 * 1000).toISOString());
  approvalReminder._resetForTests();
  const from = bot.calls.length;
  await approvalReminder.sweepPending(bot, { now: NOW });
  for (const a of [KRISHNA, JOHN]) {
    const card = cardsTo(bot, a, from)[0];
    assert.ok(card, `${a} reminded`);
    assert.ok(card.args.text.startsWith(esc('⏰ Reminder — asked: Musa. Any admin may approve.')), card.args.text.split('\n')[0]);
    assert.ok(!/0h/.test(card.args.text));
  }
});

test('PRC-2 review 1 #14: the typed step after a restart — ✏️ Type the amount brings it back', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot, { amount: null });
  await approveDm(bot, MUSA, id, 71);
  const promptId = sessionStore.get(MUSA).flowMessageId;
  sessionStore.clear(MUSA); // a redeploy or the session's time-out
  await controller.handleMessage(bot, msg(MUSA, '50000'));
  assert.equal(jsonOf(id).amount, undefined, 'a number with no step records nothing');
  await controller.handleCallbackQuery(bot, stepCb(`prc:ae:${id}`, MUSA, promptId, 71, dmChips(id)));
  assert.equal(sessionStore.get(MUSA).step, 'admin_amount');
  await controller.handleMessage(bot, msg(MUSA, '50000'));
  assert.deepEqual(lastScreen(bot, MUSA).chips[0], `✅ Approve with 50,000|prc:ay:${id}:50000`);
});

test('PRC-2 review 1 #15: a receipt Telegram refuses after the request was raised never says "Could not send"', async () => {
  reset();
  const bot = createFakeBot();
  const realEdit = bot.editMessageText.bind(bot);
  const realSend = bot.sendMessage.bind(bot);
  const refuse = (t, o) => /Sent to/.test(String(t)) && o && o.parse_mode;
  bot.editMessageText = async (t, o) => { if (refuse(t, o)) throw new Error("ETELEGRAM: 400 Bad Request: can't parse entities"); return realEdit(t, o); };
  bot.sendMessage = async (c, t, o) => { if (refuse(t, o)) throw new Error("ETELEGRAM: 400 Bad Request: can't parse entities"); return realSend(c, t, o); };
  const id = await raise(bot);
  assert.equal(rows().length, 1);
  assert.equal(cardsTo(bot, MUSA).length, 1);
  const last = lastScreen(bot, ABDUL);
  assert.ok(!/Could not send/.test(last.text));
  assert.equal(last.text, `⏳ Sent to Musa for approval\n\nCustomer: ABBA\nRef ${approvalCards.shortRequestRef(id)}`);
  assert.ok(last.chips.some((c) => c.startsWith('🔔 Remind approvers|')));
  assert.ok(!sessionStore.get(ABDUL), 'the entry is over');
});

test('PRC-2 review 1 #16: the who-step tells two admins of one name apart, and names an unnamed one by the last four digits', async () => {
  reset();
  NAMES[KRISHNA] = 'Musa';
  delete NAMES[JOHN];
  const bot = createFakeBot();
  const pf = require(path.join(SRC, 'flows/paymentReceivedFlow'));
  const choices = await pf._internals.approverChoices(bot, ABDUL);
  assert.deepEqual(choices, [
    { id: KRISHNA, name: 'Musa 777' }, { id: MUSA, name: 'Musa 888' }, { id: JOHN, name: 'Admin 555' },
  ]);
});

test('PRC-2 review 1 #17: every signature names its amount; a completing approval whose signatures disagree with the row records nothing', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot, { amount: null, ask: 'any' });
  await approveDm(bot, KRISHNA, id, 71);
  await controller.handleMessage(bot, msg(KRISHNA, '50000'));
  const promptId = sessionStore.get(KRISHNA).flowMessageId;
  await controller.handleCallbackQuery(bot, stepCb(`prc:ay:${id}:50000`, KRISHNA, promptId, 71, dmChips(id)));
  const signed = jsonOf(id).signoffs;
  assert.equal(signed.length, 1);
  assert.equal(signed[0].id, KRISHNA);
  assert.equal(signed[0].amount, 50000, 'the signature carries the figure it was given for');

  // the row's figure is changed behind the signature (a hand edit, a lost write)
  const r = rowOf(id);
  r[2] = JSON.stringify({ ...jsonOf(id), amount: 90000 });
  const from = bot.calls.length;
  await approveDm(bot, MUSA, id, 72);
  await controller.handleCallbackQuery(bot, stepCb(`prc:ok:${id}:90000`, MUSA, 73, 72, dmChips(id)));
  assert.equal(statusOf(id), 'pending', 'nothing approved');
  assert.equal(BOOKED.length, 0);
  assert.ok(toasts(bot, from).some((t) => t === '⚠️ The approvals on this payment were given for different amounts — nothing was recorded. Reject it and raise it again.'));
});

test('PRC-2 review 1 #18: the typed amount is read back before the signature — a row that does not carry it approves nothing', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot, { amount: null, ask: 'any' });
  await approveDm(bot, KRISHNA, id, 71);
  await controller.handleMessage(bot, msg(KRISHNA, '50000'));
  const promptId = sessionStore.get(KRISHNA).flowMessageId;
  // the write "succeeds" but another admin's figure is what the sheet holds
  const orig = approvalQueueRepository.updateActionJSON;
  approvalQueueRepository.updateActionJSON = async (rid, patch) => {
    if (patch && patch.amountBy) return orig(rid, { ...patch, amount: 90000, amountBy: { id: MUSA, name: 'Musa', at: new Date().toISOString() } });
    return orig(rid, patch);
  };
  const from = bot.calls.length;
  try {
    await controller.handleCallbackQuery(bot, stepCb(`prc:ay:${id}:50000`, KRISHNA, promptId, 71, dmChips(id)));
  } finally { approvalQueueRepository.updateActionJSON = orig; }
  assert.deepEqual(jsonOf(id).approvals || [], [], 'no signature');
  assert.ok(toasts(bot, from).includes('⚠️ The amount on this payment changed while you typed — nothing was approved. Open the card again.'));
});

/* ── PRC-2 review 2 ───────────────────────────────────────────────────── */

test('PRC-2 review 2 #19: the same payment asked of a DIFFERENT admin seconds later is a new request — John gets his card, the receipt names John', async () => {
  reset();
  const bot = createFakeBot();
  const id1 = await raise(bot, { amount: '50000', ask: 'Musa' });
  const from = bot.calls.length;
  const id2 = await raise(bot, { amount: '50000', ask: 'John' });
  assert.notEqual(id2, id1, 'not merged into the request Musa was asked');
  assert.equal(rows().length, 2);
  assert.deepEqual(jsonOf(id1).askedAdmin, { id: MUSA, name: 'Musa' });
  assert.deepEqual(jsonOf(id2).askedAdmin, { id: JOHN, name: 'John' });
  assert.equal(cardsTo(bot, JOHN, from).length, 1, 'John gets the card');
  assert.match(lastScreen(bot, ABDUL).text, /^⏳ \*Sent to John for approval\*/);
  // the SAME admin asked again within the window is still one request
  const id3 = await raise(bot, { amount: '50000', ask: 'John' });
  assert.equal(id3, id2);
  assert.equal(rows().length, 2);
});

test('PRC-2 review 2 #20: a merged double tap names the admin its OWN row asked', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot, { amount: '50000', ask: 'Musa' });
  const orig = approvalGate.raise;
  // the gate hands back the first request (as a merged tap does)
  approvalGate.raise = async () => ({ ok: true, requestId: id, created: false, duplicate: true, doubleTap: true, actionJSON: jsonOf(id) });
  try {
    await raise(bot, { amount: '50000', ask: 'John' });
  } finally { approvalGate.raise = orig; }
  assert.match(lastScreen(bot, ABDUL).text, /^⏳ \*Sent to Musa for approval\*/);
});

test('PRC-2 review 2 #21: the admin\'s amount step waits 30 minutes, not the 5-minute default', async () => {
  reset();
  const bot = createFakeBot();
  const id = await raise(bot, { amount: null, ask: 'any' });
  await approveDm(bot, MUSA, id, 71);
  const s = sessionStore.get(MUSA);
  assert.equal(s.step, 'admin_amount');
  assert.equal(s.ttlMs, 30 * 60 * 1000);
  // a bad figure keeps the long clock
  await controller.handleMessage(bot, msg(MUSA, 'fifty'));
  assert.equal(sessionStore.get(MUSA).ttlMs, 30 * 60 * 1000);
});

test('PRC-2 review 2 #22: a decided payment record prints no "Date:" (not the day it is opened) and no "typed at the first approval"', async () => {
  reset();
  const blank = { action: 'record_payment', customer: 'ABBA', amountPending: true, method: 'Cash' };
  assert.equal(await approvalCards.buildCardFromActionJSON(blank, { decided: true }),
    'Record Payment Request\nCustomer: ABBA\nAmount: not entered\nMethod: Cash');
  assert.equal(await approvalCards.buildCardFromActionJSON({ ...blank, amountPending: undefined, amount: 50000, amountBy: { id: MUSA, name: 'Musa' } }, { decided: true }),
    'Record Payment Request\nCustomer: ABBA\nAmount: 50,000 · entered by Musa\nMethod: Cash');
  // a pending card keeps its Date line (the day the payment would be booked)
  assert.match(await approvalCards.buildCardFromActionJSON(blank), new RegExp(`\\nDate: ${fmtDate(todayInLagos())}\\n`));
});
