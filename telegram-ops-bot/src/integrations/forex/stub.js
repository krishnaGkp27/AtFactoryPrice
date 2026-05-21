'use strict';

/**
 * forex/stub.js — deterministic offline provider for tests / CI.
 *
 * Returns hard-coded rates with a tiny date-based jitter so unit tests
 * can pin behaviour without touching Sheets or the network. Never
 * throws. Costs zero.
 */

const STUB_RATES = {
  'USD/NGN': 1500,
  'NGN/USD': 1 / 1500,
  'USD/INR': 83,
  'INR/USD': 1 / 83,
  'USD/CNY': 7.2,
  'CNY/USD': 1 / 7.2,
  'EUR/USD': 1.08,
  'USD/EUR': 1 / 1.08,
};

function deterministicJitter(date) {
  // Tiny ±0.5% based on date so smoke tests can still detect "rate
  // changed" without a real API.
  if (!date) return 1;
  let h = 0;
  for (const c of date) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 1 + ((h % 100) - 50) / 10000;
}

async function rate(base, quote, date) {
  if (base === quote) return { rate: 1, source: 'stub', date, base, quote };
  const key = `${base}/${quote}`;
  const baseRate = STUB_RATES[key];
  if (baseRate === undefined) {
    return { rate: 1, source: `stub:unknown(${key})`, date, base, quote };
  }
  return {
    rate: +(baseRate * deterministicJitter(date)).toFixed(8),
    source: 'stub',
    date,
    base,
    quote,
  };
}

module.exports = { rate };
