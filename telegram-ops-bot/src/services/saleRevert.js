'use strict';

/**
 * REV-1 — ↩️ Revert this sale: the tap door for reversing an approved sale.
 *
 * Until 01-Nov-2026 the only way to ask for a revert was a typed sentence
 * the AI read ("Revert last transaction"), and it could only reach the LAST
 * transaction. TXT-1 switched the AI off for anything that changes the
 * sheet. This is the door that replaces it (APG-1 phase 3, owner's go
 * 11-Nov-2026): an admin opens the sale in 🛂 Approvals → ✅❌ Decided and
 * taps ↩️ Revert this sale.
 *
 * It raises the SAME `revert_sale_bundle` request — same action code, same
 * executor (inventoryService.revertSaleBundle), same dual-admin approval —
 * through approvalGate.raise. The registry refuses a second revert of one
 * sale while the first is open, whoever asks.
 *
 * The request carries what the admin card needs to tell two reverts apart
 * (customer, goods, the sale's date and reference): the typed line carried
 * only an id, and its card read "revert sale bale".
 */

const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const transactionsRepository = require('../repositories/transactionsRepository');
const riskEvaluate = require('../risk/evaluate');
const auth = require('../middlewares/auth');
const { fmtQty } = require('../utils/format');
const logger = require('../utils/logger');

const ACTION = 'revert_sale_bundle';

/** "10B + 4t · 1,500 yd" from a sale_bundle row. Pure. */
function goodsOf(aj) {
  const items = Array.isArray(aj && aj.items) ? aj.items : [];
  const whole = new Set((Array.isArray(aj && aj.wholeBales) ? aj.wholeBales : []).map(String));
  const seen = new Set();
  let bales = 0;
  let thans = 0;
  for (const it of items) {
    if (!it) continue;
    const pkg = String(it.packageNo ?? '');
    if (it.type === 'than' && whole.has(pkg)) {
      if (!seen.has(pkg)) { seen.add(pkg); bales += 1; }
    } else if (it.type === 'than') thans += 1;
    else bales += 1;
  }
  const yards = Math.round(Number(aj && aj.totalYards) || 0);
  const qty = [bales ? `${bales}B` : '', thans ? `${thans}t` : ''].filter(Boolean).join(' + ');
  return [qty, yards ? `${fmtQty(yards)} yd` : ''].filter(Boolean).join(' · ');
}

/**
 * Where a sale stands with respect to a revert.
 * Fail-CLOSED: a queue that cannot be read offers no revert.
 * @returns {Promise<{state:'none'|'pending'|'reverted'|'unknown', requestId?:string, when?:string}>}
 */
async function stateOf(saleRequestId) {
  let rows;
  try { rows = await approvalQueueRepository.getAllWithRowIndex(); } catch (e) {
    logger.warn(`saleRevert: queue read failed: ${e.message}`);
    return { state: 'unknown' };
  }
  const mine = (rows || []).filter((r) => r && r.actionJSON && r.actionJSON.action === ACTION
    && String(r.actionJSON.saleRefId || '') === String(saleRequestId));
  const done = mine.find((r) => String(r.status || '').toLowerCase() === 'approved');
  if (done) return { state: 'reverted', requestId: done.requestId, when: done.resolvedAt || '' };
  const open = mine.find((r) => String(r.status || '').toLowerCase() === 'pending');
  if (open) return { state: 'pending', requestId: open.requestId, when: open.createdAt || '' };
  return { state: 'none' };
}

/** May this viewer be offered the revert of this decided row? */
function eligible(row, userId) {
  const aj = (row && row.actionJSON) || {};
  return auth.isAdmin(String(userId)) && aj.action === 'sale_bundle'
    && String(row.status || '').toLowerCase() === 'approved' && Array.isArray(aj.items) && aj.items.length > 0;
}

/**
 * Ask for the revert of an approved sale.
 * @returns {Promise<{ok:true, requestId, created, payload}|{ok:false, reason:string}>}
 */
async function request({ bot, userId, sale }) {
  const uid = String(userId);
  if (!eligible(sale, uid)) return { ok: false, reason: 'Only an admin can ask for the revert of an approved sale.' };
  const st = await stateOf(sale.requestId);
  const approvalCards = require('./approvalCards');
  if (st.state === 'unknown') return { ok: false, reason: 'The approvals record could not be read just now. Try again in a moment.' };
  if (st.state === 'reverted') return { ok: false, reason: 'This sale has already been reverted.' };
  if (st.state === 'pending') return { ok: false, reason: `A revert of this sale is already waiting for approval (${approvalCards.shortRequestRef(st.requestId)}).` };

  const aj = sale.actionJSON || {};
  let txn = null;
  try {
    txn = (await transactionsRepository.findBySaleRef(sale.requestId))
      .find((t) => t.action === 'sale_bundle' && String(t.status || '').toLowerCase() !== 'reverted') || null;
  } catch (e) { logger.warn(`saleRevert: transactions read failed for ${sale.requestId}: ${e.message}`); }
  const payload = {
    saleRefId: String(sale.requestId),
    ...(txn ? { txnTimestamp: txn.timestamp, txnUser: txn.user, txnAction: txn.action } : {}),
    customer: aj.customer || '',
    goods: goodsOf(aj),
    saleDate: aj.salesDate || '',
    saleRef: approvalCards.shortRequestRef(sale.requestId),
    source: 'decided_inbox',
  };
  const risk = await riskEvaluate.evaluate({ action: ACTION, userId: uid });
  const gate = require('./approvalGate');
  const raised = await gate.raise({
    userId: uid, action: ACTION, payload,
    riskReason: risk.reason || 'dual_admin_required',
    auditMeta: { saleRefId: payload.saleRefId, via: 'decided_inbox' }, bot,
  });
  if (!raised.ok) {
    return { ok: false, reason: `A revert of this sale is already waiting for approval (${approvalCards.shortRequestRef(raised.twin.requestId)}).` };
  }
  if (raised.created) {
    try {
      const card = approvalCards.buildRevertSaleCard({ action: ACTION, ...payload });
      const label = await approvalCards.resolveUserLabel(uid, bot);
      await require('../events/approvalEvents').notifyAdminsApprovalRequest(
        bot, raised.requestId, label, card, risk.reason || 'dual_admin_required', uid);
    } catch (e) { logger.warn(`saleRevert: admin notify failed for ${raised.requestId}: ${e.message}`); }
  }
  return { ok: true, requestId: raised.requestId, created: raised.created, payload };
}

module.exports = { ACTION, goodsOf, stateOf, eligible, request };
