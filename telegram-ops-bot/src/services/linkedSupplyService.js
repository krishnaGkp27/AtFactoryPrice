'use strict';

/**
 * MYP-2 — a linked person's shade tap raises a REAL supply request (owner,
 * 23-Aug-2026: "exactly the same flow as supply orders").
 *
 * The record is byte-compatible with the srf_ pipeline's queue rows, so the
 * request rides the existing stages untouched: dispatch feasibility check →
 * admin approval → warehouse-boy assignment — and appears in the admin's
 * 🚚 Pending Supply queue like any other. Nothing moves without the admin
 * (§15: Telegram decides). Quantity = remaining allocation (allocated −
 * supplied), never typed, never exceeding the admin's own number.
 *
 * Duplicate protection: one OPEN request per (person, design, shade) — a
 * second tap answers "already requested" instead of a second row (SUB-1
 * posture at the business level, plus appendOnce underneath).
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** Is there already an open supply request by this person for design(+shade)? */
async function openRequestExists(telegramId, design, shade) {
  const approvalQueueRepository = require('../repositories/approvalQueueRepository');
  const pending = await approvalQueueRepository.getAllPending();
  return (pending || []).some((r) => {
    if (String(r.user) !== String(telegramId)) return false;
    const aj = r.actionJSON || {};
    if (aj.action !== 'supply_request') return false;
    return (aj.cart || []).some((c) => norm(c.design) === norm(design)
      && (!shade || norm(c.shade) === norm(shade)));
  });
}

/**
 * Raise the request. lines = [{design, shade, quantity}] with quantity
 * already computed as remaining allocation by the caller.
 * @returns {{ok:boolean, requestId?:string, reason?:string}}
 */
async function raise(bot, info, lines) {
  const telegramId = String(info.telegramId);
  const cart = (lines || []).filter((l) => l && l.design && Number(l.quantity) > 0)
    .map((l) => ({
      design: String(l.design), shade: String(l.shade || ''),
      shadeName: String(l.shade || ''), quantity: Number(l.quantity),
    }));
  if (!cart.length) return { ok: false, reason: 'nothing_remaining' };

  for (const c of cart) {
    if (await openRequestExists(telegramId, c.design, c.shade)) {
      return { ok: false, reason: 'already_requested' };
    }
  }

  const myProductsService = require('./myProductsService');
  const warehouse = (await myProductsService.sourceWarehouseFor(info).catch(() => null)) || '';

  const requestId = crypto.randomUUID();
  const actionJSON = {
    action: 'supply_request',
    warehouse,
    arrivalBatch: '',
    productType: 'fabric',
    cart,
    customer: info.linkName || telegramId,
    customerId: info.type === 'customer' ? (info.linkId || '') : '',
    salesperson: '',
    paymentMode: '',
    salesDate: new Date().toISOString().slice(0, 10),
    sale_doc_file_id: null,
    sale_doc_type: null,
    sale_doc_mime: null,
    stage: 'dispatch_review',
    // MYP-2 provenance — the approver sees WHO asked and on what basis.
    raisedByLinked: { telegramId, type: info.type, linkId: info.linkId || '', linkName: info.linkName || '' },
  };

  const approvalQueueRepository = require('../repositories/approvalQueueRepository');
  await approvalQueueRepository.appendOnce({
    requestId, user: telegramId, actionJSON,
    riskReason: 'Admin approval required', status: 'pending',
  });
  try {
    await require('../repositories/auditLogRepository').append('approval_queued',
      { requestId, reason: 'supply_request', via: 'my_products', link_type: info.type }, telegramId);
  } catch (_) { /* best-effort */ }

  // Same routing as the srf_ pipeline: Dispatch first, admins on skip.
  try {
    const approvalEvents = require('../events/approvalEvents');
    const queueItem = { requestId, user: telegramId, actionJSON, status: 'pending' };
    const stage1 = await approvalEvents.notifyDispatchManagers(bot, requestId, queueItem, telegramId);
    if (!stage1) {
      await approvalQueueRepository.updateActionJSON(requestId, { stage: 'admin_review', dispatchSkipped: true });
      const summary = cart.map((c) => `${c.design}${c.shade ? ` / ${c.shade}` : ''} × ${c.quantity}B`).join(', ');
      await approvalEvents.notifyAdminsApprovalRequest(bot, requestId,
        `${info.linkName || telegramId} (${info.type})`,
        `Supply request — ${summary}`, 'Admin approval required');
    }
  } catch (e) {
    logger.warn(`linkedSupply.raise: notify failed (request ${requestId} still queued): ${e.message}`);
  }
  return { ok: true, requestId };
}

module.exports = { raise, openRequestExists };
