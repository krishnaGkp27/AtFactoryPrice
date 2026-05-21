'use strict';

/**
 * src/integrations/banking/index.js — public contract.
 *
 * Capability: pull recent bank-feed transactions from the company's
 * bank so the bot can suggest matches against open customer
 * receivables / supplier payables in the ledger.
 *
 * Public surface:
 *   fetchTransactions(opts) → { transactions:[{txnId, postedAt, amount, currency, direction, counterparty, narration, reference}] }
 *   getEstimatedCost(payload)
 *
 * Persistence happens via `bankFeedRepository.upsert()` — keyed by
 * `txn_id` so re-fetching the same window is idempotent.
 *
 * The matcher / reconciler (`src/services/bankReconciler.js`) is a
 * sibling concern, not part of the adapter — adapter only fetches.
 */

const { selectProvider } = require('../_shared/providerSelector');
const { wrapOutbound }   = require('../_shared/auditWrapper');
const { estimate }       = require('../_shared/costRegistry');

const providers = {
  stub:        require('./stub'),
  zenithBank:  require('./zenithBank'),
  mono:        require('./mono'),
  // setu:     require('./setu'),  // Phase 2 placeholder — README only
};

const { name: providerName, module: provider } = selectProvider('banking', providers);

/**
 * @param {{ since?:string, until?:string, accountId?:string }} [opts]
 * @returns {Promise<{ transactions: Array }>}
 */
async function fetchTransactions(opts = {}) {
  return wrapOutbound(
    'banking', providerName, 'fetchTransactions',
    { since: opts.since, until: opts.until, accountId: opts.accountId },
    () => provider.fetchTransactions(opts),
  );
}

function getEstimatedCost(payload) {
  return estimate('banking', providerName, payload);
}

module.exports = {
  fetchTransactions,
  getEstimatedCost,
  _providerName: providerName,
};
