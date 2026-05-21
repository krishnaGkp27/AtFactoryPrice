'use strict';

/**
 * forex/manual.js — manual-rate provider (DEFAULT).
 *
 * Reads the ForexRates sheet (owned by forexRatesRepository) and
 * returns the most-recent entry on/before the requested date for the
 * given (base, quote) pair. Throws a clear, user-actionable error if
 * no rate is on file — the calling flow should surface "Ask an admin
 * to set today's FX rate" rather than guess.
 *
 * Inverse lookup: if (USD→NGN) is requested but only (NGN→USD) is on
 * file, we compute 1/rate and tag the source `manual:inverse`. This
 * matches how admins typically enter rates (single direction).
 */

const forexRatesRepository = require('../../repositories/forexRatesRepository');

async function rate(base, quote, date) {
  base = String(base).toUpperCase();
  quote = String(quote).toUpperCase();

  if (base === quote) {
    return { rate: 1, source: 'manual:identity', date, base, quote };
  }

  const all = await forexRatesRepository.findOnOrBefore(date);
  const direct = all.find((r) => r.base === base && r.quote === quote);
  if (direct) {
    return {
      rate: direct.rate,
      source: `manual:${direct.source || 'admin'}`,
      date: direct.date,
      base,
      quote,
    };
  }
  const inverse = all.find((r) => r.base === quote && r.quote === base);
  if (inverse) {
    return {
      rate: +(1 / inverse.rate).toFixed(8),
      source: `manual:inverse(${inverse.source || 'admin'})`,
      date: inverse.date,
      base,
      quote,
    };
  }
  const err = new Error(
    `No manual FX rate on file for ${base}/${quote} on or before ${date}. ` +
    `Ask an admin to set it via Admin Settings → 💱 Forex Rates.`,
  );
  err.code = 'FOREX_NO_MANUAL_RATE';
  throw err;
}

module.exports = { rate };
