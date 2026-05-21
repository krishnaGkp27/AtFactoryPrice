'use strict';

/**
 * whatsappOutboundRepository — sole owner of WhatsAppOutbound sheet.
 *
 * Columns:
 *   send_id | recipient_phone | template_name | variables_json
 * | status | provider | provider_message_id | cost_usd
 * | sent_at | delivered_at | error
 *
 * Append-only on send. `markDelivered(sendId, deliveredAt)` updates
 * the row once the provider's delivery webhook lands (Wave B work).
 */

const sheets = require('./sheetsClient');

const SHEET = 'WhatsAppOutbound';

let _seq = 0;
function _sendId() {
  _seq = (_seq + 1) % 1000;
  return `WAS-${Date.now()}-${String(_seq).padStart(3, '0')}`;
}

async function append({ recipient, template, variables = {}, status = 'queued', provider, providerMessageId = '', costUsd = 0, sentAt, error = '' }) {
  const row = [
    _sendId(),
    String(recipient),
    String(template),
    JSON.stringify(variables || {}),
    String(status),
    String(provider || ''),
    String(providerMessageId || ''),
    Number(costUsd) || 0,
    sentAt || new Date().toISOString(),
    '', // delivered_at — filled on webhook
    error || '',
  ];
  await sheets.appendRows(SHEET, [row]);
  return row[0];
}

module.exports = { append, _internals: { _sendId } };
