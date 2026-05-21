'use strict';

/**
 * forex/openExchangeRates.js — openexchangerates.org provider.
 *
 * SCAFFOLD ONLY. Not wired into any scheduler; flip FOREX_PROVIDER to
 * activate. OXR returns rates with USD as the base, so cross-pairs are
 * derived locally.
 */

const https = require('https');
const config = require('../../config');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

async function rate(base, quote, date) {
  const appId = config.integrations.forex.openExchangeRatesAppId;
  if (!appId) {
    const err = new Error('FOREX_OPEN_EXCHANGE_RATES_APP_ID not configured');
    err.code = 'FOREX_NO_KEY';
    throw err;
  }
  // Historical endpoint requires paid plan; free tier uses /latest.json.
  const url = `https://openexchangerates.org/api/latest.json?app_id=${appId}`;
  const data = await httpGetJson(url);
  const rates = data && data.rates;
  if (!rates) throw new Error('openExchangeRates: malformed response');
  const usdToBase  = base  === 'USD' ? 1 : Number(rates[base]);
  const usdToQuote = quote === 'USD' ? 1 : Number(rates[quote]);
  if (!usdToBase || !usdToQuote) throw new Error(`openExchangeRates: rate missing for ${base} or ${quote}`);
  return {
    rate: +(usdToQuote / usdToBase).toFixed(8),
    source: 'openExchangeRates',
    date,
    base,
    quote,
  };
}

module.exports = { rate };
