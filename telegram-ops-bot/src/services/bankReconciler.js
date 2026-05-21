'use strict';

/**
 * src/services/bankReconciler.js
 *
 * Suggests matches between unmatched BankFeed rows and open customer
 * receivables / supplier payables in the ledger. Pure engine —
 * Telegram-free — so it's offline-testable.
 *
 * Match heuristics (in priority order):
 *   1. Exact amount + name match in counterparty / narration
 *   2. Exact amount + recent (≤ 30d) open invoice
 *   3. Amount-only (lowest confidence; needs admin pick)
 *
 * `confirmMatch()` is the side-effecting entry point and is gated by
 * the `confirm_bank_reconciliation` action (dual-admin approval) — the
 * controller wiring happens in a future commit.
 */

const bankFeedRepository = require('../repositories/bankFeedRepository');

function normaliseName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {object} txn        BankFeed row
 * @param {Array}  candidates [{ id, customerName, openAmount, invoiceDate }]
 * @returns {Array<{candidate, confidence, reason}>} sorted high → low
 */
function suggestMatches(txn, candidates) {
  if (!txn || !candidates || !candidates.length) return [];
  const txnName = normaliseName(`${txn.counterparty} ${txn.narration} ${txn.reference}`);
  const txnAmt  = Math.abs(Number(txn.amount) || 0);
  const out = [];
  for (const c of candidates) {
    if (!c || !c.openAmount) continue;
    const cName = normaliseName(c.customerName);
    const amountMatches = Math.abs(Math.abs(c.openAmount) - txnAmt) < 0.01;
    const nameMatches   = cName && txnName.includes(cName);
    let confidence = 0;
    let reason = '';
    if (amountMatches && nameMatches) { confidence = 0.95; reason = 'amount + name'; }
    else if (amountMatches) {
      const ageDays = c.invoiceDate ? Math.max(0, (Date.now() - Date.parse(c.invoiceDate)) / 86400_000) : 999;
      confidence = ageDays <= 30 ? 0.75 : 0.5;
      reason = ageDays <= 30 ? 'amount + recent invoice' : 'amount only';
    }
    if (confidence > 0) out.push({ candidate: c, confidence, reason });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Persist a confirmed match. Wired by the controller's
 * `confirm_bank_reconciliation` action (dual-admin gate enforced by
 * `risk/evaluate.js`).
 */
async function confirmMatch({ txnId, ledgerEntryId, confirmedBy }) {
  if (!txnId || !ledgerEntryId) throw new Error('txnId and ledgerEntryId are required');
  await bankFeedRepository.markReconciled(txnId, ledgerEntryId);
  return { ok: true, txnId, ledgerEntryId, confirmedBy: confirmedBy || null };
}

module.exports = { suggestMatches, confirmMatch, _internals: { normaliseName } };
