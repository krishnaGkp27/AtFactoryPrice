'use strict';

/**
 * APC-1 Phase A (owner, 08-Aug-2026) — concurrent sale approvals must not
 * overwrite or cross-wire each other. Pinned:
 *
 *  - two wizards run in PARALLEL, one per request; starting the second
 *    leaves the first alive;
 *  - a chip tap always acts on the request whose card was tapped (payload
 *    carries the requestId) — a customer picked on card A can never land
 *    on request B's queue row;
 *  - each wizard renders IN PLACE on its own anchored card;
 *  - a typed reply goes to the LAST-TOUCHED wizard; with several open and
 *    none touched recently the bot ASKS instead of guessing (§2), and the
 *    route pick applies the parked text to the chosen request;
 *  - a chip tapped after a redeploy/expiry RESUMES the wizard from the
 *    answers persisted on the queue row (customer + enrichDraft);
 *  - a legacy pre-APC-1 chip is honoured with ONE wizard open and refused
 *    with several.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '42';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const transactionsRepository = require(path.join(SRC, 'repositories/transactionsRepository'));

const { pendingEnrichment, wizardsOf, wizKey, lastTouchedWizard } = approvalEvents._internals;

const ADMIN = '777';

customersRepository.getAll = async () => ([
  { rowIndex: 2, customer_id: 'CUST-1', name: 'CJE', phone: '0801', status: 'Active', aliases: [] },
  { rowIndex: 3, customer_id: 'CUST-2', name: 'Ketu madam', phone: '0802', status: 'Active', aliases: [] },
]);
transactionsRepository.getLast = async () => ([
  { action: 'sell_package', customerName: 'CJE', design: '77016', pricePerYard: 1500 },
]);

function saleItem(requestId, pkg, customer, extraAj = {}) {
  return {
    requestId, user: '42', status: 'pending',
    actionJSON: {
      action: 'sell_package', packageNo: pkg, design: '77016',
      warehouse: 'IDUMOTA', yards: 60, customer, ...extraAj,
    },
  };
}

const cbq = (data, msgId = 9) => ({
  id: 'q1', data, from: { id: ADMIN }, message: { chat: { id: ADMIN }, message_id: msgId },
});

function stateOf(rid) { return pendingEnrichment.get(wizKey(ADMIN, rid)); }
function reset() { pendingEnrichment.clear(); lastTouchedWizard.clear(); }

test('two wizards run in parallel; a chip on card A writes to A, never to B', async () => {
  reset();
  const bot = createFakeBot();
  const patches = {};
  approvalQueueRepository.updateActionJSON = async (id, patch) => {
    (patches[id] = patches[id] || []).push(patch); return true;
  };
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-A', saleItem('R-A', '101', ''), '42', 900);
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-B', saleItem('R-B', '202', ''), '42', 901);
  assert.equal(wizardsOf(ADMIN).length, 2, 'starting B leaves A alive — no overwrite');

  // Tap the CJE chip on request A's card (payload carries R-A).
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-A:cust:r:0', 900));
  assert.deepEqual(Object.keys(patches), ['R-A'], `only A's queue row is written, got: ${Object.keys(patches)}`);
  assert.equal(patches['R-A'][0].customer, 'CJE');
  assert.equal(stateOf('R-A').step, 'rate', 'A advanced');
  assert.equal(stateOf('R-B').step, 'customer', 'B untouched at its own step');
});

test('the wizard renders IN PLACE on its own anchored card', async () => {
  reset();
  const bot = createFakeBot();
  approvalQueueRepository.updateActionJSON = async () => true;
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-A', saleItem('R-A', '101', 'CJE'), '42', 900);
  const edits = bot.callsTo('editMessageText');
  assert.ok(edits.length >= 1, 'the step EDITS the approval card, no new message');
  assert.equal(edits[0].args.opts.message_id, 900, 'the tapped card is the anchor');
  assert.match(edits[0].args.text, /Confirm sale — /, 'every step names its request');
  assert.match(edits[0].args.text, /Step 2 — Rate/);
});

test('a typed reply goes to the last-touched wizard only', async () => {
  reset();
  const bot = createFakeBot();
  approvalQueueRepository.updateActionJSON = async () => true;
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-A', saleItem('R-A', '101', 'CJE'), '42', 900);
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-B', saleItem('R-B', '202', 'Ketu madam'), '42', 901);
  // B was started (touched) last — the typed rate belongs to it.
  const handled = await approvalEvents.handleEnrichmentMessage(bot, ADMIN, ADMIN, '1500');
  assert.equal(handled, true);
  assert.equal(stateOf('R-B').step, 'payment', 'B took the rate');
  assert.deepEqual(stateOf('R-B').ratePerUnitByDesign, { 77016: 1500 });
  assert.equal(stateOf('R-A').step, 'rate', 'A never saw the text');
  assert.equal(stateOf('R-A').ratePerUnitByDesign, undefined);
});

test('ambiguous typed reply: the bot ASKS, and the route pick applies the parked text', async () => {
  reset();
  const bot = createFakeBot();
  approvalQueueRepository.updateActionJSON = async () => true;
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-A', saleItem('R-A', '101', 'CJE'), '42', 900);
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-B', saleItem('R-B', '202', 'Ketu madam'), '42', 901);
  // Age the last touch beyond the freshness window → routing would be a guess.
  lastTouchedWizard.set(ADMIN, { requestId: 'R-B', at: Date.now() - 6 * 60 * 1000 });

  await approvalEvents.handleEnrichmentMessage(bot, ADMIN, ADMIN, '1400');
  const ask = bot.callsTo('sendMessage').find((c) => /which request/i.test(String(c.args.text)));
  assert.ok(ask, 'the bot asks instead of guessing');
  const chips = ask.args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(chips.some((b) => b.callback_data === 'enr:q:R-A:route'));
  assert.ok(chips.some((b) => b.callback_data === 'enr:q:R-B:route'));
  assert.equal(stateOf('R-A').ratePerUnitByDesign, undefined, 'nothing applied yet');
  assert.equal(stateOf('R-B').ratePerUnitByDesign, undefined);

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-A:route', 900));
  assert.deepEqual(stateOf('R-A').ratePerUnitByDesign, { 77016: 1400 }, 'the parked text landed on the CHOSEN request');
  assert.equal(stateOf('R-A').step, 'payment');
  assert.equal(stateOf('R-B').ratePerUnitByDesign, undefined, 'the other stays untouched');
});

test('a chip tapped after a redeploy resumes from the persisted answers', async () => {
  reset();
  const bot = createFakeBot();
  approvalQueueRepository.updateActionJSON = async () => true;
  const row = saleItem('R-A', '101', 'CJE', { enrichDraft: { ratePerUnitByDesign: { 77016: 1400 }, paymentMode: null } });
  approvalQueueRepository.getByRequestId = async (id) => (String(id) === 'R-A' ? row : null);
  assert.equal(stateOf('R-A'), undefined, 'no in-memory state — the deploy ate it');

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:q:R-A:rate:custom', 900));
  const s = stateOf('R-A');
  assert.ok(s, 'the wizard rebuilt itself from the queue row');
  assert.equal(s.step, 'payment', 'customer + rate already answered → rejoin at payment');
  assert.deepEqual(s.ratePerUnitByDesign, { 77016: 1400 }, 'the persisted rate survived the restart');
});

test('legacy chips: honoured with one wizard open, refused (not guessed) with two', async () => {
  reset();
  const bot = createFakeBot();
  approvalQueueRepository.updateActionJSON = async () => true;
  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-A', saleItem('R-A', '101', 'CJE'), '42', 900);
  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:rate:custom', 900));
  assert.match(bot.allText(), /Reply with the rate/, 'single wizard: the old card still works');

  await approvalEvents.startApprovalEnrichment(bot, ADMIN, ADMIN, 'R-B', saleItem('R-B', '202', 'Ketu madam'), '42', 901);
  const bot2 = createFakeBot();
  await approvalEvents.handleEnrichmentCallback(bot2, cbq('enr:rate:custom', 900));
  const acks = bot2.callsTo('answerCallbackQuery');
  assert.match(String((acks[acks.length - 1].args.opts || {}).text), /before the update/,
    'two wizards: acting on either would be a guess — refuse');
  reset();
});
