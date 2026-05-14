/**
 * Prefixed ID generator for ERP entities.
 * Format: PREFIX-YYYYMMDD-NNN (sequence resets daily in-memory; unique enough for sheet-based storage).
 */

const counters = {};

function generate(prefix) {
  const d = new Date();
  const date = d.toISOString().slice(0, 10).replace(/-/g, '');
  const key = `${prefix}-${date}`;
  counters[key] = (counters[key] || 0) + 1;
  const seq = String(counters[key]).padStart(3, '0');
  return `${prefix}-${date}-${seq}`;
}

/**
 * Approval / idempotency request ID. Prefers crypto.randomUUID where available
 * (Node 14.17+ / 16+); falls back to a timestamp + random suffix on platforms
 * that don't ship it. Used by the controller for approval-pipeline request IDs.
 */
function requestId() {
  try { return require('crypto').randomUUID(); }
  catch (_) { return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

module.exports = {
  ledgerEntry: () => generate('LE'),
  stockLedger: () => generate('SL'),
  customer: () => generate('CUST'),
  user: () => generate('USR'),
  transaction: () => generate('TXN'),
  order: () => generate('ORD'),
  sample: () => generate('SMP'),
  followup: () => generate('FUP'),
  note: () => generate('NOTE'),
  receipt: () => generate('RCT'),
  department: () => generate('DEPT'),
  requestId,
  generate,
};
