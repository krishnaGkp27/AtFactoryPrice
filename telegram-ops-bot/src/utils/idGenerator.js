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

module.exports = {
  ledgerEntry: () => generate('LE'),
  stockLedger: () => generate('SL'),
  customer: () => generate('CUST'),
  user: () => generate('USR'),
  generate,
};
