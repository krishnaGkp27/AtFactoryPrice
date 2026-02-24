/**
 * Double-entry accounting service. Creates balanced debit/credit pairs in Ledger_Entries.
 */

const ledgerRepo = require('../repositories/ledgerRepository');
const chartRepo = require('../repositories/chartOfAccountsRepository');
const idGen = require('../utils/idGenerator');
const config = require('../config');

const CURRENCY = config.currency || 'NGN';

async function getAccountCode(name) {
  const acc = await chartRepo.findByName(name);
  return acc ? acc.account_code : null;
}

async function recordSale({ customer, yards, pricePerYard, packageNo, design, shade, userId, txnId }) {
  const amount = (yards || 0) * (pricePerYard || 0);
  if (amount <= 0) return;
  const date = new Date().toISOString().split('T')[0];
  const debitCode = await getAccountCode('Customer Receivable') || '1100';
  const creditCode = await getAccountCode('Sales Revenue') || '3001';
  const narration = `Sale: ${yards} yds ${design || ''} ${shade || ''} pkg ${packageNo || ''} to ${customer || 'unknown'}`;
  await ledgerRepo.appendPair(
    { entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: debitCode, ledger_name: 'Customer Receivable', debit: amount, narration, created_by: userId || '' },
    { entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: creditCode, ledger_name: 'Sales Revenue', credit: amount, narration, created_by: userId || '' },
  );
  return { amount, narration };
}

async function recordReturn({ yards, pricePerYard, packageNo, design, shade, userId, txnId }) {
  const amount = (yards || 0) * (pricePerYard || 0);
  if (amount <= 0) return;
  const date = new Date().toISOString().split('T')[0];
  const debitCode = await getAccountCode('Sales Revenue') || '3001';
  const creditCode = await getAccountCode('Customer Receivable') || '1100';
  const narration = `Return: ${yards} yds ${design || ''} ${shade || ''} pkg ${packageNo || ''}`;
  await ledgerRepo.appendPair(
    { entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: debitCode, ledger_name: 'Sales Revenue', debit: amount, narration, created_by: userId || '' },
    { entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: creditCode, ledger_name: 'Customer Receivable', credit: amount, narration, created_by: userId || '' },
  );
}

async function recordPaymentReceived({ customer, amount, method, userId, txnId }) {
  if (!amount || amount <= 0) return;
  const date = new Date().toISOString().split('T')[0];
  const cashOrBank = (method || '').toLowerCase().includes('bank') ? 'Bank' : 'Cash';
  const debitCode = await getAccountCode(cashOrBank) || '1001';
  const creditCode = await getAccountCode('Customer Receivable') || '1100';
  const narration = `Payment received from ${customer || 'unknown'}: ${CURRENCY} ${amount} via ${cashOrBank}`;
  await ledgerRepo.appendPair(
    { entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: debitCode, ledger_name: cashOrBank, debit: amount, narration, created_by: userId || '' },
    { entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: creditCode, ledger_name: 'Customer Receivable', credit: amount, narration, created_by: userId || '' },
  );
}

async function getLedgerBalance(accountCode) {
  const entries = await ledgerRepo.findByAccount(accountCode);
  const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
  const totalCredit = entries.reduce((s, e) => s + e.credit, 0);
  return { accountCode, totalDebit, totalCredit, balance: totalDebit - totalCredit };
}

async function getTrialBalance() {
  const accounts = await chartRepo.getAll();
  const all = await ledgerRepo.getAll();
  const results = [];
  for (const acc of accounts) {
    const entries = all.filter((e) => e.account_code === acc.account_code);
    const debit = entries.reduce((s, e) => s + e.debit, 0);
    const credit = entries.reduce((s, e) => s + e.credit, 0);
    if (debit || credit) {
      results.push({ ...acc, totalDebit: debit, totalCredit: credit, balance: debit - credit });
    }
  }
  return results;
}

async function getDaybook(date) {
  const target = date || new Date().toISOString().split('T')[0];
  return ledgerRepo.findByDateRange(target, target);
}

module.exports = { recordSale, recordReturn, recordPaymentReceived, getLedgerBalance, getTrialBalance, getDaybook };
