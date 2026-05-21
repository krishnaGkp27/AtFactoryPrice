'use strict';

/**
 * src/integrations/monitoring/index.js — public contract.
 *
 * Capability: error reporting + breadcrumb capture for runtime
 * exceptions. Wraps GlitchTip (self-hosted Sentry-compatible) or
 * official Sentry. Default provider is `stub` so unconfigured
 * deployments don't crash on boot.
 *
 * Public surface:
 *   captureException(err, context?)  → fire-and-forget; never throws
 *   addBreadcrumb({category, message, level, data?})
 *   getEstimatedCost(payload)
 *
 * Wiring (later commit, not in this one): `server.js` calls
 * `captureException` from its `unhandledRejection` / `uncaughtException`
 * handlers, and the controller's catch-all calls it on handler failures.
 */

const { selectProvider } = require('../_shared/providerSelector');
const { wrapOutbound }   = require('../_shared/auditWrapper');
const { estimate }       = require('../_shared/costRegistry');

const providers = {
  stub:       require('./stub'),
  glitchTip:  require('./glitchTip'),
  sentry:     require('./sentry'),
};

const { name: providerName, module: provider } = selectProvider('monitoring', providers);

async function captureException(err, context = {}) {
  // Best-effort — never throw. We can't audit-log a monitoring failure
  // through the same audit pipe (infinite loop risk), so wrapOutbound
  // is intentionally skipped for `captureException` itself.
  try {
    return await provider.captureException(err, context);
  } catch {
    return null;
  }
}

async function addBreadcrumb(crumb) {
  try { return await provider.addBreadcrumb(crumb); } catch { return null; }
}

function getEstimatedCost(payload) {
  return estimate('monitoring', providerName, payload);
}

module.exports = {
  captureException,
  addBreadcrumb,
  getEstimatedCost,
  _providerName: providerName,
};

// Silence the lint about wrapOutbound being unused: it's intentionally
// not applied to monitoring (would self-loop). Re-export so other tests
// can verify the import path exists.
module.exports._wrapOutbound = wrapOutbound;
