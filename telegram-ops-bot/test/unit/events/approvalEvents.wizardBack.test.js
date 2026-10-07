'use strict';
/**
 * WIZ-BACK (owner, 07-Oct-2026): "Once I give the rate for the particular
 * sale, it is not giving me a back option to change or correct the price
 * before final submission." Steps 3, 4 and 5 of the sale wizard carry a
 * ⬅ chip back to the previous step; the earlier answer stays on state and
 * Step 2 prints the rate being replaced.
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

const { pendingEnrichment, wizKey, lastTouchedWizard, sendPaymentStep, sendAmountStep, sendMultiplierStep } = approvalEvents._internals;

settingsRepository.getAll = async () => ({ BANK_LIST: 'ZENITH BANK,GTBank' });
approvalQueueRepository.updateActionJSON = async () => true;
approvalQueueRepository.updateStatus = async () => true;
approvalQueueRepository.getByRequestId = async () => null;
transactionsRepository.getLast = async () => [];
const realExecute = inventoryService.executeApprovedAction;
let executed = null;
inventoryService.executeApprovedAction = async (requestId, adminId, enrichment) => { executed = { requestId, adminId, enrichment }; return { ok: true }; };

const CHAT = 1;
const ADMIN = '777';
const lastCard = (bot) => bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1);
const chips = (bot) => lastCard(bot).args.opts.reply_markup.inline_keyboard.flat();
const tap = (bot, data) => approvalEvents.handleEnrichmentCallback(bot, { id: 'cb', data, from: { id: ADMIN }, message: { chat: { id: CHAT }, message_id: 9 } });

function open(over = {}) {
  const item = { requestId: 'R-REQ1', user: '555', actionJSON: { action: 'sale_bundle', customer: 'Soldier Madam', yardsByDesign: { 77019: 420 }, items: [] } };
  const state = { requestId: 'R-REQ1', adminId: ADMIN, step: 'rate', item, requestingUser: '555', customer: 'Soldier Madam', designs: ['77019'], unit: 'yard', ratePerUnitByDesign: { 77019: 1500 }, startedAt: Date.now(), ...over };
  pendingEnrichment.set(wizKey(ADMIN, 'R-REQ1'), state);
  lastTouchedWizard.set(ADMIN, { requestId: 'R-REQ1', at: Date.now() });
  return state;
}
test.beforeEach(() => { menuAnchor._resetForTests(); pendingEnrichment.clear(); lastTouchedWizard.clear(); executed = null; });
test.after(() => { inventoryService.executeApprovedAction = realExecute; });

test('Step 3 carries ⬅ Change rate; the tap returns to Step 2 showing the rate being replaced, nothing executed', async () => {
  const bot = createFakeBot();
  const state = open();
  await sendPaymentStep(bot, CHAT, state);
  const back = chips(bot).find((b) => b.text === '⬅ Change rate');
  assert.ok(back, 'Step 3 has the back chip');
  assert.equal(back.callback_data, 'enr:q:R-REQ1:back:rate');
  await tap(bot, back.callback_data);
  assert.equal(state.step, 'rate');
  assert.match(lastCard(bot).args.text, /Step 2 — Rate/);
  assert.match(lastCard(bot).args.text, /Entered: 1,500\/yd — tap or type to change it\./);
  assert.deepEqual(state.ratePerUnitByDesign, { 77019: 1500 }, 'the earlier rate is kept until replaced');
  assert.equal(executed, null);
});

test('Step 4 goes back to Step 3 and Step 5 back to Step 4; a stale chip does nothing', async () => {
  const bot = createFakeBot();
  const state = open({ paymentMode: 'Cash', amountPaid: 630000 });
  await sendAmountStep(bot, CHAT, state);
  assert.ok(chips(bot).some((b) => b.text === '⬅ Change payment mode'));
  await tap(bot, 'enr:q:R-REQ1:back:payment');
  assert.equal(state.step, 'payment');
  assert.match(lastCard(bot).args.text, /Step 3 — Payment mode/);

  await sendMultiplierStep(bot, CHAT, state);
  assert.ok(chips(bot).some((b) => b.text === '⬅ Change amount'));
  await tap(bot, 'enr:q:R-REQ1:back:amount_paid');
  assert.equal(state.step, 'amount_paid');
  assert.match(lastCard(bot).args.text, /Step 4 — Amount paid/);

  const before = bot.calls.length;
  await tap(bot, 'enr:q:R-REQ1:back:rate'); // drawn on Step 3, tapped while on Step 4
  assert.equal(state.step, 'amount_paid', 'a stale back chip does not move the wizard');
  const toast = bot.calls.slice(before).find((c) => c.method === 'answerCallbackQuery');
  assert.match(toast.args.opts.text, /stale/);
});

test('a fresh Step 2 prints no "Entered" line', async () => {
  const bot = createFakeBot();
  const state = open({ ratePerUnitByDesign: {} });
  await approvalEvents._internals.sendRateStep(bot, CHAT, state);
  assert.doesNotMatch(lastCard(bot).args.text, /Entered:/);
});
