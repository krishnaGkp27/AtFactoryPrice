'use strict';

/**
 * SRF-PAY (owner, 11-Sep-2026) — Step 3 of the sale approval wizard offers
 * the typed words Cash · Paid to [Bank] · Not yet paid: the same vocabulary
 * the requester's supply chips carry. `Credit` is no longer listed (no chip
 * anywhere carries that value), but a typed `Credit` is still stored
 * verbatim — nothing is aliased. The chip set is unchanged.
 *
 * There is deliberately NO requester-mode hint on this card: a request that
 * reaches the wizard never carries one. A supply_request (the only row a
 * requester stamps a mode on) goes to the warehouse-boy picker, never the
 * wizard — pinned in test/characterization/supplyRequest.paymentModeRoute —
 * and every live sale door queues paymentMode ''. A mode on the row is
 * therefore ignored here, not echoed.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const approvalEvents = require('../../../src/events/approvalEvents');
const menuAnchor = require('../../../src/services/menuAnchor');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const inventoryService = require('../../../src/services/inventoryService');

const { pendingEnrichment, wizKey, lastTouchedWizard, sendPaymentStep } = approvalEvents._internals;

// ── seams ──────────────────────────────────────────────────────────────────
let settings = {};
settingsRepository.getAll = async () => ({ ...settings });
approvalQueueRepository.updateActionJSON = async () => true;
approvalQueueRepository.updateStatus = async () => true;
approvalQueueRepository.getByRequestId = async () => null;
transactionsRepository.getLast = async () => [];
const realExecute = inventoryService.executeApprovedAction;
let executed = null;
inventoryService.executeApprovedAction = async (requestId, adminId, enrichment) => {
  executed = { requestId, adminId, enrichment };
  return { ok: true };
};

const CHAT = 1;
const ADMIN = '777';
const lastCard = (bot) => bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1);
const chipsOf = (card) => card.args.opts.reply_markup.inline_keyboard;

/** A sale bundle — the row type that really reaches this wizard — at Step 2 answered. */
function stateAtRate(actionJSON = {}, over = {}) {
  const item = {
    requestId: 'R-REQ1', user: '555',
    actionJSON: { action: 'sale_bundle', customer: 'Soldier Madam', yardsByDesign: { 77019: 420 }, items: [], ...actionJSON },
  };
  return {
    requestId: 'R-REQ1', adminId: ADMIN, step: 'rate', item, requestingUser: '555',
    customer: 'Soldier Madam', designs: ['77019'], unit: 'yard',
    ratePerUnitByDesign: { 77019: 3.2 }, startedAt: Date.now(), ...over,
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
});
test.after(() => { inventoryService.executeApprovedAction = realExecute; });

test('Step 3 card, drawn exactly: typed list Cash · Paid to [Bank] · Not yet paid, no Credit; chip set unchanged', async () => {
  const bot = createFakeBot();
  const state = stateAtRate();
  await sendPaymentStep(bot, CHAT, state);
  assert.equal(state.step, 'payment');
  const card = lastCard(bot);
  const text = card.args.text;
  assert.match(text, new RegExp(
    '^📋 \\*Confirm sale — [^\\n]+\\*\\n'
    + '👤 Soldier Madam\\n'
    + '\\n\\*Step 3 — Payment mode:\\* tap below, or reply with one of:\\n'
    + '• Cash\\n• Paid to \\[Bank\\]\\n• Not yet paid\\n'
    + '✍️ _A typed reply goes to the request you touched last\\._$',
  ), 'the card, drawn exactly');
  assert.ok(!/Credit/.test(text), 'Credit is not offered as a typed word');
  assert.equal(state.paymentMode, undefined, 'nothing is pre-selected — the admin decides');
  assert.deepEqual(chipsOf(card).map((r) => r.map((b) => b.text)), [
    ['💵 Cash', '🕐 Not yet paid'], ['🏦 ZENITH BANK', '🏦 GTBank'], ['✏️ Type payment mode'], ['🏦 Manage accounts'],
  ], 'the chip set is exactly as before');
  assert.equal(card.args.opts.parse_mode, 'Markdown');
});

test('a paymentMode on the queue row is NOT echoed — no requester line, whatever the value', async () => {
  // No wizard-bound request carries a requester-chosen mode (see the file
  // header); if one ever did, the card would still be the customer line
  // straight into the step. Pinned so the dead hint does not creep back.
  for (const mode of ['Not yet paid', 'Cash', 'GTBank', 'Credit', '', null]) {
    const bot = createFakeBot();
    await sendPaymentStep(bot, CHAT, stateAtRate({ paymentMode: mode }));
    const text = lastCard(bot).args.text;
    assert.match(text, /👤 Soldier Madam\n\n\*Step 3 — Payment mode:\*/, `customer line straight into the step for ${JSON.stringify(mode)}`);
    assert.ok(!text.includes('🗒') && !/Requester/.test(text), `no requester hint for ${JSON.stringify(mode)}`);
  }
});

test('typed words at Step 3 are stored verbatim: "Not yet paid" (listed) and "Credit" (legacy, unlisted) both finish the step, neither is aliased', async () => {
  for (const typed of ['Not yet paid', 'Credit']) {
    pendingEnrichment.clear();
    lastTouchedWizard.clear();
    const bot = createFakeBot();
    open(stateAtRate({}, { step: 'payment', banks: ['ZENITH BANK', 'GTBank'] }));
    await approvalEvents.handleEnrichmentMessage(bot, CHAT, ADMIN, typed);
    const s = pendingEnrichment.get(wizKey(ADMIN, 'R-REQ1'));
    assert.ok(s, `wizard still open after typing ${typed}`);
    assert.equal(s.paymentMode, typed, 'stored as typed — no mapping');
    assert.equal(s.amountPaid, 0, 'an unpaid mode carries no amount');
    assert.equal(s.step, 'multiplier', 'the unpaid route skips the amount step');
    assert.equal(executed, null, 'nothing executed yet');
  }
});
