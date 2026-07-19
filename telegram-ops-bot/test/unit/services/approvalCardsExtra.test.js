'use strict';

/**
 * APU-2 — the finance-context card builders: payment approval with the
 * live outstanding balance, and bank removal with usage context.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const accountingService = require(path.join(SRC, 'services/accountingService'));
const receiptsRepository = require(path.join(SRC, 'repositories/receiptsRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));

test('payment card shows outstanding, after-payment figure, and an over-payment warning', async () => {
  accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 200000 });
  let card = await approvalCards.buildPaymentCard({ customer: 'OKESON', amount: 50000, method: 'bank' });
  assert.match(card, /Customer: OKESON/);
  assert.match(card, /Amount: ₦50,000/);
  assert.match(card, /Outstanding today: ₦200,000/);
  assert.match(card, /After this payment: ₦150,000/);
  assert.ok(!/EXCEEDS/.test(card));

  card = await approvalCards.buildPaymentCard({ customer: 'OKESON', amount: 250000, method: 'cash' });
  assert.match(card, /⚠️ Payment EXCEEDS the outstanding balance\./);

  // Ledger down → card still renders, with an honest note.
  accountingService.getCustomerLedger = async () => { throw new Error('sheets down'); };
  card = await approvalCards.buildPaymentCard({ customer: 'CJE', amount: 100, method: 'cash' });
  assert.match(card, /Outstanding balance unavailable/);
});

test('remove-bank card counts receipts against the bank and warns about history', async () => {
  receiptsRepository.getAll = async () => [
    { receipt_id: 'R1', bank_account: 'Penta', created_at: '2026-07-01T10:00:00Z' },
    { receipt_id: 'R2', bank_account: 'penta', created_at: '2026-07-15T10:00:00Z' },
    { receipt_id: 'R3', bank_account: 'GTB', created_at: '2026-07-10T10:00:00Z' },
  ];
  const card = await approvalCards.buildRemoveBankCard({ bankName: 'Penta' });
  assert.match(card, /Bank: Penta/);
  assert.match(card, /Receipts recorded against it: 2/, 'case-insensitive bank match');
  assert.match(card, /Most recent: 15-Jul-2026/);
  assert.match(card, /Removal only hides it from pickers/);
});
