/**
 * Transaction Service — business logic for creating ledger transactions.
 * Architecture: validates input, generates id, appends to LedgerTransactions (source of truth),
 * then recalculates and updates LedgerBalanceCache. No direct sheet access; uses repositories only.
 */

const ledgerCustomersRepository = require('../repositories/ledgerCustomersRepository');
const ledgerTransactionsRepository = require('../repositories/ledgerTransactionsRepository');
const ledgerBalanceCacheRepository = require('../repositories/ledgerBalanceCacheRepository');
const idGen = require('../utils/idGenerator');

const { TXN_TYPES, DIRECTIONS } = ledgerTransactionsRepository;

/**
 * Create a ledger transaction and update balance cache.
 * Steps: validate customer exists → generate txn_id → append to LedgerTransactions → recalc balance → update LedgerBalanceCache.
 *
 * @param {string} customerId - Customer ID (must exist in Ledger_Customers)
 * @param {string} txnType - SALE | PAYMENT | ADJUSTMENT
 * @param {string} direction - 'debit' | 'credit'
 * @param {number} amount - Amount (positive)
 * @param {string} [description] - Human-readable description
 * @param {string} [reference] - Optional reference (e.g. invoice id)
 * @param {string} [createdBy] - User/actor who created the transaction
 * @returns {Promise<{ ok: boolean, txn_id?: string, balance?: number, message?: string }>}
 */
async function createTransaction(customerId, txnType, direction, amount, description = '', reference = '', createdBy = '') {
  if (!customerId || !txnType || direction === undefined) {
    return { ok: false, message: 'customerId, txnType and direction are required.' };
  }
  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    return { ok: false, message: 'Amount must be a positive number.' };
  }
  const dir = String(direction).toLowerCase();
  if (dir !== 'debit' && dir !== 'credit') {
    return { ok: false, message: 'Direction must be debit or credit.' };
  }
  const type = String(txnType).toUpperCase();
  if (!Object.values(TXN_TYPES).includes(type)) {
    return { ok: false, message: 'txnType must be SALE, PAYMENT, or ADJUSTMENT.' };
  }

  const customer = await ledgerCustomersRepository.findById(customerId);
  if (!customer) {
    return { ok: false, message: `Customer not found: ${customerId}. Add the customer in Ledger_Customers first.` };
  }

  const txnId = idGen.transaction();
  const timestamp = new Date().toISOString();
  await ledgerTransactionsRepository.append({
    txn_id: txnId,
    timestamp,
    customer_id: String(customerId),
    txn_type: type,
    direction: dir,
    amount: amt,
    description: String(description),
    reference: String(reference),
    created_by: String(createdBy),
    status: 'completed',
  });

  const newBalance = await recalculateCustomerBalance(customerId);
  await ledgerBalanceCacheRepository.set(customerId, newBalance);

  return { ok: true, txn_id: txnId, balance: newBalance };
}

/**
 * Recalculate customer balance from all transactions (debit increases receivable, credit decreases).
 * Used after each createTransaction and when cache is missing.
 */
async function recalculateCustomerBalance(customerId) {
  const txns = await ledgerTransactionsRepository.getByCustomerId(customerId);
  let balance = 0;
  for (const t of txns) {
    if (t.direction === 'debit') balance += t.amount;
    else balance -= t.amount;
  }
  return balance;
}

module.exports = {
  createTransaction,
  recalculateCustomerBalance,
  TXN_TYPES,
  DIRECTIONS,
};
