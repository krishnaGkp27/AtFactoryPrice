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

/**
 * Bale UID — internal-only unambiguous identity for an Inventory row.
 *
 * Format: BAL-YYYYMMDD-{packageNo}-{rand4}
 * Example: BAL-20260514-5801-3a7f
 *
 * The PRINTED-ON-BALE PackageNo stays as the human identifier in column A;
 * bale_uid lets the system disambiguate when the same PackageNo appears
 * across different intake dates. Random suffix prevents collision when
 * multiple bales with same PackageNo are intaken on the same day (rare but
 * possible — e.g. two physical bales with mis-printed identical numbers).
 */
function baleUid(packageNo) {
  const d = new Date();
  const date = d.toISOString().slice(0, 10).replace(/-/g, '');
  const pkg = String(packageNo || '').trim() || 'X';
  const rand = Math.random().toString(36).slice(2, 6);
  return `BAL-${date}-${pkg}-${rand}`;
}

/**
 * CUS-ID1 (owner, 06-Aug-2026) — collision-proof customer ids.
 *
 * generate()'s daily sequence lives IN MEMORY, so every deploy or restart
 * reset it to zero and the first customer created afterwards was minted
 * `-001` AGAIN — the same id as a customer created earlier that day. Four
 * shared ids across 14 rows came from exactly this (the bot redeploys many
 * times a day), and a shared id pools different customers' ledgers and
 * prints the wrong name on invoices. A random suffix cannot repeat across
 * restarts; the sheet-side name guard (assertNameFree) stays as the second
 * fence. Format: CUST-YYYYMMDD-XXXX (4 random base36).
 */
function customerId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CUST-${date}-${rand}`;
}

module.exports = {
  ledgerEntry: () => generate('LE'),
  stockLedger: () => generate('SL'),
  customer: customerId, // CUS-ID1 — never the restart-resetting counter
  user: () => generate('USR'),
  transaction: () => generate('TXN'),
  order: () => generate('ORD'),
  sample: () => generate('SMP'),
  followup: () => generate('FUP'),
  note: () => generate('NOTE'),
  receipt: () => generate('RCT'),
  department: () => generate('DEPT'),
  grn: () => generate('GRN'),
  procurementOrder: () => generate('PO'),
  transfer: () => generate('TR'),
  baleUid,
  requestId,
  generate,
};
