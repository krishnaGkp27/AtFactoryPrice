'use strict';

/**
 * shipment/dhlExpress.js — DHL Express Tracking Unified API.
 *
 * Endpoint:  https://api-eu.dhl.com/track/shipments
 * Auth:      header `DHL-API-Key: <SHIPMENT_DHL_API_KEY>`
 * Docs:      developer.dhl.com → Shipment Tracking Unified
 *
 * The real HTTP call is implemented; without an API key the module
 * throws a clear `code: 'SHIPMENT_NO_KEY'` so the index falls back to
 * the stub on next boot (via env reconfiguration) and the admin sees
 * the audit row.
 */

const https = require('https');
const config = require('../../config');

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
    };
    const req = https.request(opts, (res) => {
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

async function track(trackingNumber) {
  const apiKey = config.integrations.shipment.dhlApiKey;
  if (!apiKey) {
    const err = new Error('SHIPMENT_DHL_API_KEY not configured');
    err.code = 'SHIPMENT_NO_KEY';
    throw err;
  }
  const url = `https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}`;
  const data = await httpGetJson(url, {
    'DHL-API-Key': apiKey,
    'Accept': 'application/json',
  });
  const shipments = (data && data.shipments) || [];
  if (!shipments.length) {
    return { carrier: 'DHL Express', status: 'UNKNOWN', events: [], _raw: data };
  }
  const sh = shipments[0];
  const events = (sh.events || []).map((e) => ({
    time:        e.timestamp,
    status:      e.statusCode || e.status,
    location:    e.location && e.location.address ? [e.location.address.addressLocality, e.location.address.countryCode].filter(Boolean).join(', ') : '',
    description: e.description || '',
  }));
  return {
    carrier: 'DHL Express',
    status: (sh.status && (sh.status.statusCode || sh.status.status)) || (events[0] && events[0].status) || 'UNKNOWN',
    events,
    _raw: data,
  };
}

module.exports = { track };
