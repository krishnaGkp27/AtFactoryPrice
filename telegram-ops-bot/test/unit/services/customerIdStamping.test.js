'use strict';

/**
 * CUS-1 Phase C — every NEW money write carries the customer entity id.
 *
 * Names stay on the rows for human-readable sheets; the id is what makes
 * renames free and merges lossless. Historical rows are never rewritten —
 * reads resolve id-first with name-fallback.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '../../..');

// No credentials in tests (CLAUDE.md rule): stub the sheets client wholesale
// BEFORE any repo touches it. Reads return a header row; writes are captured.
const sheetsClient = require(path.join(ROOT, 'src/repositories/sheetsClient'));
const written = [];
sheetsClient.readRange = async () => [['h']];
sheetsClient.updateRange = async () => {};
sheetsClient.appendRows = async (_s, r) => { written.push(...r); };

test('a transactions row carries CustomerId at the END column', async () => {
  const transactionsRepository = require(path.join(ROOT, 'src/repositories/transactionsRepository'));
  written.length = 0;
  await transactionsRepository.append({
    user: '4242', action: 'sell_package', design: '77016', qty: 60,
    customerName: 'CJE', customerId: 'CUST-1', saleRefId: 'R-1',
  });
  assert.equal(written.length, 1);
  assert.equal(written[0][11], 'CJE', 'the NAME stays where it always was');
  assert.equal(written[0][18], 'CUST-1', 'the entity id rides at the END column');
  assert.equal(written[0].length, 19, 'exactly one column added, at the end');
});

test('parsed transactions expose customerId', () => {
  const { parseRow } = require(path.join(ROOT, 'src/repositories/transactionsRepository'));
  const r = new Array(19).fill('');
  r[11] = 'CJE'; r[18] = 'CUST-1';
  const t = parseRow(r);
  assert.equal(t.customerName, 'CJE');
  assert.equal(t.customerId, 'CUST-1');
});

test('a ledger entry carries customer_id — the money row keys on the entity', async () => {
  const accountingService = require(path.join(ROOT, 'src/services/accountingService'));
  const ledgerRepo = require(path.join(ROOT, 'src/repositories/ledgerRepository'));
  const entries = [];
  const orig = ledgerRepo.append;
  ledgerRepo.append = async (e) => { entries.push(e); };
  try {
    await accountingService.recordSale({
      customer: 'CJE', customerId: 'CUST-1', yards: 60, pricePerYard: 1500,
      packageNo: '896', design: '77016', userId: '4242', txnId: 'SP-896',
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].customer_id, 'CUST-1');
    assert.match(entries[0].narration, /CJE/, 'the narration keeps the readable name');
    assert.equal(entries[0].debit, 90000);
  } finally {
    ledgerRepo.append = orig;
  }
});

test('the sale executor forwards customerId from the approval payload', async () => {
  // The chain that matters: admin assigns customer at approval (name + id on
  // actionJSON) → executor stamps BOTH into Transactions and the erp event.
  const src = require('fs').readFileSync(path.join(ROOT, 'src/services/inventoryService.js'), 'utf8');
  const sellPackageBranch = src.slice(src.indexOf("aj.action === 'sell_package'"), src.indexOf("aj.action === 'return_than'"));
  assert.match(sellPackageBranch, /customerId: aj\.customerId/, 'transactions row gets the id');
  const bundleBranch = src.slice(src.indexOf("action: 'sale_bundle', design: ''"));
  assert.match(bundleBranch.slice(0, 900), /customerId: aj\.customerId/, 'bundle rows too');
});

test('getCustomer is alias-aware — an old spelling finds the merged customer', async () => {
  const crmService = require(path.join(ROOT, 'src/services/crmService'));
  const customersRepository = require(path.join(ROOT, 'src/repositories/customersRepository'));
  const orig = customersRepository.getAll;
  customersRepository.getAll = async () => ([
    { rowIndex: 2, customer_id: 'CUST-1', name: 'CJE', status: 'Active', aliases: ['C.J.E'], outstanding_balance: 5000 },
  ]);
  try {
    const byAlias = await crmService.getCustomer('C.J.E');
    assert.equal(byAlias.customer_id, 'CUST-1', 'payments for the old spelling land on the real customer');
    const byId = await crmService.getCustomer('CUST-1');
    assert.equal(byId.name, 'CJE');
  } finally {
    customersRepository.getAll = orig;
  }
});
