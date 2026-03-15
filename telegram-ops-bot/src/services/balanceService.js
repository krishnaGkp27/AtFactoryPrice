/**
 * Balance Service — returns current balance for a customer.
 * Architecture: read LedgerBalanceCache first; if not available, calculate from LedgerTransactions and update cache.
 */

const ledgerBalanceCacheRepository = require('../repositories/ledgerBalanceCacheRepository');
const ledgerCustomersRepository = require('../repositories/ledgerCustomersRepository');
const transactionService = require('./transactionService');

/**
 * Get current balance for a customer.
 * Steps: read LedgerBalanceCache → if missing, recalculate from transactions and update cache → return balance.
 *
 * @param {string} customerId - Customer ID
 * @returns {Promise<{ ok: boolean, balance?: number, customer_name?: string, message?: string }>}
 */
async function getCustomerBalance(customerId) {
  if (!customerId) {
    return { ok: false, message: 'customerId is required.' };
  }

  const customer = await ledgerCustomersRepository.findById(customerId);
  if (!customer) {
    return { ok: false, message: `Customer not found: ${customerId}.` };
  }

  let balance = await ledgerBalanceCacheRepository.get(customerId);
  if (balance === null) {
    balance = await transactionService.recalculateCustomerBalance(customerId);
    await ledgerBalanceCacheRepository.set(customerId, balance);
  }

  return {
    ok: true,
    balance,
    customer_name: customer.customer_name,
  };
}

module.exports = {
  getCustomerBalance,
};
