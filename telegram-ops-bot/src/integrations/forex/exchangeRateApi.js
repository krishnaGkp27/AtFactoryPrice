'use strict';

/**
 * forex/exchangeRateApi.js — exchangerate-api.com provider.
 *
 * SCAFFOLD ONLY. Per current business decision (manual rates by admin
 * / finance), this provider is not wired into any scheduler. Flipping
 * FOREX_PROVIDER=exchangeRateApi switches the live `rate()` call here.
 *
 * Free tier: 1500 req/mo, daily rates, no historical without paid plan.
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
  const key = config.integrations.forex.exchangeRateApiKey;
  if (!key) {
    const err = new Error('FOREX_EXCHANGE_RATE_API_KEY not configured');
    err.code = 'FOREX_NO_KEY';
    throw err;
  }
  const url = `https://v6.exchangerate-api.com/v6/${key}/pair/${base}/${quote}`;
  const data = await httpGetJson(url);
  if (data.result !== 'success') {
    throw new Error(`exchangerate-api error: ${data['error-type'] || 'unknown'}`);
  }
  return {
    rate: Number(data.conversion_rate),
    source: 'exchangeRateApi',
    date,
    base,
    quote,
  };
}

module.exports = { rate };
