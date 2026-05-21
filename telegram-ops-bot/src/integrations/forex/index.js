'use strict';

/**
 * src/integrations/forex/index.js — public contract.
 *
 * Capability: get an FX rate for a (base, quote, date) triple.
 *
 * Per business decision: the company does NOT convert at payment time.
 * Admin / finance enters rates MANUALLY into the ForexRates sheet.
 * Therefore default provider is `manual`. The `exchangeRateApi` and
 * `openExchangeRates` providers are scaffolded for a future toggle-on;
 * they are not wired into any scheduler in this commit.
 *
 * Public surface:
 *   rate(from, to, date?)  →  { rate, source, date }
 *   getEstimatedCost(payload)
 */

const { selectProvider } = require('../_shared/providerSelector');
const { wrapOutbound }   = require('../_shared/auditWrapper');
const { estimate }       = require('../_shared/costRegistry');

const providers = {
  manual:             require('./manual'),
  stub:               require('./stub'),
  exchangeRateApi:    require('./exchangeRateApi'),
  openExchangeRates:  require('./openExchangeRates'),
};

const { name: providerName, module: provider } = selectProvider('forex', providers);

/**
 * @param {string} from   ISO-4217 (e.g. 'NGN')
 * @param {string} to     ISO-4217 (e.g. 'USD')
 * @param {string} [date] YYYY-MM-DD; defaults to today
 * @returns {Promise<{rate:number, source:string, date:string, base:string, quote:string}>}
 */
async function rate(from, to, date) {
  const today = new Date().toISOString().slice(0, 10);
  const useDate = date || today;
  return wrapOutbound(
    'forex', providerName, 'rate',
    { from, to, date: useDate },
    () => provider.rate(String(from).toUpperCase(), String(to).toUpperCase(), useDate),
  );
}

function getEstimatedCost(payload) {
  return estimate('forex', providerName, payload);
}

module.exports = {
  rate,
  getEstimatedCost,
  _providerName: providerName,
};
