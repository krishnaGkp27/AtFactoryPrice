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

const { pendingEnrichment, getLastPaidRate } = approvalEvents._internals;

transactionsRepository.getLast = async () => [
  { action: 'sell_package', customerName: 'Chima', design: '44200', pricePerYard: '1400' },
  { action: 'sell_package', customerName: 'chima ', design: '44200', pricePerYard: '1500' }, // newest wins
  { action: 'return_than', customerName: 'Chima', design: '44200', pricePerYard: '9999' },   // not a sale
];
settingsRepository.getAll = async () => ({ BANK_LIST: 'ZENITH BANK,GTBank' });
approvalQueueRepository.updateStatus = async () => true;
approvalQueueRepository.getByRequestId = async () => null;

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

test('chip path: last-paid rate → bank → paid-in-full → executes with computed amount', async () => {
  executed = null;
  const bot = createFakeBot();
  const item = {
    requestId: 'REQ9', user: '555',
    actionJSON: { action: 'sale_bundle', customer: 'Chima', yardsByDesign: { 44200: 150 }, items: [] },
  };
  pendingEnrichment.set('777', {
    requestId: 'REQ9', step: 'rate', item, requestingUser: '555',
    designs: ['44200'], unit: 'yard', lastPaidRate: 1500,
  });
  const cbq = (data) => ({ id: 'q', data, from: { id: 777 }, message: { chat: { id: 1 }, message_id: 2 } });

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:rate:v'));
  let state = pendingEnrichment.get('777');
  assert.equal(state.step, 'payment');
  assert.equal(state.ratePerUnitByDesign['44200'], 1500);

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:pay:b:0'));
  state = pendingEnrichment.get('777');
  assert.equal(state.step, 'amount_paid');
  assert.equal(state.paymentMode, 'Paid to ZENITH BANK');
  assert.equal(state.fullAmount, 225000, '150 yds × ₦1500');

  await approvalEvents.handleEnrichmentCallback(bot, cbq('enr:amt:full'));
  assert.ok(executed, 'sale must execute');
  assert.equal(executed.enrichment.amountPaid, 225000);
  assert.equal(executed.enrichment.paymentMode, 'Paid to ZENITH BANK');
  assert.equal(pendingEnrichment.has('777'), false, 'state cleaned up');
});

test('not-yet-paid chip finishes with zero amount', async () => {
  executed = null;
  const bot = createFakeBot();
  pendingEnrichment.set('777', {
    requestId: 'REQ10', step: 'payment', requestingUser: '555',
    item: { requestId: 'REQ10', user: '555', actionJSON: { action: 'sale_bundle', customer: 'X' } },
    designs: ['44200'], unit: 'yard', ratePerUnitByDesign: { 44200: 1000 },
  });
  const cbq = { id: 'q', data: 'enr:pay:nyp', from: { id: 777 }, message: { chat: { id: 1 }, message_id: 2 } };
  await approvalEvents.handleEnrichmentCallback(bot, cbq);
  assert.ok(executed);
  assert.equal(executed.enrichment.amountPaid, 0);
  assert.equal(executed.enrichment.paymentMode, 'Not yet paid');
});
