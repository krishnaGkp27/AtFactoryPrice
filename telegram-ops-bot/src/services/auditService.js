/**
 * Enhanced audit service: logs to AuditLog with optional Module and ReferenceId columns.
 * Backward-compatible: existing auditLogRepository.append() still works for old code.
 */

const sheets = require('../repositories/sheetsClient');
const logger = require('../utils/logger');

const SHEET = 'AuditLog';

async function log(userId, action, module, referenceId) {
  try {
    const row = [
      new Date().toISOString(),
      action,
      JSON.stringify({ module, referenceId }),
      userId || '',
      module || '',
      referenceId || '',
    ];
    await sheets.appendRows(SHEET, [row]);
  } catch (e) {
    logger.error('AuditService log error (non-blocking):', e.message);
  }
}

module.exports = { log };
