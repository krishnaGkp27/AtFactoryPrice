'use strict';

/**
 * monitoring/sentry.js — official Sentry provider.
 *
 * Same SDK as glitchTip.js (both speak the Sentry protocol). Kept as a
 * separate file so the swap procedure (`MONITORING_PROVIDER=sentry`)
 * stays a one-env-var change.
 */

const config = require('../../config');
const logger = require('../../utils/logger');

let _Sentry = null;
let _initialised = false;
let _initError = null;

function init() {
  if (_initialised || _initError) return;
  _initialised = true;
  try {
    _Sentry = require('@sentry/node');
    if (!config.integrations.monitoring.dsn) {
      _initError = new Error('MONITORING_DSN is not set');
      logger.warn('[monitoring.sentry] DSN missing — falling back to no-op');
      return;
    }
    _Sentry.init({
      dsn: config.integrations.monitoring.dsn,
      environment: config.nodeEnv,
      tracesSampleRate: 0.05,
      release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    });
    logger.info('[monitoring.sentry] initialised');
  } catch (err) {
    _initError = err;
    logger.warn(`[monitoring.sentry] @sentry/node not installed; ${err.message}`);
  }
}

async function captureException(err, context = {}) {
  init();
  if (!_Sentry || _initError) return null;
  if (Object.keys(context).length) {
    _Sentry.withScope((scope) => {
      for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
      _Sentry.captureException(err);
    });
  } else {
    _Sentry.captureException(err);
  }
  return { id: 'sentry-async' };
}

async function addBreadcrumb(crumb) {
  init();
  if (!_Sentry || _initError) return null;
  _Sentry.addBreadcrumb(crumb);
  return true;
}

module.exports = { captureException, addBreadcrumb };
