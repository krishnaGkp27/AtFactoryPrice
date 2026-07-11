'use strict';

/**
 * legacyCleanup — one-shot boot sweeps for retired data shapes.
 *
 * TRF-5 retired the instant transfer actions (transfer_package /
 * transfer_than / transfer_batch): the approval executor refuses their
 * rows outright, but any row queued BEFORE the retirement still sits in
 * ApprovalQueue as `pending`, cluttering every admin pending list with
 * requests that can never be approved. This sweep closes them.
 *
 * Idempotent and safe: legacy pending rows never moved inventory (the
 * old flows only wrote at approval time), so marking them rejected has
 * no stock side-effects. Runs once per boot; each closure is audit-
 * logged with the original action for traceability.
 */

const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const logger = require('../utils/logger');

const LEGACY_TRANSFER_ACTIONS = ['transfer_package', 'transfer_than', 'transfer_batch'];

/**
 * Reject all still-pending legacy transfer rows.
 * Never throws — boot must not fail on a cleanup hiccup.
 * @returns {Promise<{rejected:number, failed:number}>}
 */
async function rejectStaleLegacyTransfers() {
  let rejected = 0;
  let failed = 0;
  try {
    const pending = await approvalQueueRepository.getAllPending();
    const targets = pending.filter((p) => p.actionJSON
      && LEGACY_TRANSFER_ACTIONS.includes(p.actionJSON.action));
    for (const row of targets) {
      try {
        await approvalQueueRepository.updateStatus(row.requestId, 'rejected', new Date().toISOString());
        await auditLogRepository.append('legacy_transfer_rejected',
          { requestId: row.requestId, action: row.actionJSON.action, reason: 'retired by TRF-5 — use Transfer Stock' },
          'system');
        rejected += 1;
      } catch (e) {
        failed += 1;
        logger.warn(`legacyCleanup: could not reject ${row.requestId}: ${e.message}`);
      }
    }
    if (rejected || failed) {
      logger.info(`legacyCleanup: closed ${rejected} stale legacy transfer row(s)${failed ? `, ${failed} failed` : ''}`);
    }
  } catch (e) {
    logger.warn(`legacyCleanup: sweep skipped: ${e.message}`);
  }
  return { rejected, failed };
}

module.exports = { rejectStaleLegacyTransfers, LEGACY_TRANSFER_ACTIONS };
