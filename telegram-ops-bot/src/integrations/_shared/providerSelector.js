'use strict';

/**
 * src/integrations/_shared/providerSelector.js
 *
 * Resolves an integration's provider name from env and `require`s the
 * matching provider module. Falls back to 'stub' so the bot ALWAYS
 * boots, even without credentials. Used by every capability's index.js.
 *
 * Usage:
 *   const provider = selectProvider('forex', {
 *     manual:           require('./manual'),
 *     stub:             require('./stub'),
 *     exchangeRateApi:  require('./exchangeRateApi'),
 *     openExchangeRates: require('./openExchangeRates'),
 *   });
 *
 * The env var consulted is `<CAPABILITY>_PROVIDER` (upper-snake). If
 * unset or invalid, the selector logs a warning and falls back to
 * 'stub'. If 'stub' isn't in the providers map, it throws.
 */

const logger = require('../../utils/logger');

/**
 * @param {string} capability   e.g. 'forex', 'banking', 'messaging'
 * @param {Object<string, any>} providers   { name → module }
 * @returns {{ name: string, module: any }}
 */
function selectProvider(capability, providers) {
  if (!capability || typeof capability !== 'string') {
    throw new Error('providerSelector: capability name is required');
  }
  if (!providers || typeof providers !== 'object') {
    throw new Error(`providerSelector(${capability}): providers map is required`);
  }
  const envKey = `${capability.toUpperCase()}_PROVIDER`;
  const requested = (process.env[envKey] || 'stub').trim();

  if (providers[requested]) {
    return { name: requested, module: providers[requested] };
  }

  if (providers.stub) {
    if (requested !== 'stub') {
      logger.warn(
        `providerSelector(${capability}): unknown provider "${requested}" — falling back to stub. ` +
        `Known providers: ${Object.keys(providers).join(', ')}`,
      );
    }
    return { name: 'stub', module: providers.stub };
  }

  throw new Error(
    `providerSelector(${capability}): no 'stub' fallback available and requested provider "${requested}" not found`,
  );
}

module.exports = { selectProvider };
