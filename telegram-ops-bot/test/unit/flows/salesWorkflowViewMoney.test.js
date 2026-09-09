'use strict';

/**
 * CUR-1 C6/C7 → B — the 🚚 Pending Supply order card's customer money:
 * credit limit and ledger balance are sales-side master / receivable
 * figures and print bare through money.sale — no ₦, whatever CURRENCY is.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const ordersRepo = require('../../../src/repositories/ordersRepository');
const customersRepo = require('../../../src/repositories/customersRepository');
const ledgerCache = require('../../../src/repositories/ledgerBalanceCacheRepository');
const view = require('../../../src/flows/salesWorkflowView');

const ORDER = {
  order_id: 'ORD-9', design: '9043', shade: 'A', quantity: '3 bales',
  customer: 'Owaibula', status: 'pending', created_at: '2026-09-01T10:00:00Z',
};

function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}

async function openDetail({ balance, creditLimit = 250000 }) {
  const o1 = ordersRepo.getAll; const o2 = customersRepo.getAll; const o3 = ledgerCache.getAll;
  ordersRepo.getAll = async () => [ORDER];
  customersRepo.getAll = async () => [{ customer_id: 'C-1', name: 'Owaibula', category: 'Wholesale', credit_limit: creditLimit, phone: '0800' }];
  ledgerCache.getAll = async () => [{ customer_id: 'C-1', balance }];
  try {
    const bot = createFakeBot();
    await view.showOrderDetail(bot, '777', '777', null, 'ORD-9');
    return lastText(bot);
  } finally {
    ordersRepo.getAll = o1; customersRepo.getAll = o2; ledgerCache.getAll = o3;
  }
}

test('CUR-1 C6/C7: credit limit and ledger balance print bare on the order card', async () => {
  const text = await openDetail({ balance: 60000 });
  assert.match(text, /Credit limit: 250,000/, `bare credit limit, got: ${text}`);
  assert.match(text, /💰 Ledger: \*60,000\* credit/, 'bare ledger balance');
  assert.ok(!/₦|NGN/.test(text), 'no symbol or code on a sales-side card');
});

test('a debit balance prints bare with its sign and the word debit', async () => {
  const text = await openDetail({ balance: -12500 });
  assert.match(text, /💰 Ledger: \*-12,500\* debit/, `got: ${text}`);
  assert.ok(!/₦/.test(text));
});
