'use strict';

/**
 * banking/mono.js — Mono Connect (mono.co) account-feed provider.
 *
 * Mono Connect aggregates Nigerian bank accounts via a single API. The
 * flow is:
 *   1. User links their bank account via Mono Widget (one-time
 *      browser flow → returns an `account_id`).
 *   2. We store `account_id` in `BANKING_MONO_ACCOUNT_ID` (or per-bank
 *      Settings row).
 *   3. We hit `/accounts/{id}/transactions` with `BANKING_MONO_SECRET_KEY`
 *      header to pull the feed.
 *
 * This file implements step 3. The widget flow is operator-driven,
 * not bot-driven.
 *
 * Endpoint:  https://api.withmono.com/accounts/{accountId}/transactions
 * Auth:      header `mono-sec-key: <BANKING_MONO_SECRET_KEY>`
 * Docs:      docs.mono.co/api → Connect → Transactions
 */

const https = require('https');
const config = require('../../config');

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 240)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchTransactions(opts = {}) {
  const secret = config.integrations.banking.monoSecretKey;
  const accountId = opts.accountId;
  if (!secret) {
    const err = new Error('BANKING_MONO_SECRET_KEY not configured');
    err.code = 'BANKING_NO_KEY';
    throw err;
  }
  if (!accountId) {
    const err = new Error('mono provider requires opts.accountId (linked via Mono Widget first)');
    err.code = 'BANKING_NO_ACCOUNT';
    throw err;
  }
  const params = new URLSearchParams();
  if (opts.since) params.set('start', opts.since);
  if (opts.until) params.set('end', opts.until);
  const qs = params.toString();
  const url = `https://api.withmono.com/accounts/${encodeURIComponent(accountId)}/transactions${qs ? '?' + qs : ''}`;
  const data = await httpGetJson(url, { 'mono-sec-key': secret, Accept: 'application/json' });
  const list = (data && (data.data || data.transactions)) || [];
  return {
    transactions: list.map((t) => ({
      txnId:        t._id || t.id,
      accountId,
      postedAt:     t.date || t.posted_at || '',
      amount:       Number(t.amount) / 100, // Mono returns kobo
      currency:     t.currency || 'NGN',
      direction:    (t.type || '').toLowerCase() === 'credit' ? 'credit' : 'debit',
      counterparty: t.counterparty || '',
      narration:    t.narration || '',
      reference:    t.reference || '',
    })),
  };
}

module.exports = { fetchTransactions };
