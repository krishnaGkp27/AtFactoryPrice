'use strict';

/**
 * monitoring/stub.js — zero-credential fallback.
 *
 * Logs exceptions through the existing logger so dev / CI runs are
 * still observable. Always-on; never throws.
 */

const logger = require('../../utils/logger');

async function captureException(err, context = {}) {
  const ctx = Object.keys(context).length ? ` ctx=${JSON.stringify(context)}` : '';
  logger.error(`[monitoring.stub] ${err && err.message ? err.message : String(err)}${ctx}`);
  if (err && err.stack) logger.error(err.stack);
  return { id: `stub-${Date.now()}` };
}

async function addBreadcrumb(crumb) {
  logger.info(`[monitoring.stub breadcrumb] ${JSON.stringify(crumb || {})}`);
  return true;
}

module.exports = { captureException, addBreadcrumb };
