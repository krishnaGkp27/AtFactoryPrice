'use strict';

/**
 * src/integrations/index.js — barrel export.
 *
 * Re-exports the public surface of each capability so callers can do:
 *   const { forex, messaging, banking } = require('./integrations');
 *
 * Each capability's own index.js owns provider selection, audit
 * wrapping, and cost telemetry. Business logic NEVER reaches into a
 * provider file directly.
 */

module.exports = {
  monitoring: require('./monitoring'),
  forex:      require('./forex'),
  shipment:   require('./shipment'),
  banking:    require('./banking'),
  messaging:  require('./messaging'),
};
