'use strict';

/**
 * src/integrations/_shared/auditWrapper.js
 *
 * Wraps every outbound integration call with:
 *   - timing (ms)
 *   - audit row to the existing AuditLog sheet (no new sheet)
 *   - structured error logging
 *
 * Reuses the existing audit pipeline so admins see all third-party
 * traffic in one place. Failures during the audit write itself are
 * SWALLOWED (logged but never thrown) so a Sheets outage can't take
 * down the integration call it's wrapping.
 *
 * Usage in a capability index.js:
 *
 *   const { wrapOutbound } = require('../_shared/auditWrapper');
 *   const provider = selectProvider('forex', { ... });
 *
 *   async function rate(from, to, date) {
 *     return wrapOutbound('forex', provider.name, 'rate',
 *       { from, to, date },
 *       () => provider.module.rate(from, to, date),
 *     );
 *   }
 *
 * The audit row reads:
 *   EventType  : 'integration_call'
 *   Payload    : { capability, provider, operation, success, durationMs, error? }
 *   User       : 'system' (these are bot-initiated, not user-initiated)
 */

const auditLogRepository = require('../../repositories/auditLogRepository');
const logger = require('../../utils/logger');

/**
 * @param {string} capability   'forex' | 'banking' | 'messaging' | ...
 * @param {string} providerName 'stub' | 'metaWhatsApp' | ...
 * @param {string} operation    'rate' | 'send' | 'fetchTransactions' | ...
 * @param {object} payloadMeta  small metadata snapshot for the audit row (NEVER include raw secrets)
 * @param {() => Promise<any>} fn   the actual async work to wrap
 * @returns the resolved value of fn()
 */
async function wrapOutbound(capability, providerName, operation, payloadMeta, fn) {
  const t0 = Date.now();
  let success = false;
  let errMsg = null;
  let result;
  try {
    result = await fn();
    success = true;
    return result;
  } catch (err) {
    errMsg = (err && err.message) || String(err);
    throw err;
  } finally {
    const durationMs = Date.now() - t0;
    const safePayload = sanitisePayload(payloadMeta);
    const auditRow = {
      capability,
      provider: providerName,
      operation,
      success,
      durationMs,
      ...(errMsg ? { error: truncate(errMsg, 240) } : {}),
      ...(safePayload && Object.keys(safePayload).length ? { meta: safePayload } : {}),
    };
    try {
      await auditLogRepository.append('integration_call', auditRow, 'system');
    } catch (auditErr) {
      // Never let an audit-write failure propagate; just log it.
      logger.warn(`auditWrapper: failed to record audit row for ${capability}.${operation}: ${auditErr.message}`);
    }
  }
}

// Strip likely-secret keys; cap string lengths.
function sanitisePayload(p) {
  if (!p || typeof p !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (/token|secret|password|apiKey|api_key|authorization/i.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (typeof v === 'string') out[k] = truncate(v, 120);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (v === null || v === undefined) out[k] = v;
    else out[k] = '[object]';
  }
  return out;
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = { wrapOutbound, _internals: { sanitisePayload, truncate } };
