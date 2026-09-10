'use strict';

/**
 * PAY-1 + PAY-2 end to end, through the REAL controller — the owner's
 * hand-drawn system design (14-Aug-2026) walked from first tap to money
 * marked paid, with the 09-Sep-2026 lifecycle drawn over it.
 *
 *   register an account (dual-admin) → raise a payment against it
 *   (amount → REASON → bill → confirm; dual-admin) → the finance seat
 *   pays at the bank → Mark Done: the Paid notice reaches the requester AND
 *   both signers and every finance-card copy loses its buttons, at the tap
 *   → proof (follows as a captioned picture to the same three) or skip.
 *
 * Pinned, in the order the risks actually bite:
 *  - a payment can only ever name an APPROVED account (the register is
 *    the safety, because a wrong number is an unrecoverable transfer);
 *  - the account number is typed twice and a mismatch restarts it;
 *  - every payment carries a typed reason, 3–120 characters, no skip
 *    (PAY-2 §2 A) — on the confirm card, the payload, and Postgres;
 *  - both writes queue for dual-admin — nothing is written live;
 *  - the finance card carries the owner's layout, and the ⚠ badge shows
 *    only above ₦50,000;
 *  - Mark Done and Decline belong to the finance seat, and refuse
 *    anyone else — including an admin;
 *  - Mark Done refuses a payment that is not approved (no paying twice,
 *    no paying something still awaiting a signature);
 *  - the Paid / Declined notices are PLAIN TEXT (PAY-2 §2 I) and reach
 *    the requester and both signers; the card buttons are wiped.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '7430648262';
delete process.env.FINANCE_IDS;

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
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const accountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
const requestsRepo = require(path.join(SRC, 'repositories/paymentRequestsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const reasonsRepo = require(path.join(SRC, 'repositories/paymentReasonsRepository'));
const eventsRepo = require(path.join(SRC, 'repositories/paymentEventsRepository'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const paymentCards = require(path.join(SRC, 'services/paymentCards'));

const ABDUL = '7430648262';
const OFFICE = '8896799323';
const ADMIN = '777';
const AJEET = '777';
const JOHN = '888';

let ACCOUNTS = [];
let REQUESTS = [];
let QUEUED = [];
let REASONS = [];
let EVENTS = [];

const NAMES = { [ABDUL]: 'Abdul', [OFFICE]: 'Office', [AJEET]: 'Ajeet', [JOHN]: 'John' };

usersRepository.getAll = async () => [
  { user_id: ABDUL, name: 'Abdul', departments: ['Sales'], department: 'Sales', status: 'active' },
  { user_id: OFFICE, name: 'Office', departments: ['Finance'], department: 'Finance', status: 'active', role: 'marketer' },
];
settingsRepository.getAll = async () => ({ BANK_LIST: 'GTBank,Zenith,Access' });
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);
auditLogRepository.append = async () => {};
approvalEvents.notifyAdminsApprovalRequest = async () => ({ sent: 1, failed: 0 });
approvalQueueRepository.append = async (row) => { QUEUED.push(row); return row; };
approvalQueueRepository.getByRequestId = async (id) => QUEUED.find((q) => q.requestId === id) || null;
approvalQueueRepository.getAllWithRowIndex = async () => QUEUED.map((q, i) => ({ ...q, rowIndex: i + 2 }));

// PAY-2 §1 — the two Postgres trails, stubbed as in-memory rows.
reasonsRepo.record = async (a) => { REASONS.push(a); return REASONS.length; };
reasonsRepo.forPayment = async (id) => {
  const r = REASONS.find((x) => x.paymentId === id);
  return r ? { payment_id: id, reason_text: r.reasonText } : null;
};
eventsRepo.record = async (e) => { EVENTS.push(e); return EVENTS.length; };
eventsRepo.forPayment = async (id) => EVENTS.filter((e) => e.paymentId === id)
  .map((e) => ({ kind: e.kind, actor_id: e.actorId, actor_name: e.actorName, chat_id: e.chatId, message_id: e.messageId, detail: e.detail || {} }));
eventsRepo.financeCardsFor = async (id) => EVENTS
  .filter((e) => e.paymentId === id && ['finance_card_sent', 'reminder_sent'].includes(e.kind) && e.messageId)
  .map((e) => ({ chat_id: e.chatId, message_id: e.messageId }));

accountsRepo.append = async (e) => {
  const saved = { ...e, account_id: e.account_id || `PAC-${ACCOUNTS.length + 1}`, rowIndex: ACCOUNTS.length + 2 };
  ACCOUNTS.push(saved);
  return saved;
};
accountsRepo.findLive = async (num, bank) => ACCOUNTS.find(
  (a) => a.status !== 'inactive'
    && String(a.account_number).replace(/\D/g, '') === String(num).replace(/\D/g, '')
    && String(a.bank).toLowerCase() === String(bank).toLowerCase()) || null;
accountsRepo.activeForTelegramId = async (id) => ACCOUNTS.filter(
  (a) => a.status === 'active' && a.owner_telegram_id === String(id));
accountsRepo.activeContractors = async () => ACCOUNTS.filter(
  (a) => a.status === 'active' && a.owner_type === 'contractor');

requestsRepo.append = async (e) => {
  const saved = { ...e, payment_id: e.payment_id || `PAY-${REQUESTS.length + 1}`, raised_at: '2026-08-14T17:20:00.000Z' };
  REQUESTS.push(saved);
  return saved;
};
requestsRepo.findById = async (id) => REQUESTS.find((p) => p.payment_id === id) || null;
requestsRepo.update = async (id, patch) => {
  const row = REQUESTS.find((p) => p.payment_id === id);
  if (row) Object.assign(row, patch);
  return row;
};
requestsRepo.forRaiser = async (id) => REQUESTS.filter((p) => p.raised_by === String(id));
requestsRepo.awaitingPayment = async () => REQUESTS.filter((p) => p.status === 'approved')
  .sort((a, b) => String(a.raised_at).localeCompare(String(b.raised_at)));

function reset() {
  ACCOUNTS = []; REQUESTS = []; QUEUED = []; REASONS = []; EVENTS = [];
  sessionStore.clear(ABDUL); sessionStore.clear(OFFICE); sessionStore.clear(ADMIN); sessionStore.clear(JOHN);
}
const msg = (uid, text) => ({ chat: { id: uid }, from: { id: uid, first_name: 'X' }, text });
const photoMsg = (uid, fileId) => ({ chat: { id: uid }, from: { id: uid, first_name: 'X' }, photo: [{ file_id: 'small' }, { file_id: fileId }] });
const lastText = (bot) => {
  const t = bot.calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
  return t.length ? String(t[t.length - 1].args.text) : '';
};
const dmsTo = (bot, id) => bot.callsTo('sendMessage').filter((c) => String(c.args.chatId) === String(id));
/** The finance chat's own last card (the notices to others come after it). */
const lastTo = (bot, id) => {
  const t = bot.calls.filter((c) => (c.method === 'sendMessage' && String(c.args.chatId) === String(id))
    || (c.method === 'editMessageText' && String(c.args.opts.chat_id) === String(id)));
  return t.length ? String(t[t.length - 1].args.text) : '';
};

/** Register + approve an account so payment tests have somewhere to pay. */
async function registerApproved(overrides = {}) {
  const saved = await accountsRepo.append({
    owner_name: 'Abdul', owner_type: 'employee', owner_telegram_id: ABDUL,
    account_number: '0123456789', bank: 'GTBank', status: 'active', ...overrides,
  });
  return saved;
}

/** An approved payment as the executor leaves it (the pair in approved_by), with its queue row. */
function seedApproved(overrides = {}) {
  REQUESTS.push({
    payment_id: 'PAY-9', payee_name: 'Abdul', payee_type: 'employee', amount_ngn: 4000,
    account_number: '7048940378', bank: 'OPAY', status: 'approved', raised_by: ABDUL,
    raised_at: '2026-09-09T13:32:00.000Z', approval_request_id: 'REQ-9',
    approved_by: 'Ajeet ‖ John', ...overrides,
  });
  QUEUED.push({
    requestId: 'REQ-9', user: ABDUL, status: 'approved',
    actionJSON: {
      action: 'request_payment', payment_id: 'PAY-9', payee_name: 'Abdul', payee_type: 'employee',
      amount_ngn: 4000, account_number: '7048940378', bank: 'OPAY', reason: 'Transport to Idumota',
      approvals: [AJEET],
    },
  });
}

/** The executor's trail row, as the other half of PAY-2 writes it. */
function seedApprovedEvent() {
  EVENTS.push({
    paymentId: 'PAY-9', approvalRequestId: 'REQ-9', kind: 'approved', actorId: JOHN, actorName: 'John',
    chatId: JOHN, messageId: '', detail: { approverIds: [AJEET, JOHN], approverLabel: 'Ajeet ‖ John' },
  });
}

/* ── registering an account ── */

test('PAY-1: the account number is typed TWICE, and a mismatch starts it over', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:reg', ABDUL));
  assert.match(lastText(bot), /10-digit account number/);

  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  assert.match(lastText(bot), /type it again|once more/i, 'it asks a second time');

  await controller.handleMessage(bot, msg(ABDUL, '0123456780'));   // one digit off
  assert.match(lastText(bot), /did not match/i);
  assert.equal(sessionStore.get(ABDUL).step, 'reg_number', 'back to the first entry, nothing kept');

  // Correct pair now walks on to the bank.
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  assert.match(lastText(bot), /Which bank/);
});

test('PAY-1: a registration queues for dual admin and writes nothing live', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:reg', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  await controller.handleCallbackQuery(bot, cb('pay:bank:0', ABDUL));
  assert.match(lastText(bot), /Register this account\?/);
  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));

  assert.equal(QUEUED.length, 1);
  assert.equal(QUEUED[0].actionJSON.action, 'register_payment_account');
  assert.equal(ACCOUNTS.length, 1);
  assert.equal(ACCOUNTS[0].status, 'pending',
    'the account exists but is NOT payable until two admins sign it');
  assert.match(lastText(bot), /Sent for approval/);
});

test('PAY-1: the same account cannot be registered twice', async () => {
  reset();
  await registerApproved();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:reg', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  await controller.handleMessage(bot, msg(ABDUL, '0123456789'));
  await controller.handleCallbackQuery(bot, cb('pay:bank:0', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
  assert.match(lastText(bot), /Already registered/);
  assert.equal(QUEUED.length, 0, 'two rows meaning one destination would be a trap');
});

/* ── raising a payment ── */

test('PAY-1: with no approved account there is nothing to pay into', async () => {
  reset();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:req', ABDUL));
  assert.match(lastText(bot), /No approved account/);
  assert.match(lastText(bot), /Register an account first/);
});

test('PAY-2: after the amount comes the REASON — 3 to 120 characters, no skip', async () => {
  reset();
  await registerApproved();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:req', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:acct:0', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '4000'));

  const card = lastText(bot);
  assert.match(card, /📝 \*What is this payment for\?\*/, 'the owner-approved card');
  assert.match(card, /Type a short reason — e\.g\. transport to Idumota, loading at the warehouse\./);
  assert.match(card, /🏦 GTBank 0123456789 · ₦4,000/, 'account and amount restated above the question');
  assert.equal(sessionStore.get(ABDUL).step, 'req_reason');
  const kb = bot.calls.filter((c) => c.args.opts && c.args.opts.reply_markup).pop().args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(!kb.some((b) => /skip/i.test(b.text)), 'no skip chip — every payment must be tagged');

  await controller.handleMessage(bot, msg(ABDUL, 'no'));
  assert.match(lastText(bot), /^⚠️ Give a reason of 3 to 120 characters\./, 'the one-line refusal on top');
  assert.match(lastText(bot), /What is this payment for/, 'same card underneath');
  assert.equal(sessionStore.get(ABDUL).step, 'req_reason', 'still on the reason');

  await controller.handleMessage(bot, msg(ABDUL, 'x'.repeat(121)));
  assert.match(lastText(bot), /Give a reason of 3 to 120 characters/, 'too long is refused too');

  await controller.handleMessage(bot, msg(ABDUL, '  Transport to Idumota  '));
  assert.equal(sessionStore.get(ABDUL).req.reason, 'Transport to Idumota', 'trimmed');
  assert.match(lastText(bot), /bill or invoice/i, 'then the paperwork step, as before');
});

test('PAY-1/2: a payment picks a registered account, carries its reason, then queues for dual admin', async () => {
  reset();
  await registerApproved();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:req', ABDUL));
  assert.match(lastText(bot), /Pay into which account/);

  await controller.handleCallbackQuery(bot, cb('pay:acct:0', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '45000'));
  await controller.handleMessage(bot, msg(ABDUL, 'Transport to Idumota'));
  assert.match(lastText(bot), /bill or invoice/i, 'paperwork is offered');
  await controller.handleCallbackQuery(bot, cb('pay:bill:skip', ABDUL));
  assert.match(lastText(bot), /₦45,000/);
  assert.match(lastText(bot), /💰 \*₦45,000\*\n📝 Transport to Idumota/, 'the reason sits under the amount on the confirm card');
  assert.ok(!/large payment/.test(lastText(bot)), '₦45,000 is under the line');

  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
  assert.equal(QUEUED.length, 1);
  assert.equal(QUEUED[0].actionJSON.action, 'request_payment');
  assert.equal(QUEUED[0].actionJSON.payee_type, 'employee',
    'the queue row carries the payee kind so the inbox rebuild prints the notify-time card, not "(?)"');
  assert.equal(QUEUED[0].actionJSON.reason, 'Transport to Idumota', 'the reason rides the payload (PAY-2 §1)');
  assert.equal(QUEUED[0].actionJSON.bill_file_id, '', 'and so does the bill slot, even when empty');
  assert.equal(REQUESTS[0].status, 'pending_approval');
  assert.equal(REQUESTS[0].amount_ngn, 45000);
  assert.equal(REQUESTS[0].account_number, '0123456789',
    'the account is SNAPSHOT, so a later edit cannot rewrite what was paid');
  assert.equal(REQUESTS[0].reason, 'Transport to Idumota',
    'the reason lands in the sheet row at raise (column S — owner ruling 10-Sep-2026: the sheet is the complete record)');

  // Postgres, after the sheet writes (fail-open).
  assert.equal(REASONS.length, 1);
  assert.deepEqual(REASONS[0], {
    paymentId: 'PAY-1', approvalRequestId: QUEUED[0].requestId, requesterId: ABDUL, requesterName: 'Abdul',
    payeeName: 'Abdul', payeeType: 'employee', amountNgn: 45000, reasonText: 'Transport to Idumota',
  });
  const raised = EVENTS.find((e) => e.kind === 'raised');
  assert.ok(raised, 'a raised event');
  assert.equal(raised.paymentId, 'PAY-1');
  assert.equal(raised.actorId, ABDUL);
  assert.equal(raised.actorName, 'Abdul');
});

test('PAY-2: a bill sent at raise rides the payload so admins can be forwarded it', async () => {
  reset();
  await registerApproved();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:req', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:acct:0', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '4000'));
  await controller.handleMessage(bot, msg(ABDUL, 'Loading at the warehouse'));
  await controller.handleFileMessage(bot, photoMsg(ABDUL, 'BILL-1'));
  assert.match(lastText(bot), /📎 Bill attached/);
  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
  assert.equal(QUEUED[0].actionJSON.bill_file_id, 'BILL-1');
  assert.equal(REQUESTS[0].bill_file_id, 'BILL-1');
});

test('PAY-2: a Postgres outage never blocks a request', async () => {
  reset();
  await registerApproved();
  const origR = reasonsRepo.record;
  const origE = eventsRepo.record;
  reasonsRepo.record = async () => { throw new Error('pg down'); };
  eventsRepo.record = async () => { throw new Error('pg down'); };
  try {
    const bot = createFakeBot();
    await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
    await controller.handleCallbackQuery(bot, cb('pay:start:req', ABDUL));
    await controller.handleCallbackQuery(bot, cb('pay:acct:0', ABDUL));
    await controller.handleMessage(bot, msg(ABDUL, '4000'));
    await controller.handleMessage(bot, msg(ABDUL, 'Airtime'));
    await controller.handleCallbackQuery(bot, cb('pay:bill:skip', ABDUL));
    await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
    assert.match(lastText(bot), /Sent for approval/, 'the sheet path completed');
    assert.equal(QUEUED[0].actionJSON.reason, 'Airtime', 'the payload copy is the fallback record');
  } finally {
    reasonsRepo.record = origR;
    eventsRepo.record = origE;
  }
});

test('PAY-1: ₦50,000 and above is badged as large, on the way in', async () => {
  reset();
  await registerApproved();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:req', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:acct:0', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, '50000'));
  await controller.handleMessage(bot, msg(ABDUL, 'Generator diesel'));
  await controller.handleCallbackQuery(bot, cb('pay:bill:skip', ABDUL));
  assert.match(lastText(bot), /large payment/, 'unmissable, exactly at the line');
  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
  assert.equal(REQUESTS[0].above_threshold, true);
});

/* ── the finance card ── */

test('PAY-1/2: the finance card carries the owner\'s layout — pair, reason, requester by name', () => {
  const text = paymentCards.buildFinanceCard({
    payment_id: 'PAY-1', payee_name: 'Yerima', payee_type: 'employee',
    account_number: '0123456789', bank: 'GTBank', amount_ngn: 45000,
    above_threshold: false, approved_by: 'Ajeet ‖ John',
    raised_by: ABDUL, raised_by_name: 'Yerima', raised_at: '2026-08-14T17:20:00.000Z',
  }, { ok: true }, { reason: 'Transport to Idumota' });
  assert.match(text, /💳 \*Payment\* — Yerima · employee/);
  assert.match(text, /🏦 0123456789 · GTBank/);
  assert.match(text, /💰 \*₦45,000\*\n📝 Transport to Idumota/, 'the reason under the amount');
  assert.match(text, /✅ Approved: Ajeet ‖ John/);
  assert.match(text, /_Raised by Yerima · 14-Aug-2026, 18:20_/, 'a name, never a raw id');
  assert.ok(!/large payment/.test(text), 'no badge under the line');

  const big = paymentCards.buildFinanceCard({
    payment_id: 'PAY-2', payee_name: 'Mason', payee_type: 'contractor',
    account_number: '9', bank: 'Zenith', amount_ngn: 250000, above_threshold: true,
    bill_file_id: 'FILE', raised_by: ABDUL, raised_at: '2026-08-14T17:20:00.000Z',
  }, { ok: true });
  assert.match(big, /💰 \*₦250,000\* {4}⚠️ large payment/, 'the badge qualifies the amount');
  assert.match(big, /📎 Bill attached/);
  assert.doesNotMatch(big, /📝/, 'no reason line when none is known');
});

test('PAY-1: a misconfigured Finance department is said out loud on the card', () => {
  const text = paymentCards.buildFinanceCard(
    { payment_id: 'P', payee_name: 'X', payee_type: 'employee', amount_ngn: 1, raised_by: ABDUL, raised_at: '' },
    { ok: false, reason: 'no_finance_member', members: 0 });
  assert.match(text, /No one is in the Finance department/);
});

/* ── executing ── */

test('PAY-1: only the one finance id may Mark Done — an ADMIN cannot', async () => {
  reset();
  seedApproved();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pay:done:PAY-9', ADMIN));
  const ack = bot.callsTo('answerCallbackQuery').pop();
  assert.match(ack.args.opts.text, /Only the finance person/);
  assert.equal(REQUESTS[0].status, 'approved', 'nothing moved');
});

const PAID_NOTICE = (doneAt) => [
  '💸 Paid — ₦4,000 to Abdul (employee)',
  '📝 Transport to Idumota',
  '🏦 OPAY 7048940378',
  `Paid by Office · ${doneAt}`,
  'Ref PAY-9 · approved by Ajeet ‖ John',
].join('\n');

test('PAY-2: at the ✔ tap — row done, buttons wiped, Paid notice to the three, events — THEN the proof prompt', async () => {
  reset();
  seedApproved();
  seedApprovedEvent();
  // Two finance-card copies the trail knows about (one is the tapped one).
  EVENTS.push({ paymentId: 'PAY-9', kind: 'finance_card_sent', chatId: OFFICE, messageId: '4321' });
  EVENTS.push({ paymentId: 'PAY-9', kind: 'reminder_sent', chatId: OFFICE, messageId: '4400' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pay:done:PAY-9', OFFICE, 4321));

  assert.equal(REQUESTS[0].status, 'done');
  assert.equal(REQUESTS[0].done_by, OFFICE, 'the hand that moved the money is on the record');
  assert.ok(REQUESTS[0].done_at, 'and when');

  // The Paid notice, plain text, to the requester AND both signers — already.
  const expected = PAID_NOTICE(REQUESTS[0].done_at);
  for (const id of [ABDUL, AJEET, JOHN]) {
    const dms = dmsTo(bot, id);
    assert.equal(dms.length, 1, `exactly one notice to ${id}`);
    assert.equal(dms[0].args.text, expected, `the spec §2 D text, verbatim, to ${id}`);
    assert.equal(dms[0].args.opts, undefined, 'plain text — no parse_mode (§2 I)');
  }
  assert.equal(dmsTo(bot, OFFICE).filter((c) => /💸 Paid/.test(c.args.text)).length, 0, 'finance is not DM\'d its own notice');

  // Every finance-card copy the trail knows loses its buttons (the tapped one once).
  const wipes = bot.callsTo('editMessageReplyMarkup');
  assert.deepEqual(
    wipes.map((w) => `${w.args.opts.chat_id}:${w.args.opts.message_id}`).sort(),
    [`${OFFICE}:4321`, `${OFFICE}:4400`].sort(),
  );
  assert.ok(wipes.every((w) => w.args.replyMarkup.inline_keyboard.length === 0));

  // Order: wipes and notices before the prompt.
  const idx = (pred) => bot.calls.findIndex(pred);
  const promptAt = idx((c) => c.method === 'sendMessage' && /Proof of transfer\?/.test(c.args.text));
  assert.ok(promptAt > 0, 'the prompt was shown');
  assert.ok(idx((c) => c.method === 'editMessageReplyMarkup') < promptAt, 'wiped before the prompt');
  assert.ok(idx((c) => c.method === 'sendMessage' && String(c.args.chatId) === JOHN) < promptAt, 'told before the prompt');

  // The trail: done + notified, both before the prompt is answered.
  assert.deepEqual(EVENTS.filter((e) => e.kind === 'done' || e.kind === 'notified').map((e) => e.kind), ['done', 'notified']);
  const notified = EVENTS.find((e) => e.kind === 'notified');
  assert.deepEqual(notified.detail, { notice: 'paid', to: [ABDUL, AJEET, JOHN], proof: false });

  // Then the proof prompt, exactly as before.
  assert.match(lastTo(bot, OFFICE), /📎 \*Proof of transfer\?\*/);
  assert.match(lastTo(bot, OFFICE), /Send a screenshot of the bank transfer, or skip\./);
  assert.match(lastTo(bot, OFFICE), /₦4,000 → Abdul · `PAY-9`/);
  const kb = bot.calls.filter((c) => c.args.opts && c.args.opts.reply_markup).pop().args.opts.reply_markup.inline_keyboard.flat();
  assert.deepEqual(kb.map((b) => b.callback_data), ['pay:proof:skip']);
  assert.equal(sessionStore.get(OFFICE).step, 'done_proof');
});

test('PAY-2: Skip → nothing more — exactly one message each, no proof written', async () => {
  reset();
  seedApproved();
  seedApprovedEvent();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pay:done:PAY-9', OFFICE, 4321));
  const before = bot.calls.length;
  await controller.handleCallbackQuery(bot, cb('pay:proof:skip', OFFICE));

  assert.equal(REQUESTS[0].proof_file_id, undefined, 'no proof written when skipped');
  assert.match(lastTo(bot, OFFICE), /✅ \*Paid\* — ₦4,000 to Abdul/, 'the finance chat confirmation closes the prompt');
  assert.doesNotMatch(lastTo(bot, OFFICE), /Proof attached/);
  for (const id of [ABDUL, AJEET, JOHN]) {
    assert.equal(dmsTo(bot, id).length, 1, `still exactly one message to ${id}`);
  }
  assert.equal(bot.callsTo('sendPhoto').length, 0);
  assert.equal(bot.callsTo('sendDocument').length, 0);
  assert.equal(bot.calls.slice(before).filter((c) => c.method === 'editMessageReplyMarkup').length, 0, 'wipes happened at the tap, not now');
  assert.equal(EVENTS.filter((e) => e.kind === 'notified').length, 1, 'no second notified event');
  assert.equal(sessionStore.get(OFFICE), null, 'the flow is over');
});

test('PAY-2: a proof photo lands on column O and FOLLOWS the Paid notice to the same three people', async () => {
  reset();
  seedApproved();
  seedApprovedEvent();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pay:done:PAY-9', OFFICE, 4321));
  const noticeAt = bot.calls.findIndex((c) => c.method === 'sendMessage' && String(c.args.chatId) === ABDUL);
  await controller.handleFileMessage(bot, photoMsg(OFFICE, 'PROOF-1'));

  assert.equal(REQUESTS[0].proof_file_id, 'PROOF-1', 'the existing column O, written for the first time');
  assert.match(lastTo(bot, OFFICE), /📎 Proof attached/);
  const photos = bot.callsTo('sendPhoto');
  assert.deepEqual(photos.map((p) => String(p.args.chatId)).sort(), [ABDUL, AJEET, JOHN].sort(), 'the same three');
  for (const p of photos) {
    assert.equal(p.args.photo, 'PROOF-1');
    assert.equal(p.args.opts.caption, '📎 Proof of transfer — PAY-9 · ₦4,000 to Abdul (employee)');
    assert.equal(p.args.opts.parse_mode, undefined, 'plain caption');
  }
  assert.ok(bot.calls.findIndex((c) => c.method === 'sendPhoto') > noticeAt, 'the Paid notice reached them before any proof');
  for (const id of [ABDUL, AJEET, JOHN]) {
    assert.equal(dmsTo(bot, id).length, 1, 'the text notice went once, at the tap');
    assert.equal(dmsTo(bot, id)[0].args.text, PAID_NOTICE(REQUESTS[0].done_at));
  }
  const notified = EVENTS.filter((e) => e.kind === 'notified');
  assert.equal(notified.length, 2);
  assert.deepEqual(notified[0].detail, { notice: 'paid', to: [ABDUL, AJEET, JOHN], proof: false });
  assert.deepEqual(notified[1].detail, { notice: 'proof', to: [ABDUL, AJEET, JOHN], proof: true });
});

test('PAY-2: a PDF proof follows as a document', async () => {
  reset();
  seedApproved();
  seedApprovedEvent();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pay:done:PAY-9', OFFICE, 4321));
  await controller.handleFileMessage(bot, { chat: { id: OFFICE }, from: { id: OFFICE }, document: { file_id: 'PDF-1', mime_type: 'application/pdf' } });
  assert.equal(REQUESTS[0].proof_file_id, 'PDF-1');
  const docs = bot.callsTo('sendDocument');
  assert.deepEqual(docs.map((d) => String(d.args.chatId)).sort(), [ABDUL, AJEET, JOHN].sort());
  assert.equal(docs[0].args.doc, 'PDF-1');
  assert.equal(docs[0].args.opts.caption, '📎 Proof of transfer — PAY-9 · ₦4,000 to Abdul (employee)');
  assert.equal(bot.callsTo('sendPhoto').length, 0);
});

test('PAY-2: without an approved event the signers come from the queue row itself', async () => {
  reset();
  seedApproved();            // no seedApprovedEvent(): Postgres knows nothing
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pay:done:PAY-9', OFFICE, 4321));
  assert.equal(dmsTo(bot, ABDUL).length, 1, 'the requester always hears — at the tap');
  assert.equal(dmsTo(bot, AJEET).length, 1, 'the first signature parked on actionJSON.approvals');
  assert.match(dmsTo(bot, ABDUL)[0].args.text, /📝 Transport to Idumota/, 'the reason read from the payload');
});

test('PAY-1: Mark Done refuses anything not currently approved', async () => {
  reset();
  REQUESTS.push({ payment_id: 'P1', status: 'pending_approval', amount_ngn: 1, payee_name: 'A', raised_by: ABDUL });
  REQUESTS.push({ payment_id: 'P2', status: 'done', amount_ngn: 1, payee_name: 'A', raised_by: ABDUL });
  const bot = createFakeBot();

  await controller.handleCallbackQuery(bot, cb('pay:done:P1', OFFICE));
  assert.match(bot.callsTo('answerCallbackQuery').pop().args.opts.text, /pending approval/,
    'a payment nobody signed cannot be paid');

  await controller.handleCallbackQuery(bot, cb('pay:done:P2', OFFICE));
  assert.match(bot.callsTo('answerCallbackQuery').pop().args.opts.text, /Already marked done/,
    'and it cannot be paid twice');
});

test('PAY-1/2: Decline needs a reason; the reason reaches the requester AND both signers, plain text', async () => {
  reset();
  seedApproved({ payment_id: 'PAY-7' });
  QUEUED[0].actionJSON.payment_id = 'PAY-7';
  EVENTS.push({
    paymentId: 'PAY-7', kind: 'approved', actorId: JOHN, detail: { approverIds: [AJEET, JOHN], approverLabel: 'Ajeet ‖ John' },
  });
  EVENTS.push({ paymentId: 'PAY-7', kind: 'finance_card_sent', chatId: OFFICE, messageId: '4321' });
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('pay:dec:PAY-7', OFFICE, 4321));
  assert.match(lastText(bot), /Why\?/);

  await controller.handleMessage(bot, msg(OFFICE, 'no'));
  assert.match(lastText(bot), /Give a reason/, 'a one-word brush-off is not a reason');
  assert.equal(REQUESTS[0].status, 'approved');

  await controller.handleMessage(bot, msg(OFFICE, 'Account name does not match the invoice'));
  assert.equal(REQUESTS[0].status, 'declined');
  assert.equal(REQUESTS[0].decline_reason, 'Account name does not match the invoice');
  assert.equal(REQUESTS[0].done_by, OFFICE);
  assert.match(lastTo(bot, OFFICE), /✖ \*Declined\* — ₦4,000 to Abdul/, 'the finance chat card');

  const expected = [
    '✖ Payment declined — ₦4,000 to Abdul (employee) was not paid.',
    '📝 Transport to Idumota',
    '🏦 OPAY 7048940378',
    `Declined by Office · ${REQUESTS[0].done_at}`,
    'Account name does not match the invoice',
    'Ref PAY-7 · approved by Ajeet ‖ John',
  ].join('\n');
  for (const id of [ABDUL, AJEET, JOHN]) {
    const dms = dmsTo(bot, id);
    assert.equal(dms.length, 1, `one notice to ${id}`);
    assert.equal(dms[0].args.text, expected);
    assert.equal(dms[0].args.opts, undefined, 'plain text — no parse_mode (§2 I)');
  }
  const wipes = bot.callsTo('editMessageReplyMarkup');
  assert.deepEqual(wipes.map((w) => `${w.args.opts.chat_id}:${w.args.opts.message_id}`), [`${OFFICE}:4321`]);
  assert.deepEqual(EVENTS.filter((e) => e.paymentId === 'PAY-7').map((e) => e.kind),
    ['approved', 'finance_card_sent', 'declined', 'notified']);
  assert.deepEqual(EVENTS.find((e) => e.kind === 'notified').detail, { notice: 'declined', to: [ABDUL, AJEET, JOHN] });
});

/* ── my requests ── */

test('PAY-1/2: My requests reports each one in plain words, with its reason', async () => {
  reset();
  // Three provenances: P1 carries its reason on the SHEET ROW (column S —
  // preferred, even over a differing payload), P2 only on the queue
  // payload (raised before column S), P3 only in Postgres.
  REQUESTS.push({ payment_id: 'P1', amount_ngn: 45000, status: 'done', raised_by: ABDUL, raised_at: '2026-08-14T10:00:00.000Z', approval_request_id: 'R1', reason: 'Airtime' });
  REQUESTS.push({ payment_id: 'P2', amount_ngn: 12000, status: 'pending_approval', raised_by: ABDUL, raised_at: '2026-08-14T11:00:00.000Z', approval_request_id: 'R2' });
  REQUESTS.push({ payment_id: 'P3', amount_ngn: 9000, status: 'declined', raised_by: ABDUL, raised_at: '2026-08-13T11:00:00.000Z', approval_request_id: 'R3', decline_reason: 'Account name does not match' });
  QUEUED.push({ requestId: 'R1', actionJSON: { action: 'request_payment', reason: 'Stale payload copy' } });
  QUEUED.push({ requestId: 'R2', actionJSON: { action: 'request_payment', reason: 'Transport to Idumota' } });
  REASONS.push({ paymentId: 'P3', reasonText: 'Fuel' });   // only Postgres knows this one
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:mine', ABDUL));
  const t = lastText(bot);
  assert.match(t, /✅ ₦45,000 — paid · 📝 Airtime/, 'the sheet row\'s own cell wins');
  assert.doesNotMatch(t, /Stale payload copy/);
  assert.match(t, /⏳ ₦12,000 — waiting for approval · 📝 Transport to Idumota/, 'the payload for a row with no cell');
  assert.match(t, /✖ ₦9,000 — declined by finance · 📝 Fuel/, 'the Postgres row when the sheet has none');
  assert.match(t, /Account name does not match/);
});

/* ── the finance queue (PAY-2 §2 H) ── */

test('PAY-2: the finance seat sees "Waiting for me to pay" on the hub; an employee does not', async () => {
  reset();
  seedApproved();
  REQUESTS.push({ payment_id: 'PAY-10', payee_name: 'Mason', payee_type: 'contractor', amount_ngn: 12000, status: 'approved', raised_by: ADMIN, raised_at: '2026-09-08T10:00:00.000Z' });
  REQUESTS.push({ payment_id: 'PAY-11', payee_name: 'Abdul', amount_ngn: 1, status: 'done', raised_by: ABDUL });
  const kbOf = (bot) => bot.calls.filter((c) => c.args.opts && c.args.opts.reply_markup).pop().args.opts.reply_markup.inline_keyboard.flat();

  const office = createFakeBot();
  await controller.handleCallbackQuery(office, cb('act:payments', OFFICE));
  const chip = kbOf(office).find((b) => b.callback_data === 'pay:start:wait');
  assert.ok(chip, 'the chip is there for the finance seat');
  assert.equal(chip.text, '💳 Waiting for me to pay (2)', 'approved and unpaid only');

  const abdul = createFakeBot();
  await controller.handleCallbackQuery(abdul, cb('act:payments', ABDUL));
  assert.ok(!kbOf(abdul).some((b) => b.callback_data === 'pay:start:wait'), 'not for a requester');

  await controller.handleCallbackQuery(office, cb('pay:start:wait', OFFICE));
  assert.match(lastText(office), /💳 \*Waiting for me to pay\*/);
  const items = kbOf(office).filter((b) => b.callback_data.startsWith('pay:wait:'));
  assert.equal(items.length, 2);
  assert.match(items[0].text, /₦12,000 → Mason · 08-Sep-26/, 'oldest first, the way a queue reads');
  assert.match(items[1].text, /₦4,000 → Abdul · 09-Sep-26 · Transport to Idumota/);
  assert.ok(items.every((b) => Buffer.byteLength(b.callback_data) <= 64));

  await controller.handleCallbackQuery(office, cb('pay:wait:1', OFFICE));
  const card = office.callsTo('sendMessage').filter((c) => String(c.args.chatId) === OFFICE).pop();
  assert.match(card.args.text, /💳 \*Payment\* — Abdul · employee/, 'the finance card, re-sent');
  assert.match(card.args.text, /📝 Transport to Idumota/);
  assert.match(card.args.text, /✅ Approved: Ajeet ‖ John/);
  assert.match(card.args.text, /_Raised by Abdul · /, 'by name');
  assert.deepEqual(card.args.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data),
    ['pay:done:PAY-9', 'pay:dec:PAY-9']);
  const sentEv = EVENTS.filter((e) => e.kind === 'finance_card_sent');
  assert.equal(sentEv.length, 1, 'the re-send is logged like the first send');
  assert.equal(sentEv[0].chatId, OFFICE);
  assert.match(String(sentEv[0].messageId), /^\d+$/, 'with the message id, so Done can wipe it');
});

test('PAY-2: the queue refuses anyone who cannot execute', async () => {
  reset();
  seedApproved();
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:wait', ABDUL));
  assert.match(lastText(bot), /for the finance seat/);
  assert.equal(bot.callsTo('sendMessage').filter((c) => /💳 \*Payment\*/.test(c.args.text)).length, 0);
});
