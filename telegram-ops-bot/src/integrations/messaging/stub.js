'use strict';

/**
 * messaging/stub.js — log-only WhatsApp sender.
 *
 * Pretends to send; logs the payload. Returns a deterministic-looking
 * message id so downstream code can pretend it was queued.
 */

const logger = require('../../utils/logger');

async function send({ to, template, variables }) {
  logger.info(`[messaging.stub] → ${to} template=${template} vars=${JSON.stringify(variables || {})}`);
  return {
    providerMessageId: `stub-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    status: 'sent',
    costUsd: 0,
  };
}

module.exports = { send };
