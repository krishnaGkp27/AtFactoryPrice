'use strict';

/**
 * SRF-PAY (owner, 11-Sep-2026) — the requester's payment-mode vocabulary is
 * Cash · Not yet paid · the Settings BANK_LIST banks. `Not yet paid` is the
 * stored VALUE for the unpaid case — the approval wizard's own word — and
 * `Credit` is no longer offered anywhere as a payment MODE. (The CON-1
 * customer payment-TERMS chip is a different concept and untouched.)
 */

delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');

const settingsRepository = require('../../../src/repositories/settingsRepository');
const salesFlow = require('../../../src/services/salesFlowService');

let settings = {};
settingsRepository.getAll = async () => ({ ...settingsRepository.DEFAULTS, ...settings });

test.beforeEach(() => { settings = {}; });

test('getPaymentOptions: Cash, Not yet paid, then the BANK_LIST banks in sheet order (trimmed, blanks dropped)', async () => {
  settings.BANK_LIST = 'GTBank, ZENITH BANK ,,Access';
  assert.deepEqual(await salesFlow.getPaymentOptions(), ['Cash', 'Not yet paid', 'GTBank', 'ZENITH BANK', 'Access']);
});

test('getPaymentOptions: no banks registered → exactly the two fixed options', async () => {
  settings.BANK_LIST = '';
  assert.deepEqual(await salesFlow.getPaymentOptions(), ['Cash', 'Not yet paid']);
  delete settings.BANK_LIST;
  assert.deepEqual(await salesFlow.getPaymentOptions(), ['Cash', 'Not yet paid']);
});

test('getPaymentOptions: "Credit" is never among the options', async () => {
  settings.BANK_LIST = 'GTBank';
  const opts = await salesFlow.getPaymentOptions();
  assert.ok(!opts.some((o) => /credit/i.test(o)), `no Credit option: ${opts}`);
});

test('getNextQuestion reads naturally with the new vocabulary', async () => {
  settings.BANK_LIST = 'GTBank';
  const opts = await salesFlow.getPaymentOptions();
  assert.equal(salesFlow.getNextQuestion('paymentMode', opts), 'Payment mode? (Cash / Not yet paid / GTBank)');
});

test('validateField(paymentMode): typed answers match the vocabulary case-insensitively and store the canonical value', async () => {
  settings.BANK_LIST = 'GTBank';
  assert.deepEqual(await salesFlow.validateField('paymentMode', 'not yet paid'), { valid: true, value: 'Not yet paid' });
  assert.deepEqual(await salesFlow.validateField('paymentMode', 'CASH'), { valid: true, value: 'Cash' });
  assert.deepEqual(await salesFlow.validateField('paymentMode', 'gtbank'), { valid: true, value: 'GTBank' });
});

test('validateField(paymentMode): a typed "Credit" is refused and the reply names the real options', async () => {
  settings.BANK_LIST = 'GTBank';
  const refused = await salesFlow.validateField('paymentMode', 'Credit');
  assert.equal(refused.valid, false);
  assert.equal(refused.message, 'Invalid payment mode. Options: Cash, Not yet paid, GTBank');
});
