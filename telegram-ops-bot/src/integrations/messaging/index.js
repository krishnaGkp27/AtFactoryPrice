'use strict';

/**
 * src/integrations/messaging/index.js — public contract (Wave A: OUTBOUND only).
 *
 * Capability: send a templated WhatsApp message to a single phone
 * number (transactional, e.g. order confirmation) or broadcast to many
 * (e.g. wholesaler price update — always-approval).
 *
 * Public surface:
 *   send({ to, template, variables })  → { providerMessageId, status, costUsd? }
 *   broadcast({ to:[...], template, variables })  → { results:[ ... ], costUsd }
 *   getEstimatedCost(payload)
 *
 * Inbound (customer-replies-to-bot) is INTENTIONALLY deferred. See
 * `INBOUND_DEFERRED.md` for the rationale + design notes.
 */

const { selectProvider } = require('../_shared/providerSelector');
const { wrapOutbound }   = require('../_shared/auditWrapper');
const { estimate }       = require('../_shared/costRegistry');

const providers = {
  stub:           require('./stub'),
  metaWhatsApp:   require('./metaWhatsApp'),
  twilio:         require('./twilio'),
};

const { name: providerName, module: provider } = selectProvider('messaging', providers);

async function send({ to, template, variables = {} }) {
  if (!to || !template) throw new Error('send: `to` and `template` are required');
  const result = await wrapOutbound(
    'messaging', providerName, 'send',
    { to, template, varCount: Object.keys(variables).length },
    () => provider.send({ to: String(to).trim(), template, variables }),
  );

  try {
    const repo = require('../../repositories/whatsappOutboundRepository');
    await repo.append({
      recipient: to,
      template,
      variables,
      status: result.status || 'queued',
      provider: providerName,
      providerMessageId: result.providerMessageId || '',
      costUsd: result.costUsd || 0,
      sentAt: new Date().toISOString(),
    });
  } catch (e) {
    require('../../utils/logger').warn(`[messaging] outbound-log failed: ${e.message}`);
  }

  return result;
}

/**
 * @param {{ to:string[], template:string, variables?:object }} p
 * @returns {Promise<{ results: Array, costUsd: number }>}
 *
 * NOTE: the broadcast itself does NOT enforce approval — that's the
 * caller's responsibility via the `broadcast_wholesalers` action in
 * `risk/evaluate.js` (always-approval). The adapter just executes
 * once the approval is granted.
 */
async function broadcast({ to, template, variables = {} }) {
  if (!Array.isArray(to) || !to.length) throw new Error('broadcast: `to` must be a non-empty array');
  const results = [];
  let costUsd = 0;
  for (const recipient of to) {
    try {
      const r = await send({ to: recipient, template, variables });
      results.push({ to: recipient, ok: true, ...r });
      costUsd += (r.costUsd || 0);
    } catch (err) {
      results.push({ to: recipient, ok: false, error: err.message });
    }
  }
  return { results, costUsd: +costUsd.toFixed(6) };
}

function getEstimatedCost(payload) {
  // For bulk: pass `{count: recipients.length}` to scale the cost.
  return estimate('messaging', providerName, payload);
}

module.exports = {
  send,
  broadcast,
  getEstimatedCost,
  _providerName: providerName,
};
