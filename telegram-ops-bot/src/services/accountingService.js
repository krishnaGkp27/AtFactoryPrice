/**
 * Accounting service. Sales and returns: single entry (Customer Receivable only).
 * Payments: double entry (Cash/Bank DR, Receivable CR). Sales Revenue in trial balance derived from receivable sale debits (Option B).
 */

const ledgerRepo = require('../repositories/ledgerRepository');
const chartRepo = require('../repositories/chartOfAccountsRepository');
const idGen = require('../utils/idGenerator');
const config = require('../config');

const CURRENCY = config.currency || 'NGN';
const RECEIVABLE_CODE = '1100';
const REVENUE_CODE = '3001';

async function getAccountCode(name) {
  const acc = await chartRepo.findByName(name);
  return acc ? acc.account_code : null;
}

/** Single entry: one row to Customer Receivable (debit). Narration includes payment status at time of sale. */
async function recordSale({ customer, yards, pricePerYard, packageNo, design, shade, userId, txnId, paymentMode, amountPaid }) {
  const amount = (yards || 0) * (pricePerYard || 0);
  if (amount <= 0) return;
  const date = new Date().toISOString().split('T')[0];
  const debitCode = await getAccountCode('Customer Receivable') || RECEIVABLE_CODE;
  const payMode = (paymentMode || '').trim() || 'Not yet paid';
  const paid = Number(amountPaid) || 0;
  const paymentDetail = paid > 0 ? ` | ${payMode} ${CURRENCY} ${paid}` : ` | ${payMode}`;
  const narration = `Sale: ${yards} yds ${design || ''} ${shade || ''} pkg ${packageNo || ''} to ${customer || 'unknown'}${paymentDetail}`;
  await ledgerRepo.append({
    entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: debitCode, ledger_name: 'Customer Receivable',
    debit: amount, credit: 0, narration, created_by: userId || '',
  });
  return { amount, narration };
}

/** Single entry: one row to Customer Receivable (credit). */
async function recordReturn({ yards, pricePerYard, packageNo, design, shade, userId, txnId }) {
  const amount = (yards || 0) * (pricePerYard || 0);
  if (amount <= 0) return;
  const date = new Date().toISOString().split('T')[0];
  const creditCode = await getAccountCode('Customer Receivable') || RECEIVABLE_CODE;
  const narration = `Return: ${yards} yds ${design || ''} ${shade || ''} pkg ${packageNo || ''}`;
  await ledgerRepo.append({
    entry_id: idGen.ledgerEntry(), txn_id: txnId || '', date, account_code: creditCode, ledger_name: 'Customer Receivable',
    debit: 0, credit: amount, narration, created_by: userId || '',
  });
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

/** Trial balance. Sales Revenue (3001): derived from Customer Receivable debits where narration starts with "Sale:" (Option B). */
async function getTrialBalance() {
  const accounts = await chartRepo.getAll();
  const all = await ledgerRepo.getAll();
  const receivableCode = await getAccountCode('Customer Receivable') || RECEIVABLE_CODE;
  const revenueCode = await getAccountCode('Sales Revenue') || REVENUE_CODE;
  const derivedRevenue = all
    .filter((e) => e.account_code === receivableCode && (e.narration || '').trim().startsWith('Sale:'))
    .reduce((s, e) => s + (e.debit || 0), 0);
  const results = [];
  for (const acc of accounts) {
    const entries = all.filter((e) => e.account_code === acc.account_code);
    let debit = entries.reduce((s, e) => s + (e.debit || 0), 0);
    let credit = entries.reduce((s, e) => s + (e.credit || 0), 0);
    if (acc.account_code === revenueCode) {
      credit += derivedRevenue;
    }
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

/**
 * Get customer ledger (Customer Receivable only). Optional fromDate, toDate (YYYY-MM-DD) filter entries to that range.
 * Always returns outstandingAsOfToday (full ledger balance). For range view, outstanding = balance at end of range.
 */
async function getCustomerLedger(customerName, fromDate, toDate) {
  const receivableCode = await getAccountCode('Customer Receivable') || RECEIVABLE_CODE;
  const receivableEntries = await ledgerRepo.findByAccount(receivableCode);
  const q = (customerName || '').toLowerCase();
  const allEntries = q ? receivableEntries.filter((e) => (e.narration || '').toLowerCase().includes(q)) : [];
  allEntries.sort((a, b) => (a.date + (a.created_at || '')).localeCompare(b.date + (b.created_at || '')));
  let runningFull = 0;
  const withRunning = allEntries.map((e) => {
    runningFull += (e.debit || 0) - (e.credit || 0);
    return { ...e, running: runningFull };
  });
  const outstandingAsOfToday = runningFull;

  if (fromDate && toDate) {
    const filtered = withRunning.filter((e) => e.date >= fromDate && e.date <= toDate);
    const totalDebit = filtered.reduce((s, e) => s + (e.debit || 0), 0);
    const totalCredit = filtered.reduce((s, e) => s + (e.credit || 0), 0);
    const lastInRange = filtered[filtered.length - 1];
    const outstandingAtEndOfRange = lastInRange ? lastInRange.running : 0;
    return {
      entries: filtered,
      totalDebit,
      totalCredit,
      outstanding: outstandingAtEndOfRange,
      outstandingAsOfToday,
    };
  }
  const totalDebit = allEntries.reduce((s, e) => s + (e.debit || 0), 0);
  const totalCredit = allEntries.reduce((s, e) => s + (e.credit || 0), 0);
  return {
    entries: withRunning,
    totalDebit,
    totalCredit,
    outstanding: totalDebit - totalCredit,
    outstandingAsOfToday,
  };
}

module.exports = { recordSale, recordReturn, recordPaymentReceived, getLedgerBalance, getTrialBalance, getDaybook, getCustomerLedger };
