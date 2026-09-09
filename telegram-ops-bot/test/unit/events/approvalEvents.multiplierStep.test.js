'use strict';

/**
 * CUR-2 release B — Step 5 "Customer-copy multiplier" in the sale approval
 * wizard (specs/CUR-2_INVOICE_MULTIPLIER.md §3b, §7, §8 rule 11, §9 step 4)
 * and the CUR-1 sweep of the wizard's own chips / prompts / acks (rule 7
 * touch point vi — R18 superseded for the sale wizard).
 *
 * Owner ruling 09-Sep-2026 (overrides §5 of the spec): the multiplier is
 * INTERNAL. It is shown only while the approving admin is entering it — the
 * Step 5 card itself. After that it lives in the enrichment key, Invoices
 * column W and the AuditLog payload, and NOWHERE on a card: not on the
 * sealed wizard card, not on the approved reply, not on the requester's
 * card. Pinned here as negative assertions with positive controls.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const approvalEvents = require('../../../src/events/approvalEvents');
const menuAnchor = require('../../../src/services/menuAnchor');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const inventoryService = require('../../../src/services/inventoryService');
const invoiceService = require('../../../src/services/invoiceService');
const accountingService = require('../../../src/services/accountingService');
const crmService = require('../../../src/services/crmService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const auditService = require('../../../src/services/auditService');

const {
  pendingEnrichment, wizKey, lastTouchedWizard, sendMultiplierStep, parseTypedMultiplier,
  MULTIPLIER_REFUSAL, runApprovedSaleWithEnrichment,
} = approvalEvents._internals;

// ── seams ──────────────────────────────────────────────────────────────────
let settings = {};
settingsRepository.getAll = async () => ({ ...settings });
transactionsRepository.getLast = async () => [
  { action: 'sell_package', customerName: 'Soldier Madam', design: '77019', pricePerYard: '3.2' },
  { action: 'sell_package', customerName: 'Chima', design: '44200', pricePerYard: '1500' },
];
approvalQueueRepository.updateStatus = async () => true;
approvalQueueRepository.getByRequestId = async () => null;
approvalQueueRepository.updateActionJSON = async () => true;
accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 944 });
crmService.getCustomer = async () => ({ name: 'Soldier Madam', phone: '08012345678' });
invoiceService.deliver = async () => true; // the PDF caption is invoiceService's own surface

const realExecute = inventoryService.executeApprovedAction;
let executed = null;
function stubExecutor(result = { ok: true }) {
  inventoryService.executeApprovedAction = async (requestId, adminId, enrichment) => {
    executed = { requestId, adminId, enrichment };
    return result;
  };
}

const CHAT = 1;
const ADMIN = '777';
const cbq = (data) => ({ id: 'q', data, from: { id: 777 }, message: { chat: { id: CHAT }, message_id: 2 } });
const chipsOf = (call) => (call.args.opts && call.args.opts.reply_markup ? call.args.opts.reply_markup.inline_keyboard : []);
const lastCard = (bot) => bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1);

/** The §2 worked example at Step 4 answered: 420 yds @ 3.20, 400 paid to GTBank. */
function stateAtAmount(over = {}) {
  const item = {
    requestId: 'R-REQ1', user: '555',
    actionJSON: { action: 'sale_bundle', customer: 'Soldier Madam', yardsByDesign: { 77019: 420 }, items: [] },
  };
  return {
    requestId: 'R-REQ1', adminId: ADMIN, step: 'amount_paid', item, requestingUser: '555',
    customer: 'Soldier Madam', designs: ['77019'], unit: 'yard',
    ratePerUnitByDesign: { 77019: 3.2 }, paymentMode: 'Paid to GTBank', fullAmount: 1344,
    startedAt: Date.now(), ...over,
  };
}
function open(state) {
  pendingEnrichment.set(wizKey(ADMIN, state.requestId), state);
  lastTouchedWizard.set(ADMIN, { requestId: state.requestId, at: Date.now() });
  return state;
}

test.beforeEach(() => {
  menuAnchor._resetForTests();
  pendingEnrichment.clear();
  lastTouchedWizard.clear();
  executed = null;
  settings = { BANK_LIST: 'ZENITH BANK,GTBank' };
  stubExecutor();
});
test.after(() => { inventoryService.executeApprovedAction = realExecute; });

// ── §3b rule 2 — the typed range ────────────────────────────────────────────
test('parseTypedMultiplier: commas ignored, decimals allowed, 0 < m <= 1,000,000', () => {
  assert.equal(parseTypedMultiplier('1,250'), 1250);
  assert.equal(parseTypedMultiplier(' 1250 '), 1250);
  assert.equal(parseTypedMultiplier('0.0004'), 0.0004);
  assert.equal(parseTypedMultiplier('1000000'), 1_000_000);
  for (const bad of ['abc', '0', '-5', '2000000', '1,000,001', '', '1e3', '12abc']) {
    assert.equal(parseTypedMultiplier(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
});

// ── §3b — the card, drawn exactly ───────────────────────────────────────────
test('Step 5 card: header, prompt, three chips (Settings chip when the cell is usable), no unit', async () => {
  settings.INVOICE_RATE_MULTIPLIER = '1,250'; // the way the owner types it
  const bot = createFakeBot();
  open(stateAtAmount());
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:amt:full'));

  const state = pendingEnrichment.get(wizKey(ADMIN, 'R-REQ1'));
  assert.equal(state.step, 'multiplier', 'the Paid-in-full chip lands on Step 5');
  assert.equal(state.amountPaid, 1344, 'the amount is held on state meanwhile');
  assert.equal(executed, null, 'nothing executed yet');

  const card = lastCard(bot);
  const text = card.args.text;
  assert.match(text, /📋 \*Confirm sale — /);
  assert.match(text, /👤 Soldier Madam · Paid to GTBank · 1,344\n/, 'header line: customer · mode · amount, bare');
  assert.match(text, /\*Step 5 — Customer-copy multiplier:\* tap below, or reply with the number the entered rate is multiplied by on the customer's invoice\./);
  assert.match(text, /_No multiplier = the invoice prints the rate exactly as entered \(3\.20\/yd\)\._/, 'the entered rate at 2 dp, bare');
  assert.match(text, /✍️ _A typed reply goes to the request you touched last\._/);
  assert.ok(!/₦|NGN|Naira/.test(text), 'R13: no unit anywhere on this card');

  const rows = chipsOf(card);
  assert.deepEqual(rows.map((r) => r.map((b) => b.text)), [['No multiplier', 'Settings: 1,250'], ['✏️ Type a number']]);
  assert.deepEqual(rows.flat().map((b) => b.callback_data),
    ['enr:q:R-REQ1:mult:none', 'enr:q:R-REQ1:mult:def', 'enr:q:R-REQ1:mult:custom'], 'APC-1 wire form');
  for (const b of rows.flat()) assert.ok(Buffer.byteLength(b.callback_data) <= 64, `${b.callback_data} fits Telegram's 64 bytes`);
});

test('Step 5 card: the Settings chip is hidden when the cell is blank / 0 / 1 / unparsable', async () => {
  for (const cell of [undefined, '', 0, 1, '1', 'abc', -3, 2_000_000]) {
    settings = { BANK_LIST: 'GTBank', INVOICE_RATE_MULTIPLIER: cell };
    pendingEnrichment.clear();
    const bot = createFakeBot();
    await sendMultiplierStep(bot, CHAT, { ...stateAtAmount(), amountPaid: 400, settingsMultiplier: (await approvalEvents._internals.multiplierStepConfig()).settingsFactor });
    const rows = chipsOf(lastCard(bot));
    assert.deepEqual(rows.map((r) => r.map((b) => b.text)), [['No multiplier'], ['✏️ Type a number']], `cell ${JSON.stringify(cell)}`);
  }
});

test('Step 5 card: a Settings outage still asks — no Settings chip, the sale is never blocked', async () => {
  const orig = settingsRepository.getAll;
  settingsRepository.getAll = async () => { throw new Error('Sheets 503'); };
  try {
    const bot = createFakeBot();
    open(stateAtAmount());
    await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:amt:full'));
    assert.equal(pendingEnrichment.get(wizKey(ADMIN, 'R-REQ1')).step, 'multiplier');
    assert.deepEqual(chipsOf(lastCard(bot)).map((r) => r.map((b) => b.text)), [['No multiplier'], ['✏️ Type a number']]);
  } finally { settingsRepository.getAll = orig; }
});

test('Step 5 edits the SAME anchored card — never a new message (ANCH-1)', async () => {
  settings.INVOICE_RATE_MULTIPLIER = 1250;
  const bot = createFakeBot();
  const state = open(stateAtAmount({ anchorChatId: CHAT, anchorMessageId: 500 }));
  menuAnchor.noteMessage(CHAT, 500); // the card is the newest message
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:amt:full'));
  assert.equal(bot.callsTo('sendMessage').length, 0);
  const edits = bot.callsTo('editMessageText');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].args.opts.message_id, 500);
  assert.equal(state.anchorMessageId, 500);
  assert.match(edits[0].args.text, /Step 5 — Customer-copy multiplier/);
});

// ── the three answers ───────────────────────────────────────────────────────
test('[No multiplier] → enrichment.rateMultiplier is PRESENT as 1, even with a Settings value (rule 3 / Q4)', async () => {
  settings.INVOICE_RATE_MULTIPLIER = 1250;
  const bot = createFakeBot();
  open(stateAtAmount({ step: 'multiplier', amountPaid: 400, settingsMultiplier: 1250 }));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:mult:none'));
  assert.ok(executed, 'executes at once');
  assert.equal(executed.enrichment.rateMultiplier, 1);
  assert.equal(executed.enrichment.amountPaid, 400);
  assert.equal(executed.enrichment.paymentMode, 'Paid to GTBank');
  assert.deepEqual(executed.enrichment.ratePerUnitByDesign, { 77019: 3.2 });
  assert.equal(pendingEnrichment.has(wizKey(ADMIN, 'R-REQ1')), false, 'state cleaned up');
  const ack = bot.callsTo('answerCallbackQuery').at(-1);
  assert.equal(ack.args.opts.text, 'No multiplier');
});

test('[Settings: 1,250] → the Settings number', async () => {
  const bot = createFakeBot();
  open(stateAtAmount({ step: 'multiplier', amountPaid: 400, settingsMultiplier: 1250 }));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:mult:def'));
  assert.ok(executed);
  assert.equal(executed.enrichment.rateMultiplier, 1250);
  assert.equal(bot.callsTo('answerCallbackQuery').at(-1).args.opts.text, '× 1,250', 'the toast on the tap itself');
});

test('[Settings] chip without a Settings factor on state → expired, Step 5 re-rendered, nothing executed', async () => {
  const bot = createFakeBot();
  open(stateAtAmount({ step: 'multiplier', amountPaid: 400 }));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:mult:def'));
  assert.equal(executed, null);
  assert.equal(pendingEnrichment.get(wizKey(ADMIN, 'R-REQ1')).step, 'multiplier');
  assert.match(lastCard(bot).args.text, /Step 5 — Customer-copy multiplier/);
});

test('[✏️ Type a number] prompts; typed "1,250" → 1250 (commas ignored)', async () => {
  const bot = createFakeBot();
  open(stateAtAmount({ step: 'multiplier', amountPaid: 400 }));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:mult:custom'));
  assert.equal(executed, null);
  assert.match(bot.callsTo('sendMessage').at(-1).args.text, /Reply with the number the entered rate is multiplied by/);

  const handled = await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, '1,250');
  assert.equal(handled, true);
  assert.ok(executed);
  assert.equal(executed.enrichment.rateMultiplier, 1250);
  assert.equal(executed.enrichment.amountPaid, 400);
});

test('typed "abc" / "0" / "2000000" → refused in place with the one-line reason; card stays on Step 5', async () => {
  for (const bad of ['abc', '0', '2000000']) {
    pendingEnrichment.clear();
    executed = null;
    const bot = createFakeBot();
    const state = open(stateAtAmount({ step: 'multiplier', amountPaid: 400 }));
    const handled = await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, bad);
    assert.equal(handled, true, `${bad}: handled by the wizard`);
    assert.equal(executed, null, `${bad}: not executed`);
    assert.equal(state.step, 'multiplier', `${bad}: still on Step 5`);
    assert.equal(state.rateMultiplier, undefined, `${bad}: nothing written`);
    assert.ok(pendingEnrichment.has(wizKey(ADMIN, 'R-REQ1')), `${bad}: wizard still open`);
    const sends = bot.callsTo('sendMessage').map((c) => c.args.text);
    assert.ok(sends.includes(MULTIPLIER_REFUSAL), `${bad}: the refusal line`);
    assert.equal(MULTIPLIER_REFUSAL, 'Please enter a positive number for the multiplier, e.g. 1250 — or tap No multiplier.');
    assert.match(lastCard(bot).args.text, /Step 5 — Customer-copy multiplier/, `${bad}: the step is re-rendered`);
  }
});

test('typed amount route and the amount-0 shortcuts all reach Step 5 while the knob is 1 (rule 16)', async () => {
  // typed amount
  let bot = createFakeBot();
  open(stateAtAmount());
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, '400');
  assert.equal(executed, null);
  assert.equal(pendingEnrichment.get(wizKey(ADMIN, 'R-REQ1')).step, 'multiplier');
  assert.equal(pendingEnrichment.get(wizKey(ADMIN, 'R-REQ1')).amountPaid, 400);

  // 'Not yet paid' chip
  pendingEnrichment.clear();
  bot = createFakeBot();
  open(stateAtAmount({ step: 'payment', paymentMode: undefined, banks: ['GTBank'] }));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:pay:nyp'));
  assert.equal(executed, null);
  const s = pendingEnrichment.get(wizKey(ADMIN, 'R-REQ1'));
  assert.equal(s.step, 'multiplier');
  assert.equal(s.amountPaid, 0);
  assert.match(lastCard(bot).args.text, /👤 Soldier Madam · Not yet paid · 0\n/);

  // typed 'Credit'
  pendingEnrichment.clear();
  bot = createFakeBot();
  open(stateAtAmount({ step: 'payment', paymentMode: undefined }));
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'Credit');
  assert.equal(executed, null);
  assert.equal(pendingEnrichment.get(wizKey(ADMIN, 'R-REQ1')).step, 'multiplier');
});

test('INVOICE_MULTIPLIER_ASK=0 → Step 5 skipped on every route and the key is ABSENT (Settings-fulfilled path)', async () => {
  settings = { BANK_LIST: 'GTBank', INVOICE_MULTIPLIER_ASK: 0, INVOICE_RATE_MULTIPLIER: 1250 };
  let bot = createFakeBot();
  open(stateAtAmount());
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:amt:full'));
  assert.ok(executed, 'chip route executes at once');
  assert.equal(Object.prototype.hasOwnProperty.call(executed.enrichment, 'rateMultiplier'), false);
  assert.equal(executed.enrichment.amountPaid, 1344);
  assert.ok(!bot.allText().includes('Step 5'), 'the card never showed Step 5');

  executed = null;
  pendingEnrichment.clear();
  bot = createFakeBot();
  open(stateAtAmount());
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, '400');
  assert.ok(executed, 'typed route executes at once');
  assert.equal(Object.prototype.hasOwnProperty.call(executed.enrichment, 'rateMultiplier'), false);
  assert.equal(executed.enrichment.amountPaid, 400);
});

test('an explicit "1" in the knob cell asks; a blank cell asks (default 1)', async () => {
  for (const v of [1, '1', '']) {
    settings = { BANK_LIST: 'GTBank', INVOICE_MULTIPLIER_ASK: v };
    pendingEnrichment.clear();
    executed = null;
    const bot = createFakeBot();
    open(stateAtAmount());
    await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:amt:full'));
    assert.equal(executed, null, `knob ${JSON.stringify(v)}: Step 5 asked`);
  }
});

// ── after the answer: the factor is INTERNAL (owner, 09-Sep-2026) ───────────
test('sealed card: header line bare, keyboard removed, and NO factor on it', async () => {
  const bot = createFakeBot();
  open(stateAtAmount({ step: 'multiplier', amountPaid: 400, settingsMultiplier: 1250 }));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:mult:def'));
  assert.equal(executed.enrichment.rateMultiplier, 1250, 'control: a factor WAS chosen');
  const sealed = bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
    .find((c) => /⏳ Applying…/.test(c.args.text));
  assert.ok(sealed, 'the card is sealed before execution');
  assert.match(sealed.args.text, /👤 Soldier Madam · Paid to GTBank · 400\n⏳ Applying…/);
  assert.deepEqual(chipsOf(sealed), [], 'chips die with the card');
  assert.ok(!/×|1,250|1250|Customer copy/.test(sealed.args.text), 'the factor is not echoed on the sealed card');
  assert.ok(!/₦|NGN|Naira/.test(sealed.args.text));
});

test('approved reply, Outstanding line and requester card: bare, and they never name the factor', async () => {
  // The issued invoice carries the factor (result exposes it) AND the
  // enrichment carries it — neither may surface on a card after Step 5.
  stubExecutor({ ok: true, invoice: { invoiceNo: 'INV-2026-0064', customerName: 'Soldier Madam', total: 1344, amountPaidAtIssue: 400, rateMultiplier: 1250, token: 't' } });
  const bot = createFakeBot();
  const state = stateAtAmount({ amountPaid: 400 });
  state.item.actionJSON.requesterChatId = 555;
  state.item.actionJSON.requesterMessageId = 77;
  const enrichment = { unit: 'yard', ratePerUnitByDesign: { 77019: 3.2 }, paymentMode: 'Paid to GTBank', amountPaid: 400, rateMultiplier: 1250 };
  await runApprovedSaleWithEnrichment(bot, CHAT, ADMIN, 'R-REQ1', state.item, '555', enrichment);

  const sends = bot.callsTo('sendMessage').filter((c) => c.args.chatId === CHAT).map((c) => c.args.text);
  const approved = sends.find((t) => /approved\. Sale and ledger updated\./.test(t));
  assert.ok(approved, 'the approved reply');
  assert.equal(approved, `✅ Request ${require('../../../src/services/approvalCards').shortRequestRef('R-REQ1')} approved. Sale and ledger updated.`);
  assert.ok(!/×|Customer copy|1,250|1250/.test(approved), 'no factor on the approved reply');

  const outstanding = sends.find((t) => /Outstanding as of today/.test(t));
  assert.equal(outstanding, '📒 *Soldier Madam* — Outstanding as of today: 944', 'bare ledger figure (positive digits)');
  assert.ok(!/₦|NGN|×|1,250/.test(outstanding));

  const edit = bot.callsTo('editMessageText').find((c) => c.args.opts.message_id === 77);
  assert.ok(edit, 'the requester card is edited in place');
  assert.equal(edit.args.text, '✅ *Approved — ready to dispatch*\n\n👤 Customer: *Soldier Madam*\n📞 08012345678\nRef: ' + require('../../../src/services/approvalCards').shortRequestRef('R-REQ1'));
  assert.ok(!/×|Customer copy|1,250|1250/.test(edit.args.text), 'no factor on the requester card');
});

test('approved reply and requester card without a factor: identical shape', async () => {
  stubExecutor({ ok: true, invoice: { invoiceNo: 'INV-2026-0065', customerName: 'Soldier Madam', total: 1344, amountPaidAtIssue: 400, rateMultiplier: null, token: 't' } });
  const bot = createFakeBot();
  const state = stateAtAmount({ amountPaid: 400 });
  state.item.actionJSON.requesterChatId = 555;
  state.item.actionJSON.requesterMessageId = 78;
  await runApprovedSaleWithEnrichment(bot, CHAT, ADMIN, 'R-REQ1', state.item, '555',
    { unit: 'yard', ratePerUnitByDesign: { 77019: 3.2 }, paymentMode: 'Paid to GTBank', amountPaid: 400, rateMultiplier: 1 });
  const approved = bot.callsTo('sendMessage').map((c) => c.args.text).find((t) => /approved\. Sale and ledger updated\./.test(t));
  assert.ok(approved);
  assert.ok(!/×|Customer copy/.test(approved));
  assert.ok(!/×|Customer copy/.test(bot.callsTo('editMessageText').find((c) => c.args.opts.message_id === 78).args.text));
});

// ── CUR-1 sweep of the wizard's own surfaces (rule 7 touch point vi) ────────
test('Step 2: last-paid chip, Outstanding line and prompt are bare — digits present, no unit', async () => {
  const bot = createFakeBot();
  const item = { requestId: 'R-REQ2', user: '555', actionJSON: { action: 'sell_package', customer: 'Chima', design: '44200', packageNo: '1', yards: 150 } };
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, CHAT, 'R-REQ2', item, '555');
  const card = lastCard(bot);
  const chip = chipsOf(card).flat().find((b) => /last paid by/.test(b.text));
  assert.equal(chip.text, '1,500/yd — last paid by Chima');
  assert.match(card.args.text, /📒 Outstanding: 944\n/);
  assert.match(card.args.text, /Unit: yard\n/);
  assert.ok(!/₦|NGN|Naira/.test(card.args.text + chip.text), 'R18 superseded: the prompt names no unit');

  // the rate chip's ack
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ2:rate:v'));
  assert.equal(bot.callsTo('answerCallbackQuery').at(-1).args.opts.text, 'Rate: 1,500/yd');
});

test('a fractional entered rate keeps its decimals on the chip (3.20/yd, never 3/yd)', async () => {
  const bot = createFakeBot();
  const item = { requestId: 'R-REQ3', user: '555', actionJSON: { action: 'sell_package', customer: 'Soldier Madam', design: '77019', packageNo: '2', yards: 420 } };
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, CHAT, 'R-REQ3', item, '555');
  const chip = chipsOf(lastCard(bot)).flat().find((b) => /last paid by/.test(b.text));
  assert.equal(chip.text, '3.20/yd — last paid by Soldier Madam');
});

test('Step 4: Paid-in-full chip, prompt, ack and the typed refusals are bare', async () => {
  const bot = createFakeBot();
  const state = open(stateAtAmount({ step: 'payment', paymentMode: undefined, banks: ['GTBank'] }));
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:pay:b:0'));
  const card = lastCard(bot);
  const chip = chipsOf(card).flat().find((b) => /Paid in full/.test(b.text));
  assert.equal(chip.text, '✅ Paid in full — 1,344');
  assert.match(card.args.text, /reply with the amount received, e\.g\. 50000/);
  assert.ok(!/₦|NGN|Naira/.test(card.args.text + chip.text));

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:amt:custom'));
  assert.equal(bot.callsTo('sendMessage').at(-1).args.text, 'Reply with the amount received, e.g. 50000.');

  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'lots');
  assert.equal(bot.callsTo('sendMessage').at(-1).args.text, 'Please enter a valid amount, e.g. 50000');
  assert.equal(state.step, 'amount_paid');

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-REQ1:amt:full'));
  assert.equal(bot.callsTo('answerCallbackQuery').at(-1).args.opts.text, '1,344', 'the Paid-in-full ack');
});

test('Step 2 typed refusal names no unit', async () => {
  const bot = createFakeBot();
  open(stateAtAmount({ step: 'rate', ratePerUnitByDesign: undefined }));
  await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, 'abc');
  const t = bot.callsTo('sendMessage').at(-1).args.text;
  assert.match(t, /Could not parse rates\. Use single number \(e\.g\. 1500\)/);
  assert.ok(!/Naira|₦|NGN/.test(t));
  // The numeric-branch refusal string itself (reachable only by a hand-built
  // number) names no unit either.
  const src = require('fs').readFileSync(require.resolve('../../../src/events/approvalEvents'), 'utf8');
  assert.ok(src.includes('Please enter a valid number for the rate per yard.'));
  assert.ok(!/Naira per yard/.test(src), 'R18 superseded for the sale wizard: no "Naira per yard" left in the file');
});

// ── end to end: wizard → real executor → invoiceService.createForSale ───────
test('a sale approved through the wizard with Step 5 = 1,250 reaches createForSale with enrichment.rateMultiplier 1250, and the AuditLog payload carries it', async () => {
  inventoryService.executeApprovedAction = realExecute;
  const item = {
    requestId: 'SP9', user: '555', status: 'pending',
    actionJSON: {
      action: 'sell_package', packageNo: '896', customer: 'Soldier Madam', yards: 30, thans: 1,
      design: '77019', shade: '1', warehouse: 'IDUMOTA', salesPerson: 'Abdul', salesDate: '2026-09-07',
    },
  };
  let resolved = false;
  const audits = [];
  let captured = null;
  const saved = {
    getAllPending: approvalQueueRepository.getAllPending,
    append: auditLogRepository.append,
    txAppend: require('../../../src/repositories/transactionsRepository').append,
    markPackageSold: inventoryRepository.markPackageSold,
    findByPackage: inventoryRepository.findByPackage,
    updatePrice: inventoryRepository.updatePrice,
    recordSale: accountingService.recordSale,
    recordPayment: crmService.recordPayment,
    auditLog: auditService.log,
    createForSale: invoiceService.createForSale,
  };
  approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(item))]);
  approvalQueueRepository.updateStatus = async (id, status) => { if (status === 'approved') resolved = true; return true; };
  auditLogRepository.append = async (event, payload) => { audits.push({ event, payload }); };
  transactionsRepository.append = async () => true;
  inventoryRepository.markPackageSold = async (packageNo) => ([{ packageNo, thanNo: 1, yards: 30, design: '77019', shade: '1', warehouse: 'IDUMOTA' }]);
  inventoryRepository.findByPackage = async (packageNo) => ([{ packageNo, status: 'sold', soldTo: '', yards: 30 }]);
  inventoryRepository.updatePrice = async () => 1;
  accountingService.recordSale = async () => true;
  crmService.recordPayment = async () => ({ ok: true });
  auditService.log = async () => true;
  invoiceService.createForSale = async ({ enrichment }) => {
    captured = enrichment;
    return { invoiceNo: 'INV-2026-0064', customerName: 'Soldier Madam', total: 96, amountPaidAtIssue: 96, rateMultiplier: 1250, token: 't' };
  };
  try {
    const bot = createFakeBot();
    open({
      requestId: 'SP9', adminId: ADMIN, step: 'multiplier', item, requestingUser: '555',
      customer: 'Soldier Madam', designs: ['77019'], unit: 'yard',
      ratePerUnitByDesign: { 77019: 3.2 }, paymentMode: 'Paid to GTBank', amountPaid: 96,
      startedAt: Date.now(),
    });
    const handled = await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, '1,250');
    assert.equal(handled, true);
    assert.ok(captured, 'createForSale was reached');
    assert.equal(captured.rateMultiplier, 1250);
    assert.equal(captured.amountPaid, 96);
    assert.equal(captured.paymentMode, 'Paid to GTBank');
    assert.deepEqual(captured.ratePerUnitByDesign, { 77019: 3.2 });
    const approved = audits.find((a) => a.event === 'approval_approved');
    assert.ok(approved, 'the approval_approved audit event');
    assert.equal(approved.payload.rateMultiplier, 1250, 'the who-chose-it trail');
    assert.equal(approved.payload.requestId, 'SP9');
    assert.match(bot.allText(), /approved\. Sale and ledger updated\./);
    assert.ok(!/Customer copy|× 1,250/.test(bot.allText()), 'internal: no factor on any card after Step 5');
  } finally {
    approvalQueueRepository.getAllPending = saved.getAllPending;
    auditLogRepository.append = saved.append;
    transactionsRepository.append = saved.txAppend;
    inventoryRepository.markPackageSold = saved.markPackageSold;
    inventoryRepository.findByPackage = saved.findByPackage;
    inventoryRepository.updatePrice = saved.updatePrice;
    accountingService.recordSale = saved.recordSale;
    crmService.recordPayment = saved.recordPayment;
    auditService.log = saved.auditLog;
    invoiceService.createForSale = saved.createForSale;
    stubExecutor();
  }
});

test('audit payload: no rateMultiplier key when Step 5 never ran', async () => {
  inventoryService.executeApprovedAction = realExecute;
  const item = {
    requestId: 'SP10', user: '555', status: 'pending',
    actionJSON: { action: 'sell_package', packageNo: '897', customer: 'Soldier Madam', yards: 30, thans: 1, design: '77019', shade: '1', warehouse: 'IDUMOTA' },
  };
  let resolved = false;
  const audits = [];
  const saved = { getAllPending: approvalQueueRepository.getAllPending, append: auditLogRepository.append, createForSale: invoiceService.createForSale };
  approvalQueueRepository.getAllPending = async () => (resolved ? [] : [JSON.parse(JSON.stringify(item))]);
  approvalQueueRepository.updateStatus = async (id, status) => { if (status === 'approved') resolved = true; return true; };
  auditLogRepository.append = async (event, payload) => { audits.push({ event, payload }); };
  transactionsRepository.append = async () => true;
  inventoryRepository.markPackageSold = async (packageNo) => ([{ packageNo, thanNo: 1, yards: 30, design: '77019', shade: '1', warehouse: 'IDUMOTA' }]);
  inventoryRepository.findByPackage = async (packageNo) => ([{ packageNo, status: 'sold', soldTo: '', yards: 30 }]);
  inventoryRepository.updatePrice = async () => 1;
  accountingService.recordSale = async () => true;
  auditService.log = async () => true;
  invoiceService.createForSale = async () => null;
  try {
    const res = await inventoryService.executeApprovedAction('SP10', ADMIN, { unit: 'yard', ratePerUnitByDesign: { 77019: 3.2 }, paymentMode: 'Not yet paid', amountPaid: 0 });
    assert.equal(res.ok, true);
    const approved = audits.find((a) => a.event === 'approval_approved');
    assert.equal(Object.prototype.hasOwnProperty.call(approved.payload, 'rateMultiplier'), false);
  } finally {
    approvalQueueRepository.getAllPending = saved.getAllPending;
    auditLogRepository.append = saved.append;
    invoiceService.createForSale = saved.createForSale;
    stubExecutor();
  }
});
