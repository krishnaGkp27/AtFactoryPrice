'use strict';

/**
 * shipment/stub.js — deterministic offline tracker.
 *
 * Synthesises a plausible 3-event lifecycle based on the tracking
 * number so dev / CI / unconfigured prod can still demo the flow.
 */

function deterministicHash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

async function track(trackingNumber) {
  const h = deterministicHash(trackingNumber);
  const stage = h % 4;
  const now = Date.now();
  const ONE_DAY = 86400_000;
  const events = [
    { time: new Date(now - 3 * ONE_DAY).toISOString(), status: 'INFO_RECEIVED', location: 'Origin', description: 'Shipment information received' },
  ];
  if (stage >= 1) events.push({ time: new Date(now - 2 * ONE_DAY).toISOString(), status: 'PICKED_UP', location: 'Origin', description: 'Picked up by courier' });
  if (stage >= 2) events.push({ time: new Date(now - ONE_DAY).toISOString(),    status: 'IN_TRANSIT', location: 'Hub', description: 'In transit' });
  if (stage >= 3) events.push({ time: new Date(now).toISOString(),              status: 'DELIVERED',  location: 'Destination', description: 'Delivered' });
  return {
    carrier: 'stub',
    status: events[events.length - 1].status,
    events,
  };
}

module.exports = { track };
