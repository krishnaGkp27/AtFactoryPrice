'use strict';

/**
 * src/integrations/_shared/costRegistry.js
 *
 * Static lookup table for the future "cost report" feature. Each
 * provider declares its per-call cost here so an admin can later see
 * "this month we spent $X on WhatsApp + $Y on shipment tracking".
 *
 * Costs are illustrative best-guesses (USD per call) and should be
 * tuned once we have actual invoices. Stub costs are always 0.
 *
 * Providers consult this registry inside getEstimatedCost() rather
 * than hard-coding constants in each file, so updating costs is a
 * single-file edit.
 */

const COSTS = {
  // capability.provider → { unit, costUsd, notes }
  'monitoring.glitchTip': { unit: 'event', costUsd: 0.00, notes: 'self-hosted on existing VPS' },
  'monitoring.sentry':    { unit: 'event', costUsd: 0.00026, notes: '~$26/100k events on Sentry Team plan' },
  'monitoring.stub':      { unit: 'event', costUsd: 0 },

  'forex.manual':         { unit: 'rate',  costUsd: 0,        notes: 'admin enters rate; cost is operator time' },
  'forex.exchangeRateApi':  { unit: 'request', costUsd: 0,     notes: 'free tier — 1500 req/mo' },
  'forex.openExchangeRates':{ unit: 'request', costUsd: 0.0002, notes: 'paid tier ~$12/mo / 60k requests' },
  'forex.stub':           { unit: 'request', costUsd: 0 },

  'shipment.dhlExpress':  { unit: 'tracking_query', costUsd: 0,    notes: 'tracking API is free for account holders' },
  'shipment.stub':        { unit: 'tracking_query', costUsd: 0 },

  'banking.zenithBank':   { unit: 'request', costUsd: 0,     notes: 'direct API — fee TBD per agreement' },
  'banking.mono':         { unit: 'sync',    costUsd: 0.10,  notes: 'roughly NGN 150 per account sync' },
  'banking.stub':         { unit: 'request', costUsd: 0 },

  'messaging.metaWhatsApp': { unit: 'conversation', costUsd: 0.005,  notes: 'NG utility template, post-2024 pricing' },
  'messaging.twilio':       { unit: 'message',      costUsd: 0.045,  notes: 'NG outbound, list price' },
  'messaging.stub':         { unit: 'message',      costUsd: 0 },
};

/**
 * @param {string} capability
 * @param {string} providerName
 * @param {object} [payload]    quantity hint (e.g. {count: 50} for bulk)
 * @returns {{ provider: string, capability: string, unit: string, perUnitCostUsd: number, totalUsd: number, notes?: string }}
 */
function estimate(capability, providerName, payload = {}) {
  const key = `${capability}.${providerName}`;
  const entry = COSTS[key];
  if (!entry) {
    return {
      provider: providerName,
      capability,
      unit: 'unknown',
      perUnitCostUsd: 0,
      totalUsd: 0,
      notes: 'no cost registered',
    };
  }
  const count = (payload && Number(payload.count)) || 1;
  return {
    provider: providerName,
    capability,
    unit: entry.unit,
    perUnitCostUsd: entry.costUsd,
    totalUsd: +(entry.costUsd * count).toFixed(6),
    ...(entry.notes ? { notes: entry.notes } : {}),
  };
}

module.exports = { estimate, COSTS };
