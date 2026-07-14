'use strict';

/**
 * ST-1 Part A — 💰 Sell Bale tappable flow. Drives the full chip path
 * offline: container → warehouse → design → bale cart → customer →
 * salesperson → payment → date → review → handoff into the proven
 * salesFlowService session (bill-photo step) with every collected field
 * populated and zero free-typed values.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const sessionStore = require('../../../src/utils/sessionStore');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const transactionsRepository = require('../../../src/repositories/transactionsRepository');
const customersRepository = require('../../../src/repositories/customersRepository');
const usersRepository = require('../../../src/repositories/usersRepository');
const designAssetsService = require('../../../src/services/designAssetsService');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const sellBaleFlow = require('../../../src/flows/sellBaleFlow');
const salesFlow = require('../../../src/services/salesFlowService');

inventoryRepository.getArrivalBatches = async () => [
  { batch: 'Jul26', label: 'Jul26', bales: 646, thans: 3223, yards: 96553, value: 0 },
];
inventoryRepository.getAll = async () => [
  { packageNo: '552', design: '44200', shade: 'BLACK', thanNo: 1, yards: 30, status: 'available', warehouse: 'IDUMOTA', arrivalBatch: 'Jul26' },
  { packageNo: '552', design: '44200', shade: 'BLACK', thanNo: 2, yards: 30, status: 'available', warehouse: 'IDUMOTA', arrivalBatch: 'Jul26' },
  { packageNo: '553', design: '44200', shade: 'BLACK', thanNo: 1, yards: 25, status: 'available', warehouse: 'IDUMOTA', arrivalBatch: 'Jul26' },
  { packageNo: '600', design: '9045', shade: '', thanNo: 1, yards: 40, status: 'sold', warehouse: 'IDUMOTA', arrivalBatch: 'Jul26' },
];
customersRepository.getAll = async () => [{ name: 'Chima' }, { name: 'Soldier Madam' }];
usersRepository.getAll = async () => [{ user_id: '901', name: 'Abdulazeez', status: 'active' }];
transactionsRepository.getLast = async () => [
  { action: 'sell_package', customerName: 'Chima', design: '44200', pricePerYard: '1500' },
];
settingsRepository.getAll = async () => ({ BANK_LIST: 'ZENITH BANK' });
designAssetsService.sendDesignPhoto = async () => true;

const cbq = (data) => ({ id: 'q', data, from: { id: 555 }, message: { chat: { id: 1 }, message_id: 3 } });

test('full chip path lands a complete salesFlow session with no typing', async () => {
  const bot = createFakeBot();
  await sellBaleFlow.start(bot, 1, '555');
  assert.equal(sessionStore.get('555').step, 'container');

  await sellBaleFlow.handleCallback(bot, cbq('sb:ct:0'));   // Jul26
  assert.equal(sessionStore.get('555').step, 'warehouse');
  await sellBaleFlow.handleCallback(bot, cbq('sb:wh:0'));   // IDUMOTA
  assert.equal(sessionStore.get('555').step, 'design');
  await sellBaleFlow.handleCallback(bot, cbq('sb:dg:0'));   // 44200
  assert.equal(sessionStore.get('555').step, 'bales');

  await sellBaleFlow.handleCallback(bot, cbq('sb:bl:0'));   // bale 552 (2 thans, 60 yds)
  let s = sessionStore.get('555');
  assert.equal(s.cart.length, 1);
  assert.equal(s.cart[0].packageNo, '552');
  assert.equal(s.cart[0].yards, 60);

  await sellBaleFlow.handleCallback(bot, cbq('sb:bl:0'));   // bale 553 (552 now excluded)
  s = sessionStore.get('555');
  assert.equal(s.cart.length, 2);
  assert.equal(s.cart[1].packageNo, '553');

  await sellBaleFlow.handleCallback(bot, cbq('sb:rev'));    // → customer step
  assert.equal(sessionStore.get('555').step, 'customer');
  await sellBaleFlow.handleCallback(bot, cbq('sb:cu:0'));   // Chima (recent buyer)
  assert.equal(sessionStore.get('555').customer, 'Chima');
  await sellBaleFlow.handleCallback(bot, cbq('sb:sp:0'));   // Abdulazeez
  assert.equal(sessionStore.get('555').step, 'payment');
  const pays = sessionStore.get('555');
  await sellBaleFlow.handleCallback(bot, cbq(`sb:py:${pays._payOpts.indexOf('ZENITH BANK')}`));
  assert.equal(sessionStore.get('555').step, 'date');
  await sellBaleFlow.handleCallback(bot, cbq('sb:dt:0'));   // Today
  assert.equal(sessionStore.get('555').step, 'review');

  await sellBaleFlow.handleCallback(bot, cbq('sb:fin'));    // handoff
  const sale = salesFlow.getSession('555');
  assert.ok(sale, 'salesFlow session must exist after handoff');
  assert.equal(sale.saleType, 'sell_batch');
  assert.deepEqual(sale.items, [
    { type: 'package', packageNo: '552' },
    { type: 'package', packageNo: '553' },
  ]);
  assert.equal(sale.collected.customer, 'Chima');
  assert.equal(sale.collected.salesperson, 'Abdulazeez');
  assert.equal(sale.collected.paymentMode, 'ZENITH BANK');
  assert.match(sale.collected.salesDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(sale.awaitingDocument, true, 'bill-photo step must be armed');
  sessionStore.clear('555');
});

test('typing during the customer step filters existing customers only', async () => {
  const bot = createFakeBot();
  sessionStore.set('555', { type: 'sell_bale_flow', step: 'customer', cart: [{ packageNo: '552', design: '44200', thans: 2, yards: 60 }] });
  const handled = await sellBaleFlow.handleText(bot, { from: { id: 555 }, chat: { id: 1 }, text: 'sold' });
  assert.equal(handled, true);
  const s = sessionStore.get('555');
  assert.deepEqual(s._customers, ['Soldier Madam'], 'filter matches existing customers only');
  sessionStore.clear('555');
});
