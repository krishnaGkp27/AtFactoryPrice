'use strict';

/**
 * ST-1 Part B — tappable sale enrichment (specs/ST-1_TAPPABLE_SALE.md).
 * Pins: last-paid rate lookup from Transactions; chip transitions
 * rate → payment → amount → execute; typed fallbacks untouched.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const approvalEvents = require('../../../src/events/approvalEvents');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const inventoryService = require('../../../src/services/inventoryService');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');

const { pendingEnrichment, getLastPaidRate, wizKey } = approvalEvents._internals;

transactionsRepository.getLast = async () => [
  { action: 'sell_package', customerName: 'Chima', design: '44200', pricePerYard: '1400' },
  { action: 'sell_package', customerName: 'chima ', design: '44200', pricePerYard: '1500' }, // newest wins
  { action: 'return_than', customerName: 'Chima', design: '44200', pricePerYard: '9999' },   // not a sale
];
// CUR-2 release B — Step 5 reads INVOICE_MULTIPLIER_ASK / INVOICE_RATE_MULTIPLIER
// from the same Settings read; each test sets what it needs.
let settings = { BANK_LIST: 'ZENITH BANK,GTBank' };
settingsRepository.getAll = async () => ({ ...settings });
approvalQueueRepository.updateStatus = async () => true;
approvalQueueRepository.getByRequestId = async () => null;
approvalQueueRepository.updateActionJSON = async () => true; // APC-1 draft persistence

let executed = null;
inventoryService.executeApprovedAction = async (requestId, adminId, enrichment) => {
  executed = { requestId, adminId, enrichment };
  return { ok: true };
};

test('getLastPaidRate: newest matching SALE row wins, case/space-insensitive', async () => {
  assert.equal(await getLastPaidRate('CHIMA', '44200'), 1500);
  assert.equal(await getLastPaidRate('Nobody', '44200'), null);
  assert.equal(await getLastPaidRate('Chima', '9037'), null);
});

test('chip path: last-paid rate → bank → paid-in-full → Step 5 No multiplier → executes with computed amount', async () => {
  executed = null;
  settings = { BANK_LIST: 'ZENITH BANK,GTBank' }; // INVOICE_MULTIPLIER_ASK absent = default 1 → Step 5 asked
  const bot = createFakeBot();
  const item = {
    requestId: 'REQ9', user: '555',
    actionJSON: { action: 'sale_bundle', customer: 'Chima', yardsByDesign: { 44200: 150 }, items: [] },
  };
  // APC-1 — state is keyed adminId|requestId and carries adminId; the
  // legacy chip payloads (no q: segment) must still resolve while exactly
  // one wizard is open — old cards in chats keep working across the deploy.
  pendingEnrichment.set(wizKey('777', 'REQ9'), {
    requestId: 'REQ9', adminId: '777', step: 'rate', item, requestingUser: '555',
    designs: ['44200'], unit: 'yard', lastPaidRate: 1500, startedAt: Date.now(),
  });
  const cbq = (data) => ({ id: 'q', data, from: { id: 777 }, message: { chat: { id: 1 }, message_id: 2 } });

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:rate:v'));
  let state = pendingEnrichment.get(wizKey('777', 'REQ9'));
  assert.equal(state.step, 'payment');
  assert.equal(state.ratePerUnitByDesign['44200'], 1500);

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:pay:b:0'));
  state = pendingEnrichment.get(wizKey('777', 'REQ9'));
  assert.equal(state.step, 'amount_paid');
  assert.equal(state.paymentMode, 'Paid to ZENITH BANK');
  assert.equal(state.fullAmount, 225000, '150 yds × 1500');

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:amt:full'));
  // CUR-2 release B — the Paid-in-full chip now lands on Step 5 (the knob
  // defaults to 1); the amount is held on state until Step 5 is answered.
  assert.equal(executed, null, 'Step 5 is asked before the sale executes');
  state = pendingEnrichment.get(wizKey('777', 'REQ9'));
  assert.equal(state.step, 'multiplier');
  assert.equal(state.amountPaid, 225000);

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:mult:none'));
  assert.ok(executed, 'sale must execute');
  assert.equal(executed.enrichment.amountPaid, 225000);
  assert.equal(executed.enrichment.paymentMode, 'Paid to ZENITH BANK');
  assert.equal(executed.enrichment.rateMultiplier, 1, '"No multiplier" is written down as 1 (key PRESENT)');
  assert.equal(pendingEnrichment.has(wizKey('777', 'REQ9')), false, 'state cleaned up');
});

test('not-yet-paid chip finishes with zero amount (knob 0: no Step 5, no key)', async () => {
  executed = null;
  settings = { BANK_LIST: 'ZENITH BANK,GTBank', INVOICE_MULTIPLIER_ASK: 0, INVOICE_RATE_MULTIPLIER: 1250 };
  const bot = createFakeBot();
  pendingEnrichment.set(wizKey('777', 'REQ10'), {
    requestId: 'REQ10', adminId: '777', step: 'payment', requestingUser: '555',
    item: { requestId: 'REQ10', user: '555', actionJSON: { action: 'sale_bundle', customer: 'X' } },
    designs: ['44200'], unit: 'yard', ratePerUnitByDesign: { 44200: 1000 }, startedAt: Date.now(),
  });
  const cbq = { id: 'q', data: 'enr:pay:nyp', from: { id: 777 }, message: { chat: { id: 1 }, message_id: 2 } };
  await approvalEvents.handleEnrichmentCallback(bot, cbq);
  assert.ok(executed);
  assert.equal(executed.enrichment.amountPaid, 0);
  assert.equal(executed.enrichment.paymentMode, 'Not yet paid');
  assert.equal(Object.prototype.hasOwnProperty.call(executed.enrichment, 'rateMultiplier'), false,
    'INVOICE_MULTIPLIER_ASK=0 → the Settings-fulfilled path: the key is ABSENT even with a Settings value');
});
