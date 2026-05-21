'use strict';

/**
 * src/integrations/shipment/index.js — public contract.
 *
 * Capability: track a courier shipment by tracking number. Returns
 * latest status + event history. Persists every fetched event to the
 * ShipmentEvents sheet so admins have a chronological trail without
 * having to re-poll the carrier.
 *
 * Public surface:
 *   track(trackingNumber, opts?)  → { status, events:[{time,status,location,description}], carrier }
 *   getEstimatedCost(payload)
 */

const { selectProvider } = require('../_shared/providerSelector');
const { wrapOutbound }   = require('../_shared/auditWrapper');
const { estimate }       = require('../_shared/costRegistry');

const providers = {
  stub:        require('./stub'),
  dhlExpress:  require('./dhlExpress'),
  // maersk:   require('./maersk'),  // Phase 2 placeholder — README only
};

const { name: providerName, module: provider } = selectProvider('shipment', providers);

/**
 * @param {string} trackingNumber
 * @param {{ persistEvents?: boolean, referenceId?: string }} [opts]
 * @returns {Promise<{ status:string, carrier:string, events:Array }>}
 */
async function track(trackingNumber, opts = {}) {
  const result = await wrapOutbound(
    'shipment', providerName, 'track',
    { trackingNumber, referenceId: opts.referenceId },
    () => provider.track(String(trackingNumber).trim(), opts),
  );

  // Persist events for the audit trail unless caller opts out.
  if (opts.persistEvents !== false && result && Array.isArray(result.events) && result.events.length) {
    try {
      const shipmentEventsRepository = require('../../repositories/shipmentEventsRepository');
      await shipmentEventsRepository.recordEvents({
        trackingNumber,
        carrier: result.carrier || providerName,
        referenceId: opts.referenceId || '',
        events: result.events,
        rawJson: result._raw ? JSON.stringify(result._raw).slice(0, 4000) : '',
      });
    } catch (e) {
      // Persistence failure must not break the user-facing tracking.
      require('../../utils/logger').warn(`[shipment] event-persist failed: ${e.message}`);
    }
  }

  return result;
}

function getEstimatedCost(payload) {
  return estimate('shipment', providerName, payload);
}

module.exports = {
  track,
  getEstimatedCost,
  _providerName: providerName,
};
