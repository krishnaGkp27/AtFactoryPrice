'use strict';

/**
 * banking/stub.js — deterministic in-memory bank feed.
 *
 * Returns three fake transactions per call so dev / CI can drive the
 * reconciler UI end-to-end without real bank credentials.
 */

async function fetchTransactions(opts = {}) {
  const now = Date.now();
  const ONE_HOUR = 3600_000;
  const acct = opts.accountId || 'STUB-ACCT-001';
  return {
    transactions: [
      {
        txnId: `STUB-${now - 3 * ONE_HOUR}`,
        accountId: acct,
        postedAt: new Date(now - 3 * ONE_HOUR).toISOString(),
        amount: 125000,
        currency: 'NGN',
        direction: 'credit',
        counterparty: 'BLUE SKIES TEXTILES LTD',
        narration: 'Payment for INV-2025-001',
        reference: 'REF/STUB/001',
      },
      {
        txnId: `STUB-${now - 2 * ONE_HOUR}`,
        accountId: acct,
        postedAt: new Date(now - 2 * ONE_HOUR).toISOString(),
        amount: 47500,
        currency: 'NGN',
        direction: 'debit',
        counterparty: 'IDUMOTA LOGISTICS',
        narration: 'Cartage fee',
        reference: 'REF/STUB/002',
      },
      {
        txnId: `STUB-${now - ONE_HOUR}`,
        accountId: acct,
        postedAt: new Date(now - ONE_HOUR).toISOString(),
        amount: 88000,
        currency: 'NGN',
        direction: 'credit',
        counterparty: 'ABDUL ENTERPRISES',
        narration: '',
        reference: 'REF/STUB/003',
      },
    ],
  };
}

module.exports = { fetchTransactions };
