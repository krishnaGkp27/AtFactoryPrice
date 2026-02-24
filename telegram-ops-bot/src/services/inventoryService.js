/**
 * Inventory business logic. Delegates to repository and risk engine.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const transactionsRepository = require('../repositories/transactionsRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const riskEvaluate = require('../risk/evaluate');
const analytics = require('../ai/analytics');
const logger = require('../utils/logger');
function generateId() {
  try {
    return require('crypto').randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

async function checkStock(design, color, warehouse) {
  const all = await inventoryRepository.getAll();
  const d = (design || '').toString().trim().toUpperCase();
  const c = (color || '').toString().trim().toUpperCase();
  const w = (warehouse || '').toString().trim();
  const rows = all.filter(
    (r) =>
      (r.design || '').toUpperCase() === d &&
      (r.color || '').toUpperCase() === c &&
      (r.warehouse || '').trim() === w
  );
  const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
  const price = rows[0]?.price ?? 0;
  return { qty: totalQty, price, design: design || d, color: color || c, warehouse: w };
}

async function deductStock(design, color, warehouse, qty, userId) {
  const numQty = Math.abs(parseFloat(qty)) || 0;
  if (numQty <= 0) throw new Error('Invalid quantity');
  const current = await checkStock(design, color, warehouse);
  const risk = await riskEvaluate.evaluate({
    action: 'sell',
    qty: numQty,
    beforeQty: current.qty,
  });
  if (risk.risk === 'approval_required') {
    const requestId = generateId();
    await approvalQueueRepository.append({
      requestId,
      user: userId,
      actionJSON: { action: 'sell', design, color, warehouse, qty: numQty, beforeQty: current.qty },
      riskReason: risk.reason,
      status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
    return { status: 'approval_required', requestId, reason: risk.reason };
  }
  const newQty = current.qty - numQty;
  await inventoryRepository.updateQty(design, color, warehouse, newQty);
  await transactionsRepository.append({
    user: userId,
    action: 'sell',
    design,
    color,
    qty: numQty,
    before: current.qty,
    after: newQty,
    status: 'completed',
  });
  await auditLogRepository.append('inventory_deduct', { design, color, warehouse, qty: numQty, before: current.qty, after: newQty }, userId);
  return { status: 'completed', before: current.qty, after: newQty };
}

async function addStock(design, color, warehouse, qty, userId) {
  const numQty = Math.abs(parseFloat(qty)) || 0;
  if (numQty <= 0) throw new Error('Invalid quantity');
  const current = await checkStock(design, color, warehouse);
  const newQty = current.qty + numQty;
  await inventoryRepository.updateQty(design, color, warehouse, newQty);
  await transactionsRepository.append({
    user: userId,
    action: 'add',
    design,
    color,
    qty: numQty,
    before: current.qty,
    after: newQty,
    status: 'completed',
  });
  await auditLogRepository.append('inventory_add', { design, color, warehouse, qty: numQty, before: current.qty, after: newQty }, userId);
  return { status: 'completed', before: current.qty, after: newQty };
}

async function executeApprovedAction(requestId, approvedBy) {
  const pending = await approvalQueueRepository.getAllPending();
  const item = pending.find((p) => p.requestId === requestId);
  if (!item) return { ok: false, message: 'Request not found or already resolved' };
  const { action, design, color, warehouse, qty, beforeQty } = item.actionJSON || {};
  if (action !== 'sell') return { ok: false, message: 'Only sell actions are supported for approval' };
  const newQty = (beforeQty || 0) - (parseFloat(qty) || 0);
  await inventoryRepository.updateQty(design, color, warehouse, newQty);
  await transactionsRepository.append({
    user: item.user,
    action: 'sell',
    design,
    color,
    qty,
    before: beforeQty,
    after: newQty,
    status: 'approved',
  });
  await approvalQueueRepository.updateStatus(requestId, 'approved', new Date().toISOString());
  await auditLogRepository.append('approval_approved', { requestId, approvedBy, design, color, qty }, approvedBy);
  return { ok: true, after: newQty };
}

async function rejectApproval(requestId, rejectedBy) {
  const pending = await approvalQueueRepository.getAllPending();
  const item = pending.find((p) => p.requestId === requestId);
  if (!item) return { ok: false, message: 'Request not found or already resolved' };
  await approvalQueueRepository.updateStatus(requestId, 'rejected', new Date().toISOString());
  await auditLogRepository.append('approval_rejected', { requestId, rejectedBy }, rejectedBy);
  return { ok: true };
}

async function analyzeStock() {
  return analytics.getAnalysisSummary();
}

async function getDeadStock(noMovementDays = 90) {
  return analytics.getDeadStock(noMovementDays);
}

async function getFastMoving(lastXDays = 30) {
  return analytics.getFastMovingDesigns(lastXDays);
}

async function getWarehouses() {
  return inventoryRepository.getWarehouses();
}

module.exports = {
  checkStock,
  deductStock,
  addStock,
  executeApprovedAction,
  rejectApproval,
  analyzeStock,
  getDeadStock,
  getFastMoving,
  getWarehouses,
};
