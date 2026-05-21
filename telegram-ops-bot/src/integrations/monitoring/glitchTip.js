'use strict';

/**
 * monitoring/glitchTip.js — Sentry-compatible self-hosted provider.
 *
 * GlitchTip exposes the Sentry SDK protocol, so we use the same
 * `@sentry/node` package and just point its DSN at our GlitchTip
 * instance. The SDK is loaded LAZILY (require-on-first-use) so deps
 * stay optional: dev / CI / stub-mode deployments don't have to
 * install `@sentry/node`.
 *
 * Config (env):
 *   MONITORING_PROVIDER=glitchTip
 *   MONITORING_DSN=https://<key>@glitchtip.example.com/<project>
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
      logger.warn('[monitoring.glitchTip] DSN missing — falling back to no-op');
      return;
    }
    _Sentry.init({
      dsn: config.integrations.monitoring.dsn,
      environment: config.nodeEnv,
      tracesSampleRate: 0,
      release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    });
    logger.info('[monitoring.glitchTip] initialised');
  } catch (err) {
    _initError = err;
    logger.warn(`[monitoring.glitchTip] @sentry/node not installed; ${err.message}`);
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
  return { id: 'glitchTip-async' };
}

async function addBreadcrumb(crumb) {
  init();
  if (!_Sentry || _initError) return null;
  _Sentry.addBreadcrumb(crumb);
  return true;
}

module.exports = { captureException, addBreadcrumb };
