/**
 * Inventory business logic — Package/Than ORM layer.
 * Supports drill-down/up queries, per-than and per-package selling, and approval workflow.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const transactionsRepository = require('../repositories/transactionsRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const riskEvaluate = require('../risk/evaluate');
const config = require('../config');
const { bus: erpBus } = require('../events/erpEventBus');

const CURRENCY = config.currency || 'NGN';

function generateId() {
  try { return require('crypto').randomUUID(); }
  catch { return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

function formatMoney(v) {
  return `${CURRENCY} ${Number(v).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`;
}

/**
 * Check stock with flexible filters: design, shade, warehouse, packageNo.
 * Returns aggregated totals for available thans matching the filters.
 */
async function checkStock(filters = {}) {
  const available = await inventoryRepository.findAvailable(filters);
  const totalYards = available.reduce((s, r) => s + r.yards, 0);
  const totalThans = available.length;
  const packages = new Set(available.map((r) => r.packageNo));
  const avgPrice = totalThans > 0 ? available.reduce((s, r) => s + r.pricePerYard, 0) / totalThans : 0;
  return {
    totalYards,
    totalThans,
    totalPackages: packages.size,
    avgPricePerYard: avgPrice,
    totalValue: available.reduce((s, r) => s + r.yards * r.pricePerYard, 0),
    filters,
    items: available,
  };
}

/**
 * Get package detail: all thans with status (available/sold), totals.
 */
async function getPackageSummary(packageNo) {
  const thans = await inventoryRepository.findByPackage(packageNo);
  if (!thans.length) return null;
  const available = thans.filter((t) => t.status === 'available');
  const sold = thans.filter((t) => t.status === 'sold');
  return {
    packageNo,
    indent: thans[0].indent,
    design: thans[0].design,
    shade: thans[0].shade,
    warehouse: thans[0].warehouse,
    totalThans: thans.length,
    availableThans: available.length,
    soldThans: sold.length,
    totalYards: thans.reduce((s, t) => s + t.yards, 0),
    availableYards: available.reduce((s, t) => s + t.yards, 0),
    soldYards: sold.reduce((s, t) => s + t.yards, 0),
    pricePerYard: thans[0].pricePerYard,
    thans: thans.map((t) => ({
      thanNo: t.thanNo,
      yards: t.yards,
      status: t.status,
      soldTo: t.soldTo || null,
      soldDate: t.soldDate || null,
    })),
  };
}

/**
 * List packages for a design+shade, grouped with available/sold counts.
 */
async function listPackages(design, shade) {
  const rows = await inventoryRepository.findByDesign(design, shade);
  const grouped = new Map();
  rows.forEach((r) => {
    if (!grouped.has(r.packageNo)) {
      grouped.set(r.packageNo, {
        packageNo: r.packageNo, indent: r.indent, design: r.design, shade: r.shade,
        warehouse: r.warehouse, total: 0, available: 0, sold: 0, totalYards: 0, availableYards: 0,
      });
    }
    const g = grouped.get(r.packageNo);
    g.total++;
    g.totalYards += r.yards;
    if (r.status === 'available') { g.available++; g.availableYards += r.yards; }
    else { g.sold++; }
  });
  return Array.from(grouped.values());
}

/**
 * Sell a single than. Risk-checks first; queues approval if needed.
 */
async function sellThan(packageNo, thanNo, customer, userId) {
  const than = await inventoryRepository.findThan(packageNo, thanNo);
  if (!than) return { status: 'not_found', message: `Than ${thanNo} in package ${packageNo} not found.` };
  if (than.status === 'sold') return { status: 'already_sold', message: `Than ${thanNo} in package ${packageNo} is already sold.` };

  const risk = await riskEvaluate.evaluate({
    action: 'sell_than',
    qty: than.yards,
    totalValue: than.yards * than.pricePerYard,
    packageNo,
    thanNo,
    userId,
  });

  if (risk.risk === 'approval_required') {
    const requestId = generateId();
    await approvalQueueRepository.append({
      requestId, user: userId,
      actionJSON: { action: 'sell_than', packageNo, thanNo, customer, yards: than.yards, design: than.design, shade: than.shade },
      riskReason: risk.reason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
    return { status: 'approval_required', requestId, reason: risk.reason };
  }

  const result = await inventoryRepository.markThanSold(packageNo, thanNo, customer);
  await transactionsRepository.append({
    user: userId, action: 'sell_than', design: than.design, color: than.shade,
    qty: than.yards, before: 'available', after: 'sold', status: 'completed',
  });
  await auditLogRepository.append('sell_than', { packageNo, thanNo, customer, yards: than.yards }, userId);
  try { erpBus.emit('sale', { type: 'sell_than', packageNo, thanNo, customer, yards: than.yards, pricePerYard: than.pricePerYard, design: than.design, shade: than.shade, warehouse: than.warehouse, userId, txnId: `ST-${packageNo}-${thanNo}` }); } catch (_) {}
  return { status: 'completed', than: result };
}

/**
 * Sell an entire package. Risk-checks based on total value of available thans.
 */
async function sellPackage(packageNo, customer, userId) {
  const thans = await inventoryRepository.findByPackage(packageNo);
  if (!thans.length) return { status: 'not_found', message: `Package ${packageNo} not found.` };
  const available = thans.filter((t) => t.status === 'available');
  if (!available.length) return { status: 'already_sold', message: `Package ${packageNo} is fully sold.` };

  const totalYards = available.reduce((s, t) => s + t.yards, 0);
  const totalValue = available.reduce((s, t) => s + t.yards * t.pricePerYard, 0);

  const risk = await riskEvaluate.evaluate({
    action: 'sell_package',
    qty: totalYards,
    totalValue,
    packageNo,
    userId,
  });

  if (risk.risk === 'approval_required') {
    const requestId = generateId();
    await approvalQueueRepository.append({
      requestId, user: userId,
      actionJSON: { action: 'sell_package', packageNo, customer, yards: totalYards, thans: available.length, design: available[0].design, shade: available[0].shade },
      riskReason: risk.reason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
    return { status: 'approval_required', requestId, reason: risk.reason };
  }

  const results = await inventoryRepository.markPackageSold(packageNo, customer);
  await transactionsRepository.append({
    user: userId, action: 'sell_package', design: available[0].design, color: available[0].shade,
    qty: totalYards, before: `${available.length} thans`, after: 'sold', status: 'completed',
  });
  await auditLogRepository.append('sell_package', { packageNo, customer, yards: totalYards, thans: results.length }, userId);
  try { erpBus.emit('sale', { type: 'sell_package', packageNo, customer, yards: totalYards, pricePerYard: available[0]?.pricePerYard || 0, design: available[0]?.design, shade: available[0]?.shade, warehouse: available[0]?.warehouse, userId, txnId: `SP-${packageNo}` }); } catch (_) {}
  return { status: 'completed', soldThans: results.length, soldYards: totalYards };
}

/**
 * Add stock: append new package thans to the sheet.
 * packageData = { packageNo, indent, csNo, design, shade, warehouse, pricePerYard, dateReceived, thans: [{ yards, netMtrs?, netWeight? }] }
 */
async function addStock(packageData, userId) {
  const thanRows = packageData.thans.map((t, i) => ({
    packageNo: packageData.packageNo,
    indent: packageData.indent || '',
    csNo: packageData.csNo || '',
    design: packageData.design,
    shade: packageData.shade,
    thanNo: i + 1,
    yards: t.yards || 0,
    status: 'available',
    warehouse: packageData.warehouse || '',
    pricePerYard: packageData.pricePerYard || 0,
    dateReceived: packageData.dateReceived || new Date().toISOString().split('T')[0],
    soldTo: '', soldDate: '',
    netMtrs: t.netMtrs || '', netWeight: t.netWeight || '',
    updatedAt: new Date().toISOString(),
  }));
  const count = await inventoryRepository.appendThans(thanRows);
  const totalYards = thanRows.reduce((s, t) => s + t.yards, 0);
  await transactionsRepository.append({
    user: userId, action: 'add_package', design: packageData.design, color: packageData.shade,
    qty: totalYards, before: '', after: `${count} thans`, status: 'completed',
  });
  await auditLogRepository.append('add_package', { packageNo: packageData.packageNo, thans: count, yards: totalYards }, userId);
  return { status: 'completed', thansAdded: count, totalYards };
}

/**
 * Batch sell: sell multiple packages at once to the same customer.
 */
async function sellBatch(packageNos, customer, userId) {
  const results = [];
  for (const pkgNo of packageNos) {
    const result = await sellPackage(pkgNo, customer, userId);
    results.push({ packageNo: pkgNo, ...result });
  }
  const completed = results.filter((r) => r.status === 'completed');
  const totalYards = completed.reduce((s, r) => s + (r.soldYards || 0), 0);
  const totalThans = completed.reduce((s, r) => s + (r.soldThans || 0), 0);
  return {
    status: 'completed',
    totalPackages: completed.length,
    totalThans,
    totalYards,
    details: results,
  };
}

/**
 * Return a sold than (undo sale, mark available again).
 */
async function returnThan(packageNo, thanNo, userId) {
  const result = await inventoryRepository.markThanAvailable(packageNo, thanNo);
  if (!result) return { status: 'not_found', message: `Than ${thanNo} in package ${packageNo} not found or already available.` };
  await transactionsRepository.append({
    user: userId, action: 'return_than', design: result.design, color: result.shade,
    qty: result.yards, before: 'sold', after: 'available', status: 'completed',
  });
  await auditLogRepository.append('return_than', { packageNo, thanNo, yards: result.yards }, userId);
  try { erpBus.emit('return', { type: 'return_than', packageNo, thanNo, yards: result.yards, pricePerYard: result.pricePerYard, design: result.design, shade: result.shade, warehouse: result.warehouse, userId, txnId: `RT-${packageNo}-${thanNo}` }); } catch (_) {}
  return { status: 'completed', than: result };
}

/**
 * Return an entire package (undo all sold thans).
 */
async function returnPackage(packageNo, userId) {
  const results = await inventoryRepository.markPackageAvailable(packageNo);
  if (!results.length) return { status: 'not_found', message: `Package ${packageNo} has no sold thans to return.` };
  const totalYards = results.reduce((s, t) => s + t.yards, 0);
  await transactionsRepository.append({
    user: userId, action: 'return_package', design: results[0].design, color: results[0].shade,
    qty: totalYards, before: 'sold', after: 'available', status: 'completed',
  });
  await auditLogRepository.append('return_package', { packageNo, thans: results.length, yards: totalYards }, userId);
  try { erpBus.emit('return', { type: 'return_package', packageNo, yards: totalYards, pricePerYard: results[0]?.pricePerYard || 0, design: results[0]?.design, shade: results[0]?.shade, warehouse: results[0]?.warehouse, userId, txnId: `RP-${packageNo}` }); } catch (_) {}
  return { status: 'completed', returnedThans: results.length, returnedYards: totalYards };
}

/**
 * Update price per yard for matching items (by packageNo or design+shade).
 */
async function updatePrice(filters, newPrice, userId) {
  const count = await inventoryRepository.updatePrice(filters, newPrice);
  if (count === 0) return { status: 'not_found', message: 'No matching items found to update.' };
  const label = filters.packageNo ? `package ${filters.packageNo}` : `${filters.design || '?'} ${filters.shade || ''}`.trim();
  await transactionsRepository.append({
    user: userId, action: 'update_price', design: filters.design || '', color: filters.shade || '',
    qty: count, before: '', after: `${newPrice}/yd`, status: 'completed',
  });
  await auditLogRepository.append('update_price', { filters, newPrice, rowsUpdated: count }, userId);
  try { erpBus.emit('price_update', { label, newPrice, count, userId }); } catch (_) {}
  return { status: 'completed', updated: count, label, newPrice };
}

/**
 * Execute an approved action from the ApprovalQueue.
 */
async function executeApprovedAction(requestId, approvedBy) {
  const pending = await approvalQueueRepository.getAllPending();
  const item = pending.find((p) => p.requestId === requestId);
  if (!item) return { ok: false, message: 'Request not found or already resolved.' };
  const aj = item.actionJSON || {};

  if (aj.action === 'sell_than') {
    const result = await inventoryRepository.markThanSold(aj.packageNo, aj.thanNo, aj.customer);
    if (!result) return { ok: false, message: 'Than not found.' };
    await transactionsRepository.append({
      user: item.user, action: 'sell_than', design: aj.design, color: aj.shade,
      qty: aj.yards, before: 'available', after: 'sold', status: 'approved',
    });
    try { erpBus.emit('sale', { type: 'sell_than', packageNo: aj.packageNo, thanNo: aj.thanNo, customer: aj.customer, yards: aj.yards, pricePerYard: 0, design: aj.design, shade: aj.shade, userId: item.user, txnId: `ST-${aj.packageNo}-${aj.thanNo}` }); } catch (_) {}
  } else if (aj.action === 'sell_package') {
    const results = await inventoryRepository.markPackageSold(aj.packageNo, aj.customer);
    if (!results.length) return { ok: false, message: 'Package already sold.' };
    await transactionsRepository.append({
      user: item.user, action: 'sell_package', design: aj.design, color: aj.shade,
      qty: aj.yards, before: `${aj.thans} thans`, after: 'sold', status: 'approved',
    });
    try { erpBus.emit('sale', { type: 'sell_package', packageNo: aj.packageNo, customer: aj.customer, yards: aj.yards, pricePerYard: 0, design: aj.design, shade: aj.shade, userId: item.user, txnId: `SP-${aj.packageNo}` }); } catch (_) {}
  } else if (aj.action === 'return_than') {
    const result = await inventoryRepository.markThanAvailable(aj.packageNo, aj.thanNo);
    if (!result) return { ok: false, message: 'Than not found or already available.' };
    await transactionsRepository.append({
      user: item.user, action: 'return_than', design: result.design, color: result.shade,
      qty: result.yards, before: 'sold', after: 'available', status: 'approved',
    });
    try { erpBus.emit('return', { type: 'return_than', packageNo: aj.packageNo, thanNo: aj.thanNo, yards: result.yards, design: result.design, shade: result.shade, userId: item.user, txnId: `RT-${aj.packageNo}-${aj.thanNo}` }); } catch (_) {}
  } else if (aj.action === 'return_package') {
    const results = await inventoryRepository.markPackageAvailable(aj.packageNo);
    if (!results.length) return { ok: false, message: 'No sold thans to return.' };
    const totalYards = results.reduce((s, t) => s + t.yards, 0);
    await transactionsRepository.append({
      user: item.user, action: 'return_package', design: results[0]?.design, color: results[0]?.shade,
      qty: totalYards, before: 'sold', after: 'available', status: 'approved',
    });
    try { erpBus.emit('return', { type: 'return_package', packageNo: aj.packageNo, yards: totalYards, design: results[0]?.design, shade: results[0]?.shade, userId: item.user, txnId: `RP-${aj.packageNo}` }); } catch (_) {}
  } else if (aj.action === 'update_price') {
    const count = await inventoryRepository.updatePrice(aj.filters || {}, aj.price);
    await transactionsRepository.append({
      user: item.user, action: 'update_price', design: (aj.filters?.design) || '', color: (aj.filters?.shade) || '',
      qty: count, before: '', after: `${aj.price}/yd`, status: 'approved',
    });
  } else if (aj.action === 'record_payment') {
    const crmService = require('./crmService');
    const payRes = await crmService.recordPayment({ customer: aj.customer, amount: aj.amount, method: aj.method, userId: item.user });
    if (payRes.status !== 'completed') return { ok: false, message: payRes.message || 'Payment failed.' };
  } else if (aj.action === 'add_customer') {
    const crmService = require('./crmService');
    await crmService.addCustomer({ name: aj.name, phone: aj.phone, address: aj.address, category: aj.category, credit_limit: aj.credit_limit, payment_terms: aj.payment_terms });
  } else if (aj.action === 'transfer_than') {
    const result = await inventoryRepository.transferThan(aj.packageNo, aj.thanNo, aj.toWarehouse);
    if (!result) return { ok: false, message: 'Than not found or not available.' };
    await transactionsRepository.append({ user: item.user, action: 'transfer_than', design: result.design, color: result.shade, qty: result.yards, before: result.fromWarehouse, after: aj.toWarehouse, status: 'approved' });
  } else if (aj.action === 'transfer_package') {
    const results = await inventoryRepository.transferPackage(aj.packageNo, aj.toWarehouse);
    if (!results.length) return { ok: false, message: 'Package not found or no available thans.' };
    const totalYards = results.reduce((s, t) => s + t.yards, 0);
    await transactionsRepository.append({ user: item.user, action: 'transfer_package', design: results[0]?.design, color: results[0]?.shade, qty: totalYards, before: results[0]?.fromWarehouse, after: aj.toWarehouse, status: 'approved' });
  } else if (aj.action === 'transfer_batch') {
    for (const pkgNo of (aj.packageNos || [])) {
      await inventoryRepository.transferPackage(pkgNo, aj.toWarehouse);
    }
    await transactionsRepository.append({ user: item.user, action: 'transfer_batch', design: '', color: '', qty: (aj.packageNos || []).length, before: '', after: aj.toWarehouse, status: 'approved' });
  } else {
    return { ok: false, message: 'Unknown action type.' };
  }

  await approvalQueueRepository.updateStatus(requestId, 'approved', new Date().toISOString());
  await auditLogRepository.append('approval_approved', { requestId, approvedBy }, approvedBy);
  return { ok: true };
}

async function rejectApproval(requestId, rejectedBy) {
  const pending = await approvalQueueRepository.getAllPending();
  const item = pending.find((p) => p.requestId === requestId);
  if (!item) return { ok: false, message: 'Request not found or already resolved.' };
  await approvalQueueRepository.updateStatus(requestId, 'rejected', new Date().toISOString());
  await auditLogRepository.append('approval_rejected', { requestId, rejectedBy }, rejectedBy);
  return { ok: true };
}

async function transferThan(packageNo, thanNo, toWarehouse, userId) {
  const result = await inventoryRepository.transferThan(packageNo, thanNo, toWarehouse);
  if (!result) return { status: 'not_found', message: `Than ${thanNo} in package ${packageNo} not found or not available.` };
  await transactionsRepository.append({
    user: userId, action: 'transfer_than', design: result.design, color: result.shade,
    qty: result.yards, before: result.fromWarehouse, after: toWarehouse, status: 'completed',
  });
  await auditLogRepository.append('transfer_than', { packageNo, thanNo, from: result.fromWarehouse, to: toWarehouse, yards: result.yards }, userId);
  try { erpBus.emit('transfer', { type: 'transfer_than', packageNo, thanNo, fromWarehouse: result.fromWarehouse, toWarehouse, yards: result.yards, design: result.design, shade: result.shade, userId }); } catch (_) {}
  return { status: 'completed', than: result };
}

async function transferPackage(packageNo, toWarehouse, userId) {
  const results = await inventoryRepository.transferPackage(packageNo, toWarehouse);
  if (!results.length) return { status: 'not_found', message: `Package ${packageNo} not found or has no available thans.` };
  const totalYards = results.reduce((s, t) => s + t.yards, 0);
  const fromWarehouse = results[0].fromWarehouse;
  await transactionsRepository.append({
    user: userId, action: 'transfer_package', design: results[0].design, color: results[0].shade,
    qty: totalYards, before: fromWarehouse, after: toWarehouse, status: 'completed',
  });
  await auditLogRepository.append('transfer_package', { packageNo, from: fromWarehouse, to: toWarehouse, thans: results.length, yards: totalYards }, userId);
  try { erpBus.emit('transfer', { type: 'transfer_package', packageNo, fromWarehouse, toWarehouse, yards: totalYards, design: results[0].design, shade: results[0].shade, userId }); } catch (_) {}
  return { status: 'completed', transferredThans: results.length, totalYards, fromWarehouse, toWarehouse };
}

async function transferBatch(packageNos, toWarehouse, userId) {
  const results = [];
  for (const pkgNo of packageNos) {
    const result = await transferPackage(pkgNo, toWarehouse, userId);
    results.push({ packageNo: pkgNo, ...result });
  }
  const completed = results.filter((r) => r.status === 'completed');
  return {
    status: 'completed',
    totalPackages: completed.length,
    totalThans: completed.reduce((s, r) => s + (r.transferredThans || 0), 0),
    totalYards: completed.reduce((s, r) => s + (r.totalYards || 0), 0),
    toWarehouse,
    details: results,
  };
}

async function getWarehouses() {
  return inventoryRepository.getWarehouses();
}

module.exports = {
  checkStock,
  getPackageSummary,
  listPackages,
  sellThan,
  sellPackage,
  sellBatch,
  returnThan,
  returnPackage,
  updatePrice,
  addStock,
  transferThan,
  transferPackage,
  transferBatch,
  executeApprovedAction,
  rejectApproval,
  getWarehouses,
  formatMoney,
};
