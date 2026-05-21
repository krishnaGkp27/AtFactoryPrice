'use strict';

/**
 * banking/zenithBank.js — Zenith Bank Nigeria corporate-API scaffold.
 *
 * Zenith provides a corporate-banking API to authenticated business
 * customers (account-statement + balance endpoints). The exact
 * endpoint + auth scheme is negotiated per agreement (TLS client cert
 * + API key) so this file is a SCAFFOLD: it accepts the env config
 * and throws a clear error if invoked without it. The signature
 * matches the public contract so flipping `BANKING_PROVIDER=zenithBank`
 * is the only change needed once credentials land.
 */

const config = require('../../config');

async function fetchTransactions(opts = {}) {
  const { zenithApiKey, zenithAccountId } = config.integrations.banking;
  if (!zenithApiKey || !zenithAccountId) {
    const err = new Error('BANKING_ZENITH_API_KEY and/or BANKING_ZENITH_ACCOUNT_ID not configured');
    err.code = 'BANKING_NO_KEY';
    throw err;
  }
  // Real call will be implemented once Zenith credentials + endpoint
  // are finalised. Until then, fail loudly so an accidental env flip
  // doesn't silently return empty data.
  const err = new Error('zenithBank provider: live endpoint not yet wired. Keep BANKING_PROVIDER=stub.');
  err.code = 'BANKING_NOT_WIRED';
  throw err;
}

module.exports = { fetchTransactions };
