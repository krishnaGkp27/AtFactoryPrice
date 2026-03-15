/**
 * Ledger Service — reads and formats customer ledger (transaction list with running balance).
 * Architecture: read LedgerTransactions via repository, filter by customer_id, sort by timestamp,
 * compute running balance, return formatted rows. No direct sheet access.
 */

const ledgerTransactionsRepository = require('../repositories/ledgerTransactionsRepository');
const ledgerCustomersRepository = require('../repositories/ledgerCustomersRepository');

/**
 * Get full ledger for a customer: all transactions sorted by time with running balance.
 * Steps: read LedgerTransactions → filter by customer_id → sort by timestamp → compute running balance → format.
 *
 * @param {string} customerId - Customer ID
 * @returns {Promise<{ ok: boolean, customer?: object, rows?: Array<{ date, description, debit, credit, balance }>, message?: string }>}
 */
async function getCustomerLedger(customerId) {
  if (!customerId) {
    return { ok: false, message: 'customerId is required.' };
  }

  const customer = await ledgerCustomersRepository.findById(customerId);
  if (!customer) {
    return { ok: false, message: `Customer not found: ${customerId}.` };
  }

  const txns = await ledgerTransactionsRepository.getByCustomerId(customerId);
  txns.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  let runningBalance = 0;
  const rows = txns.map((t) => {
    const debit = t.direction === 'debit' ? t.amount : 0;
    const credit = t.direction === 'credit' ? t.amount : 0;
    runningBalance += debit - credit;
    const date = (t.timestamp || '').slice(0, 10);
    return {
      date,
      description: t.description || `${t.txn_type} ${t.reference || t.txn_id}`.trim(),
      debit,
      credit,
      balance: runningBalance,
    };
  });

  return {
    ok: true,
    customer: { customer_id: customer.customer_id, customer_name: customer.customer_name },
    rows,
  };
}

module.exports = {
  getCustomerLedger,
};
