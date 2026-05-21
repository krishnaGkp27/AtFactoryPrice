'use strict';

/**
 * bankFeedRepository — sole owner of the BankFeed sheet.
 *
 * Columns:
 *   txn_id | account_id | posted_at | amount | currency | direction
 * | counterparty | narration | reference | fetched_at
 * | matched_ledger_entry_id | reconciliation_status
 *
 * Upserts are keyed by txn_id so re-running `banking.fetchTransactions`
 * over an overlapping window is idempotent. Reconciler updates the
 * last two columns once an admin confirms a match.
 */

const sheets = require('./sheetsClient');

const SHEET = 'BankFeed';

function _parseRow(r) {
  if (!r || !r[0]) return null;
  return {
    txn_id: String(r[0]),
    account_id: String(r[1] || ''),
    posted_at: String(r[2] || ''),
    amount: parseFloat(r[3]) || 0,
    currency: String(r[4] || ''),
    direction: String(r[5] || ''),
    counterparty: String(r[6] || ''),
    narration: String(r[7] || ''),
    reference: String(r[8] || ''),
    fetched_at: String(r[9] || ''),
    matched_ledger_entry_id: String(r[10] || ''),
    reconciliation_status: String(r[11] || 'unmatched'),
  };
}

async function findAll() {
  const rows = await sheets.readRange(SHEET, 'A2:L');
  return (rows || []).map(_parseRow).filter(Boolean);
}

async function findUnmatched() {
  const all = await findAll();
  return all.filter((t) => !t.matched_ledger_entry_id);
}

/**
 * Inserts new rows for txn_ids not yet in the sheet. Returns counts.
 */
async function upsert(transactions) {
  if (!transactions || !transactions.length) return { inserted: 0, skipped: 0 };
  const existing = new Set((await findAll()).map((t) => t.txn_id));
  const fetchedAt = new Date().toISOString();
  const rows = [];
  let skipped = 0;
  for (const t of transactions) {
    if (!t.txnId || existing.has(t.txnId)) { skipped++; continue; }
    rows.push([
      t.txnId, t.accountId || '', t.postedAt || '',
      Number(t.amount) || 0, t.currency || '', t.direction || '',
      t.counterparty || '', t.narration || '', t.reference || '',
      fetchedAt, '', 'unmatched',
    ]);
  }
  if (rows.length) await sheets.appendRows(SHEET, rows);
  return { inserted: rows.length, skipped };
}

async function markReconciled(txnId, ledgerEntryId) {
  const all = await findAll();
  const idx = all.findIndex((t) => t.txn_id === String(txnId));
  if (idx < 0) throw new Error(`BankFeed row not found: ${txnId}`);
  const rowNum = idx + 2; // header + 1-based
  await sheets.updateRange(SHEET, `K${rowNum}:L${rowNum}`, [[String(ledgerEntryId), 'matched']]);
  return true;
}

module.exports = { findAll, findUnmatched, upsert, markReconciled, _parseRow };
