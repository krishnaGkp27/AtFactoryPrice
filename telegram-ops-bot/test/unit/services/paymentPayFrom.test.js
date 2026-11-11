'use strict';

/**
 * PAY-6 (owner, 11-Nov-2026) — the paying account on every payment.
 *
 * "The account through which the payment will go through shall also be
 * mentioned with the bank name, so that each transaction is clubbed with
 * the source and the recipient, both visible to Financer."
 *
 * The pure half: where the company's paying accounts come from, the chip
 * key that can never name another account, the picker, and every card
 * line — WITH a paying account, and byte-for-byte as before WITHOUT one.
 * The approval path itself is walked through the real controller in
 * test/characterization/paymentPayFrom.test.js.
 */

process.env.ADMIN_IDS = '777,888';
delete process.env.FINANCE_IDS;

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');
const { createFakeBot } = require('../../helpers/fakeBot');

installFakeSheets(createFakeSheets({}));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const paymentEventsRepository = require(path.join(SRC, 'repositories/paymentEventsRepository'));
const paymentService = require(path.join(SRC, 'services/paymentService'));
const paymentCards = require(path.join(SRC, 'services/paymentCards'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));

let SETTINGS = {};
settingsRepository.getAll = async () => {
  if (SETTINGS instanceof Error) throw SETTINGS;
  return { ...SETTINGS };
};

const ZENITH = { label: 'ZENITH — BLACK PANTHER', bank: 'ZENITH', account: 'BLACK PANTHER' };
const GTB = { label: 'GTBANK — BLACK PANTHER', bank: 'GTBANK', account: 'BLACK PANTHER' };
const REQUEST_ID = '3f2b8c1e-9a4d-4e6f-8b1a-0c9d7e6f5a4b'; // the shape idGenerator mints: 36 characters

/* ── 1. the list ───────────────────────────────────────────────────── */

test('PAY-6: PAYMENT_SOURCE_ACCOUNTS is the list — `;`, a new line and a comma all separate entries', async () => {
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: 'ZENITH — BLACK PANTHER; GTBANK — BLACK PANTHER\nOPAY — AFP LTD, Access - Black Panther\r\nPetty cash' };
  assert.deepEqual(await paymentService.sourceAccounts(), [
    ZENITH,
    GTB,
    { label: 'OPAY — AFP LTD', bank: 'OPAY', account: 'AFP LTD' },
    // a hyphen is read as the house dash, and stored the house way
    { label: 'Access — Black Panther', bank: 'Access', account: 'Black Panther' },
    // a plain name with no dash is accepted as written in THIS cell
    { label: 'Petty cash', bank: 'Petty cash', account: '' },
  ]);
});

test('PAY-6: entries are de-duplicated whatever the case or spacing, in the order written; empties are dropped', async () => {
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: ' ; ZENITH — BLACK PANTHER ;; zenith  —  black panther ,\n, GTBANK — BLACK PANTHER; Zenith - Black Panther ' };
  assert.deepEqual(await paymentService.sourceAccounts(), [ZENITH, GTB]);
  // "X — X" is the plain bank X (BANK-3), and so is one entry, not two.
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: 'OPAY — OPAY; OPAY' };
  assert.deepEqual(await paymentService.sourceAccounts(), [{ label: 'OPAY', bank: 'OPAY', account: '' }]);
});

test('PAY-6: a blank cell falls back to BANK_LIST — only the entries that NAME an account', async () => {
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: '', BANK_LIST: 'GTBank,ZENITH — BLACK PANTHER,Zenith,OPAY — OPAY,GTBANK — BLACK PANTHER,Access' };
  assert.deepEqual(await paymentService.sourceAccounts(), [ZENITH, GTB],
    'plain bank names are payee banks, never a company account');
  // The key missing altogether reads the same as blank.
  SETTINGS = { BANK_LIST: 'GTBank, ZENITH — BLACK PANTHER' };
  assert.deepEqual(await paymentService.sourceAccounts(), [ZENITH]);
  // The fallback is a fallback: a filled cell is the whole list.
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: 'GTBANK — BLACK PANTHER', BANK_LIST: 'ZENITH — BLACK PANTHER' };
  assert.deepEqual(await paymentService.sourceAccounts(), [GTB]);
});

test('PAY-6: nothing configured is an empty list — plain banks only, no banks, no Settings at all', async () => {
  for (const s of [{ BANK_LIST: 'GTBank,Zenith,Access' }, { BANK_LIST: '' }, { PAYMENT_SOURCE_ACCOUNTS: '  ' }, {}]) {
    SETTINGS = s;
    assert.deepEqual(await paymentService.sourceAccounts(), [], JSON.stringify(s));
  }
  settingsRepository.getAll = async () => null;
  try { assert.deepEqual(await paymentService.sourceAccounts(), []); } finally {
    settingsRepository.getAll = async () => { if (SETTINGS instanceof Error) throw SETTINGS; return { ...SETTINGS }; };
  }
});

test('PAY-6: a failing Settings read yields an empty list — never a throw', async () => {
  SETTINGS = new Error('quota exceeded');
  assert.deepEqual(await paymentService.sourceAccounts(), []);
});

test('PAY-6: a cell Settings handed over as a NUMBER is still read as written', async () => {
  // settingsRepository coerces a digits-only cell to a Number.
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: 1002 };
  assert.deepEqual(await paymentService.sourceAccounts(), [{ label: '1002', bank: '1002', account: '' }]);
});

/* ── 2. the chip key ───────────────────────────────────────────────── */

test('PAY-6: the chip key is the position plus a fingerprint of the label, and resolves to that account', () => {
  const list = [ZENITH, GTB];
  const k0 = paymentService.sourceAccountKey(list, 0);
  const k1 = paymentService.sourceAccountKey(list, 1);
  assert.match(k0, /^0\.[0-9a-f]{6}$/);
  assert.match(k1, /^1\.[0-9a-f]{6}$/);
  assert.notEqual(k0.slice(2), k1.slice(2), 'two labels, two fingerprints');
  assert.equal(paymentService.resolveSourceAccount(list, k0), ZENITH);
  assert.equal(paymentService.resolveSourceAccount(list, k1), GTB);
  assert.equal(paymentService.sourceAccountKey(list, 2), '', 'outside the list');
  // The fingerprint follows the label's meaning, not its typing.
  assert.equal(paymentService.sourceAccountKey([{ label: 'zenith  —  black panther' }], 0), k0);
});

test('PAY-6: a changed list does not resolve — the key can never name a different account', () => {
  const k0 = paymentService.sourceAccountKey([ZENITH, GTB], 0);
  const k1 = paymentService.sourceAccountKey([ZENITH, GTB], 1);
  const OPAY = { label: 'OPAY — AFP LTD', bank: 'OPAY', account: 'AFP LTD' };
  assert.equal(paymentService.resolveSourceAccount([OPAY, GTB], k0), null, 'the entry at that position was replaced');
  assert.equal(paymentService.resolveSourceAccount([GTB], k1), null, 'the list got shorter');
  assert.equal(paymentService.resolveSourceAccount([GTB, ZENITH], k0), null, 'the order changed');
  assert.equal(paymentService.resolveSourceAccount([], k0), null);
  // An entry added at the END moves nothing: the same account still resolves.
  assert.equal(paymentService.resolveSourceAccount([ZENITH, GTB, OPAY], k1), GTB);
  for (const bad of ['', '0', 'x', '0.zzzzzz', '0.52cf4', '-1.52cf4b', '0.52cf4b.1', null, undefined, '999.52cf4b']) {
    assert.equal(paymentService.resolveSourceAccount([ZENITH, GTB], bad), null, `malformed: ${bad}`);
  }
});

/* ── 3. the picker ─────────────────────────────────────────────────── */

const PAYLOAD = {
  action: 'request_payment', payment_id: 'PAY-1', payee_name: 'Abdul', payee_type: 'employee',
  amount_ngn: 25000, account_number: '0123456789', bank: 'GTBank', reason: 'Transport to Idumota',
};

test('PAY-6: the picker — the question, the payment, one chip per account and its own way out', () => {
  const list = [ZENITH, GTB];
  const picker = paymentCards.buildPayFromPicker(REQUEST_ID, PAYLOAD, list);
  assert.equal(picker.text, [
    '💳 *Pay from which account?*',
    '₦25,000 → Abdul · 0123456789 · GTBank',
    '📝 Transport to Idumota',
    '',
    '_You are giving the last approval. Finance will be told to pay from the account you tap._',
  ].join('\n'));
  assert.deepEqual(picker.reply_markup.inline_keyboard, [
    [{ text: '🏦 ZENITH — BLACK PANTHER', callback_data: `pay:from:${REQUEST_ID}:${paymentService.sourceAccountKey(list, 0)}` }],
    [{ text: '🏦 GTBANK — BLACK PANTHER', callback_data: `pay:from:${REQUEST_ID}:${paymentService.sourceAccountKey(list, 1)}` }],
    [{ text: '✖ Not now', callback_data: `pay:fromx:${REQUEST_ID}` }],
  ]);
  for (const row of picker.reply_markup.inline_keyboard) {
    assert.ok(Buffer.byteLength(row[0].callback_data) <= 64, `${row[0].callback_data} fits Telegram's 64 bytes`);
    assert.ok(/^[\x20-\x7e]+$/.test(row[0].callback_data), 'ASCII only');
  }
  // Even the twelfth account's chip fits.
  const twelve = Array.from({ length: 12 }, (_, i) => ({ label: `BANK ${i} — BLACK PANTHER` }));
  const last = paymentCards.buildPayFromPicker(REQUEST_ID, PAYLOAD, twelve).reply_markup.inline_keyboard[11][0];
  assert.ok(Buffer.byteLength(last.callback_data) <= 64);
});

test('PAY-6: the picker drops the reason line when there is none, escapes what it prints, and says when the list changed', () => {
  const noReason = paymentCards.buildPayFromPicker(REQUEST_ID, { ...PAYLOAD, reason: '' }, [ZENITH, GTB]);
  assert.equal(noReason.text, [
    '💳 *Pay from which account?*',
    '₦25,000 → Abdul · 0123456789 · GTBank',
    '',
    '_You are giving the last approval. Finance will be told to pay from the account you tap._',
  ].join('\n'));
  const odd = paymentCards.buildPayFromPicker(REQUEST_ID,
    { ...PAYLOAD, payee_name: 'Sani_Loader', bank: 'First*Bank', reason: 'Fuel [van]' }, [ZENITH, GTB]);
  assert.match(odd.text, /₦25,000 → Sani\\_Loader · 0123456789 · First\\\*Bank\n📝 Fuel \\\[van\\\]/);
  const changed = paymentCards.buildPayFromPicker(REQUEST_ID, PAYLOAD, [GTB], { changed: true });
  assert.equal(changed.text, [
    '⚠️ That list has changed — pick again.',
    '',
    '💳 *Pay from which account?*',
    '₦25,000 → Abdul · 0123456789 · GTBank',
    '📝 Transport to Idumota',
    '',
    '_You are giving the last approval. Finance will be told to pay from the account you tap._',
  ].join('\n'));
  assert.deepEqual(changed.reply_markup.inline_keyboard.map((r) => r[0].text), ['🏦 GTBANK — BLACK PANTHER', '✖ Not now']);
});

/* ── 4. the step the completing approval passes through ─────────────── */

const tap = (uid = '888', msgId = 72) => ({ id: 'cb', from: { id: uid }, message: { chat: { id: uid }, message_id: msgId } });
const ITEM = { requestId: REQUEST_ID, user: '4242', status: 'pending', actionJSON: PAYLOAD };

test('PAY-6: no account configured — the step says nothing, sends nothing, and hands back no account', async () => {
  SETTINGS = { BANK_LIST: 'GTBank,Zenith,Access' };
  const bot = createFakeBot();
  assert.deepEqual(await paymentCards.payFromStep(bot, tap(), REQUEST_ID, ITEM, undefined), { ask: false, payFrom: null });
  assert.equal(bot.calls.length, 0, 'not one Telegram call');
});

test('PAY-6: one account — stamped without asking, for the admin who tapped', async () => {
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: 'ZENITH — BLACK PANTHER' };
  const bot = createFakeBot();
  const step = await paymentCards.payFromStep(bot, tap('888'), REQUEST_ID, ITEM, undefined);
  assert.equal(step.ask, false);
  assert.equal(step.payFrom.label, 'ZENITH — BLACK PANTHER');
  assert.equal(step.payFrom.by, '888');
  assert.ok(!Number.isNaN(Date.parse(step.payFrom.at)), 'an ISO time');
  assert.equal(bot.calls.length, 0, 'one-option navigation: nothing is asked');
});

test('PAY-6: two accounts — the picker is a NEW message, the tap gets the toast, and the caller is told to stop', async () => {
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: 'ZENITH — BLACK PANTHER; GTBANK — BLACK PANTHER' };
  const bot = createFakeBot();
  assert.deepEqual(await paymentCards.payFromStep(bot, tap('888', 72), REQUEST_ID, ITEM, undefined), { ask: true });
  assert.deepEqual(bot.calls.map((c) => c.method), ['sendMessage', 'answerCallbackQuery']);
  const sent = bot.calls[0].args;
  assert.equal(String(sent.chatId), '888');
  assert.equal(sent.opts.parse_mode, 'Markdown');
  assert.equal(sent.text, paymentCards.buildPayFromPicker(REQUEST_ID, PAYLOAD, [ZENITH, GTB]).text);
  assert.deepEqual(bot.calls[1].args.opts, { text: 'Choose the account to pay from.', show_alert: false });
});

test('PAY-6: a chip whose key resolves hands back THAT account — even when it is now the only one', async () => {
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: 'ZENITH — BLACK PANTHER; GTBANK — BLACK PANTHER' };
  const key = paymentService.sourceAccountKey([ZENITH, GTB], 1);
  const bot = createFakeBot();
  const step = await paymentCards.payFromStep(bot, tap('888', 90), REQUEST_ID, ITEM, key);
  assert.equal(step.ask, false);
  assert.equal(step.payFrom.label, 'GTBANK — BLACK PANTHER');
  assert.equal(step.payFrom.by, '888');
  assert.equal(bot.calls.length, 0, 'the approval handler answers the tap, not the step');
});

test('PAY-6: a chip whose key no longer resolves stamps NOTHING — the picker is redrawn in place with the changed-list line', async () => {
  const staleKey = paymentService.sourceAccountKey([ZENITH, GTB], 0);
  // The list was edited under the open picker: one account is left, and it is not the one tapped.
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: 'GTBANK — BLACK PANTHER' };
  const bot = createFakeBot();
  assert.deepEqual(await paymentCards.payFromStep(bot, tap('888', 90), REQUEST_ID, ITEM, staleKey), { ask: true },
    'never the remaining account by default');
  assert.deepEqual(bot.calls.map((c) => c.method), ['answerCallbackQuery', 'editMessageText']);
  assert.equal(bot.calls[0].args.opts.text, 'That list has changed — pick again.');
  const edit = bot.calls[1].args;
  assert.equal(edit.opts.message_id, 90, 'the picker itself');
  assert.equal(edit.text, paymentCards.buildPayFromPicker(REQUEST_ID, PAYLOAD, [GTB], { changed: true }).text);
  assert.deepEqual(edit.opts.reply_markup.inline_keyboard.map((r) => r[0].text), ['🏦 GTBANK — BLACK PANTHER', '✖ Not now']);

  // An empty key (a malformed chip) is a picker tap all the same.
  const bot2 = createFakeBot();
  assert.deepEqual(await paymentCards.payFromStep(bot2, tap('888', 90), REQUEST_ID, ITEM, ''), { ask: true });
  assert.equal(bot2.callsTo('editMessageText').length, 1);

  // The list emptied altogether: nothing to pick, and still nothing approved.
  SETTINGS = { BANK_LIST: 'GTBank' };
  const bot3 = createFakeBot();
  assert.deepEqual(await paymentCards.payFromStep(bot3, tap('888', 90), REQUEST_ID, ITEM, staleKey), { ask: true });
  assert.equal(bot3.calls[0].args.opts.text, 'Nothing was approved.');
  assert.equal(bot3.calls[1].args.text,
    'That list has changed — no paying account is listed any more.\nNothing was approved. Tap ✅ Approve on the request again.');
  assert.deepEqual(bot3.calls[1].args.opts.reply_markup, { inline_keyboard: [] });
});

test('PAY-6: a picker that cannot be drawn stops the approval and says so — it is never approved without the choice', async () => {
  SETTINGS = { PAYMENT_SOURCE_ACCOUNTS: 'ZENITH — BLACK PANTHER; GTBANK — BLACK PANTHER' };
  const bot = createFakeBot();
  bot.sendMessage = async () => { throw new Error('telegram down'); };
  assert.deepEqual(await paymentCards.payFromStep(bot, tap(), REQUEST_ID, ITEM, undefined), { ask: true });
  const alerts = bot.callsTo('answerCallbackQuery');
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].args.opts, {
    text: '⚠️ Could not show the paying accounts — nothing was approved. Tap ✅ Approve again in a minute.',
    show_alert: true,
  });
});

/* ── 5. every card line, with and without ──────────────────────────── */

const ROW = {
  payment_id: 'PAY-20260909-3F9A2C1E', payee_name: 'Abdul', payee_type: 'employee',
  account_number: '7048940378', bank: 'OPAY', amount_ngn: 4000, above_threshold: false,
  raised_by: '7430648262', raised_by_name: 'Abdul', raised_at: '2026-09-09T13:32:00.000Z',
  approval_request_id: 'REQ-9', approved_by: 'Ajeet ‖ John', status: 'approved', bill_file_id: '',
};

test('PAY-6: the finance card shows From and To together when the payment carries its paying account', () => {
  const text = paymentCards.buildFinanceCard({ ...ROW, paid_from: 'ZENITH — BLACK PANTHER' }, { ok: true }, { reason: 'Transport to Idumota' });
  assert.equal(text, [
    '💳 *Payment* — Abdul · employee',
    '📤 From: ZENITH — BLACK PANTHER',
    '📥 To: 7048940378 · OPAY',
    '💰 *₦4,000*',
    '📝 Transport to Idumota',
    '✅ Approved: Ajeet ‖ John',
    '_Raised by Abdul · 09-Sep-2026, 14:32_',
    '`PAY-20260909-3F9A2C1E`',
  ].join('\n'));
  // The signer's copy keeps its PAY-4 sentence, and the label is escaped.
  const signer = paymentCards.buildFinanceCard({ ...ROW, paid_from: 'ZENITH — BLACK_PANTHER' }, { ok: true }, { reason: '', approvedIt: true });
  assert.match(signer, /📤 From: ZENITH — BLACK\\_PANTHER\n📥 To: 7048940378 · OPAY\n💰 \*₦4,000\*\n✅ Approved/);
  assert.match(signer, /You approved this one/);
});

test('PAY-6: a payment WITHOUT a paying account prints the finance card byte-for-byte as before', () => {
  const before = [
    '💳 *Payment* — Abdul · employee',
    '🏦 7048940378 · OPAY',
    '💰 *₦4,000*',
    '📝 Transport to Idumota',
    '✅ Approved: Ajeet ‖ John',
    '_Raised by Abdul · 09-Sep-2026, 14:32_',
    '`PAY-20260909-3F9A2C1E`',
  ].join('\n');
  for (const blank of [{}, { paid_from: '' }, { paid_from: undefined }, { paid_from: null }]) {
    assert.equal(paymentCards.buildFinanceCard({ ...ROW, ...blank }, { ok: true }, { reason: 'Transport to Idumota' }), before);
  }
});

test('PAY-6: the decided record names the paying account under Account; a pending request never does', async () => {
  const pending = {
    action: 'request_payment', amount_ngn: 4000, payee_name: 'Abdul', payee_type: 'employee',
    account_number: '7048940378', bank: 'OPAY', reason: 'Transport to Idumota',
  };
  const before = [
    'Payment request: ₦4,000',
    'Payee: Abdul (employee)',
    'Account: 7048940378 · OPAY',
    'Reason: Transport to Idumota',
  ].join('\n');
  assert.equal(paymentCards.buildApprovalSummary(pending), before, 'as before PAY-6');
  assert.equal(paymentCards.buildApprovalSummary({ ...pending, payFrom: { label: '' } }), before);
  const decided = { ...pending, approverIds: ['777', '888'], payFrom: { label: 'ZENITH — BLACK PANTHER', by: '888', at: '2026-11-11T09:00:00.000Z' } };
  const after = [
    'Payment request: ₦4,000',
    'Payee: Abdul (employee)',
    'Account: 7048940378 · OPAY',
    'Paid from: ZENITH — BLACK PANTHER',
    'Reason: Transport to Idumota',
  ].join('\n');
  assert.equal(paymentCards.buildApprovalSummary(decided), after);
  // …and that is the body the inbox rebuilds from the queue row.
  assert.equal(await approvalCards.buildCardFromActionJSON(decided, { decided: true }), after);
  assert.equal(await approvalCards.buildCardFromActionJSON(pending), before);
});

/* ── 6. four eyes ──────────────────────────────────────────────────── */

test('PAY-6: approverIdsFor counts the admin who named the paying account (payFrom.by)', async () => {
  const pay = { payment_id: 'PAY-0001', approval_request_id: 'REQ-1' };
  paymentEventsRepository.forPayment = async () => [];
  const orig = approvalQueueRepository.getByRequestId;
  try {
    // The worst case PAY-4b fixed, replayed: only the FIRST signature is on
    // the row and the trail is empty. The completing admin is still known.
    approvalQueueRepository.getByRequestId = async () => ({
      requestId: 'REQ-1', status: 'approved',
      actionJSON: { action: 'request_payment', approvals: ['777'], payFrom: { label: 'ZENITH — BLACK PANTHER', by: 888, at: 'x' } },
    });
    assert.deepEqual(await paymentService.approverIdsFor(pay), ['777', '888']);
    process.env.FINANCE_IDS = '888';
    const gate = await paymentService.canExecute('888', pay);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, 'approved_it', 'the admin who picked the account can never pay it');

    // No duplicate when the pair is parked too; nothing invented without it.
    approvalQueueRepository.getByRequestId = async () => ({
      requestId: 'REQ-1', status: 'approved',
      actionJSON: { action: 'request_payment', approvals: ['777'], approverIds: ['777', '888'], payFrom: { label: 'Z', by: '888' } },
    });
    assert.deepEqual(await paymentService.approverIdsFor(pay), ['777', '888']);
    approvalQueueRepository.getByRequestId = async () => ({
      requestId: 'REQ-1', status: 'approved', actionJSON: { action: 'request_payment', approvals: ['777'], payFrom: {} },
    });
    assert.deepEqual(await paymentService.approverIdsFor(pay), ['777']);
  } finally {
    approvalQueueRepository.getByRequestId = orig;
    delete process.env.FINANCE_IDS;
  }
});
