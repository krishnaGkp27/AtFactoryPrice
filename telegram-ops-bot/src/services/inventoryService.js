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
const logger = require('../utils/logger');
const mutex = require('../utils/asyncMutex');
const { bus: erpBus, emitAsync: erpEmitAsync } = require('../events/erpEventBus');

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
async function sellThan(packageNo, thanNo, customer, userId, salesDate) {
  const than = await inventoryRepository.findThan(packageNo, thanNo);
  if (!than) return { status: 'not_found', message: `Than ${thanNo} in Bale ${packageNo} not found.` };
  if (than.status === 'sold') return { status: 'already_sold', message: `Than ${thanNo} in Bale ${packageNo} is already sold.` };

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
      actionJSON: { action: 'sell_than', packageNo, thanNo, customer, yards: than.yards, design: than.design, shade: than.shade, salesDate: salesDate || null },
      riskReason: risk.reason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
    return { status: 'approval_required', requestId, reason: risk.reason };
  }

  const result = await inventoryRepository.markThanSold(packageNo, thanNo, customer, salesDate);
  // SEC-P2 (C5): markThanSold returns null when the than was sold/moved between
  // our earlier read and this write — don't record a phantom sale for it.
  if (!result) return { status: 'already_sold', message: `Than ${thanNo} in Bale ${packageNo} is no longer available.` };
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
async function sellPackage(packageNo, customer, userId, salesDate) {
  const thans = await inventoryRepository.findByPackage(packageNo);
  if (!thans.length) return { status: 'not_found', message: `Bale ${packageNo} not found.` };
  const available = thans.filter((t) => t.status === 'available');
  if (!available.length) return { status: 'already_sold', message: `Bale ${packageNo} is fully sold.` };

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
      actionJSON: { action: 'sell_package', packageNo, customer, yards: totalYards, thans: available.length, design: available[0].design, shade: available[0].shade, salesDate: salesDate || null },
      riskReason: risk.reason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
    return { status: 'approval_required', requestId, reason: risk.reason };
  }

  const results = await inventoryRepository.markPackageSold(packageNo, customer, salesDate);
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
  if (!result) return { status: 'not_found', message: `Than ${thanNo} in Bale ${packageNo} not found or already available.` };
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
  if (!results.length) return { status: 'not_found', message: `Bale ${packageNo} has no sold thans to return.` };
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
  const label = filters.packageNo ? `Bale ${filters.packageNo}` : `${filters.design || '?'} ${filters.shade || ''}`.trim();
  await transactionsRepository.append({
    user: userId, action: 'update_price', design: filters.design || '', color: filters.shade || '',
    qty: count, before: '', after: `${newPrice}/yd`, status: 'completed',
  });
  await auditLogRepository.append('update_price', { filters, newPrice, rowsUpdated: count }, userId);
  try { erpBus.emit('price_update', { label, newPrice, count, userId }); } catch (_) {}
  return { status: 'completed', updated: count, label, newPrice };
}

/** Get price per unit from enrichment. Unit foundation: yard for now; enrichment.unit can be extended (e.g. metre, piece). */
function getPricePerYard(enrichment, design) {
  if (!enrichment || !enrichment.ratePerUnitByDesign) return 0;
  const rates = enrichment.ratePerUnitByDesign;
  const d = String(design || '').trim();
  if (rates[design] != null) return Number(rates[design]) || 0;
  if (d && rates[d] != null) return Number(rates[d]) || 0;
  const key = Object.keys(rates).find((k) => String(k).trim() === d || String(k).trim() === String(design));
  if (key) return Number(rates[key]) || 0;
  const first = Object.values(rates)[0];
  return typeof first === 'number' ? first : Number(first) || 0;
}

/**
 * Execute an approved action from the ApprovalQueue.
 * For sale actions, optional enrichment = { unit, ratePerUnitByDesign, paymentMode, amountPaid }.
 *
 * SEC-P2 (C4): the body is serialized per requestId with rejectApproval so
 * two admins tapping Approve (or Approve vs Reject) at the same instant cannot
 * both pass the "still pending?" check and double-apply the side effect
 * (duplicate sales/payments/stock moves). Sheets has no transactions and the
 * bot is single-process, so an in-process per-request lock + the pending
 * re-check INSIDE it is atomic enough: the first caller marks the row
 * approved; the second re-reads, finds it resolved, and no-ops.
 */
async function executeApprovedAction(requestId, approvedBy, enrichment) {
  return mutex.runExclusive(requestId, () => executeApprovedActionInner(requestId, approvedBy, enrichment));
}

async function executeApprovedActionInner(requestId, approvedBy, enrichment) {
  const pending = await approvalQueueRepository.getAllPending();
  const item = pending.find((p) => p.requestId === requestId);
  if (!item) return { ok: false, message: 'Request not found or already resolved.' };
  const aj = item.actionJSON || {};
  const accountingService = require('./accountingService');
  // Fix B — captured by the sale_bundle branch so the caller can surface
  // partially-applied sales.
  let bundleReport = null;
  // SEC-P2 (H7): branches that used to `return { ok: true }` early now set
  // this and fall through to the shared footer, so the ApprovalQueue row is
  // marked approved + audited (previously it stayed 'pending' and could be
  // re-approved). Null for branches that have no custom message.
  let customMessage = null;
  // H6 — ERP/ledger hook failures on money paths. Inventory mutations are
  // already applied when these run, so a failure here means BOOKS ≠ STOCK.
  // Collected (not thrown) and returned so approvalEvents can warn the
  // admin loudly instead of reporting a clean success.
  const erpFailures = [];
  const recordErpFailure = async (stage, e) => {
    logger.error(`H6 erp hook failed [${requestId}] ${stage}: ${e.message}`);
    erpFailures.push({ stage, error: e.message });
    try {
      await auditLogRepository.append('erp_hook_failed', { requestId, stage, error: e.message }, approvedBy);
    } catch { /* audit is best-effort here */ }
  };

  if (aj.action === 'sell_than') {
    const result = await inventoryRepository.markThanSold(aj.packageNo, aj.thanNo, aj.customer, aj.salesDate);
    if (!result) return { ok: false, message: 'Than not found or no longer available.' };
    const pricePerYard = getPricePerYard(enrichment, aj.design);
    if (pricePerYard > 0) await inventoryRepository.updatePrice({ packageNo: aj.packageNo }, pricePerYard);
    await transactionsRepository.append({
      user: item.user, action: 'sell_than', design: aj.design, color: aj.shade,
      qty: aj.yards, before: 'available', after: 'sold', status: 'approved',
      salesDate: aj.salesDate || '', customerName: aj.customer || '', paymentMode: enrichment?.paymentMode || '',
      saleRefId: requestId, pricePerYard: pricePerYard || '', amountPaid: enrichment?.amountPaid ?? '',
    });
    try {
      await erpEmitAsync('sale', { type: 'sell_than', packageNo: aj.packageNo, thanNo: aj.thanNo, customer: aj.customer, yards: aj.yards, pricePerYard, design: aj.design, shade: aj.shade, userId: item.user, txnId: `ST-${aj.packageNo}-${aj.thanNo}`, paymentMode: enrichment?.paymentMode ?? '', amountPaid: enrichment?.amountPaid ?? 0 });
    } catch (e) { await recordErpFailure('sale ledger (sell_than)', e); }
    if (enrichment?.amountPaid > 0) {
      try {
        const crmService = require('./crmService');
        await crmService.recordPayment({ customer: aj.customer, amount: enrichment.amountPaid, method: enrichment.paymentMode || 'Cash', userId: approvedBy });
      } catch (e) { await recordErpFailure('payment record (sell_than)', e); }
    }
  } else if (aj.action === 'sell_package') {
    const results = await inventoryRepository.markPackageSold(aj.packageNo, aj.customer, aj.salesDate);
    if (!results.length) return { ok: false, message: 'Bale already sold.' };
    const pricePerYard = getPricePerYard(enrichment, aj.design);
    if (pricePerYard > 0) await inventoryRepository.updatePrice({ packageNo: aj.packageNo }, pricePerYard);
    await transactionsRepository.append({
      user: item.user, action: 'sell_package', design: aj.design, color: aj.shade,
      qty: aj.yards, before: `${aj.thans} thans`, after: 'sold', status: 'approved',
      salesDate: aj.salesDate || '', customerName: aj.customer || '', paymentMode: enrichment?.paymentMode || '',
      saleRefId: requestId, pricePerYard: pricePerYard || '', amountPaid: enrichment?.amountPaid ?? '',
    });
    try {
      await erpEmitAsync('sale', { type: 'sell_package', packageNo: aj.packageNo, customer: aj.customer, yards: aj.yards, pricePerYard, design: aj.design, shade: aj.shade, userId: item.user, txnId: `SP-${aj.packageNo}`, paymentMode: enrichment?.paymentMode ?? '', amountPaid: enrichment?.amountPaid ?? 0 });
    } catch (e) { await recordErpFailure('sale ledger (sell_package)', e); }
    if (enrichment?.amountPaid > 0) {
      try {
        const crmService = require('./crmService');
        await crmService.recordPayment({ customer: aj.customer, amount: enrichment.amountPaid, method: enrichment.paymentMode || 'Cash', userId: approvedBy });
      } catch (e) { await recordErpFailure('payment record (sell_package)', e); }
    }
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
  } else if (aj.action === 'revert_sale_bundle') {
    // Two-admin-approved revert of a previously-approved sale_bundle.
    // Marks every Bale/than in the original sale available again and
    // reverses the customer ledger entry (revertSaleBundle handles
    // both sides). Then flips the original Transactions row to
    // status='reverted' so reports/audits can see the trail.
    const result = await revertSaleBundle(aj.saleRefId, item.user);
    if (!result.ok) return { ok: false, message: result.message || 'Revert failed.' };
    if (aj.txnTimestamp && aj.txnUser && aj.txnAction) {
      try {
        await transactionsRepository.setStatusReverted(aj.txnTimestamp, aj.txnUser, aj.txnAction);
      } catch (_) { /* leave audit row as-is if marker fails */ }
    }
    await transactionsRepository.append({
      user: item.user, action: 'revert_sale_bundle', design: '', color: '',
      qty: result.revertedThans || 0, before: 'sold', after: 'available', status: 'approved',
      saleRefId: aj.saleRefId,
    });
  } else if (aj.action === 'update_price') {
    const count = await inventoryRepository.updatePrice(aj.filters || {}, aj.price);
    await transactionsRepository.append({
      user: item.user, action: 'update_price', design: (aj.filters?.design) || '', color: (aj.filters?.shade) || '',
      qty: count, before: '', after: `${aj.price}/yd`, status: 'approved',
    });
  } else if (aj.action === 'set_unit_display') {
    // TV-2 — flip a warehouse's supply-screen display unit (bales ⇄ thans).
    // Applies the REQUESTED end-state (idempotent), so a stale approval can
    // never double-flip; cache is invalidated so it takes effect at once.
    const unitDisplayService = require('./unitDisplayService');
    await unitDisplayService.setWarehouseMode(aj.warehouse, aj.mode);
  } else if (aj.action === 'record_payment') {
    const crmService = require('./crmService');
    const payRes = await crmService.recordPayment({ customer: aj.customer, amount: aj.amount, method: aj.method, userId: item.user });
    if (payRes.status !== 'completed') return { ok: false, message: payRes.message || 'Payment failed.' };
  } else if (aj.action === 'add_customer') {
    const crmService = require('./crmService');
    await crmService.addCustomer({
      name: aj.name, phone: aj.phone, address: aj.address,
      category: aj.category, credit_limit: aj.credit_limit,
      payment_terms: aj.payment_terms, notes: aj.notes,
    });
    // BR-OPS C1 — pointer for the branch daily roll-up. Fire-and-forget;
    // swallows its own errors so a roll-up blip never fails a customer add.
    try {
      const branchOpsService = require('./branchOpsService');
      await branchOpsService.logPointer({
        kind: 'customer_registered', userId: item.user,
        ref_id: aj.name || '', subject: `Customer: ${aj.name || ''}`,
        notes: aj.category || '',
      });
    } catch (_) { /* swallowed in service; second guard for safety */ }
  } else if (aj.action === 'add_bank') {
    const settingsRepo2 = require('../repositories/settingsRepository');
    const all = await settingsRepo2.getAll();
    const banks = (all.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
    if (banks.map((b) => b.toLowerCase()).includes(String(aj.bank_name || '').toLowerCase())) {
      return { ok: false, message: `Bank "${aj.bank_name}" already exists.` };
    }
    banks.push(aj.bank_name);
    await settingsRepo2.set('BANK_LIST', banks.join(','));
  } else if (aj.action === 'remove_bank') {
    const settingsRepo2 = require('../repositories/settingsRepository');
    const all = await settingsRepo2.getAll();
    let banks = (all.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
    const before = banks.length;
    banks = banks.filter((b) => b.toLowerCase() !== String(aj.bank_name || '').toLowerCase());
    if (banks.length === before) return { ok: false, message: `Bank "${aj.bank_name}" not found.` };
    await settingsRepo2.set('BANK_LIST', banks.join(','));
  } else if (aj.action === 'add_contact') {
    const contactsRepository = require('../repositories/contactsRepository');
    await contactsRepository.append({
      name: aj.name || '', phone: aj.phone || '', type: aj.type || 'other',
      address: aj.address || '', notes: aj.notes || '',
    });
  } else if (aj.action === 'receive_goods') {
    // P2 — write GRN header, then append bales via inventoryRepository so
    // server-generated bale_uid + addedAt are stamped per row, then drop a
    // Stock_Ledger line per bale for the audit trail.
    const goodsReceiptsRepo = require('../repositories/goodsReceiptsRepository');
    const stockLedgerRepo = require('../repositories/stockLedgerRepository');
    const bales = Array.isArray(aj.bales) ? aj.bales : [];
    const totalYards = bales.reduce((s, b) => s + (parseFloat(b.yards) || 0), 0);
    const grn = await goodsReceiptsRepo.append({
      warehouse: aj.warehouse,
      supplier: aj.supplier || '',
      supplier_id: aj.supplier_id || '',
      po_id: aj.po_id || '',
      received_by: item.user,
      total_bales: bales.length,
      total_yards: totalYards,
      photo_file_id: aj.photo_file_id || '',
      notes: aj.notes || '',
    });
    const baleRows = bales.map((b) => ({
      packageNo: b.packageNo,
      design: b.design || aj.design,
      // BUNDLE-SALE C1 — poly-colour bales pass a per-than shade.
      // Fall back to the top-level shade when the receive flow set one
      // (existing mono-colour case stays untouched).
      shade: b.shade || aj.shade,
      thanNo: b.thanNo || 1, yards: parseFloat(b.yards) || 0,
      warehouse: aj.warehouse, pricePerYard: b.pricePerYard || 0,
      dateReceived: aj.dateReceived || new Date().toISOString().split('T')[0],
      productType: aj.productType || 'fabric',
      grnId: grn.grn_id,
      binLocation: b.binLocation || aj.binLocation || '',
      // ARRIVAL-BATCH C1 — operator-chosen container label (e.g. "July26").
      arrivalBatch: aj.arrivalBatch || '',
    }));
    const persisted = await inventoryRepository.appendBale(baleRows);
    try {
      const idGen = require('../utils/idGenerator');
      const today = new Date().toISOString().split('T')[0];
      for (const b of persisted) {
        await stockLedgerRepo.append({
          entry_id: idGen.stockLedger(),
          date: today,
          item_id: b.baleUid, package_no: b.packageNo, branch: b.warehouse,
          type: 'received', qty_in: b.yards, qty_out: 0,
          reference_id: grn.grn_id,
        });
      }
    } catch (_) { /* non-fatal: GRN + Inventory persisted; ledger is supplementary */ }
    await transactionsRepository.append({
      user: item.user, action: 'receive_goods', design: aj.design, color: aj.shade,
      qty: totalYards, before: '', after: aj.warehouse, status: 'approved',
      saleRefId: grn.grn_id,
    });
    // P4 linkage — when the GRN was raised against a PO, push the
    // received qty into the PO's lines + recompute status so the
    // Procurement Plan view advances automatically. Best-effort: any
    // failure here is logged but doesn't roll back the GRN.
    let poUpdate = null;
    if (aj.po_id) {
      try {
        const procurementRepo = require('../repositories/procurementOrdersRepository');
        poUpdate = await procurementRepo.applyReceived(aj.po_id, [{
          design: aj.design, shade: aj.shade,
          qty_bales: persisted.length, qty_yards: totalYards,
        }]);
        await procurementRepo.recomputeStatus(aj.po_id);
      } catch (e) {
        // Surface via audit only — the receive itself already succeeded.
        await auditLogRepository.append('po_receive_link_failed',
          { grnId: grn.grn_id, poId: aj.po_id, error: e.message }, item.user);
      }
    }
    // bundleReport is normally reserved for sale_bundle partials; reusing
    // it as a generic carrier so approvalEvents can surface the GRN
    // details in the success card.
    bundleReport = { grnId: grn.grn_id, baleCount: persisted.length, totalYards,
                     poId: aj.po_id || '', poUpdate };
  } else if (aj.action === 'bulk_receive_goods') {
    // P2.5 — Bulk Receive from a CSV/XLSX upload. The actionJSON already
    // carries the validated, normalised bale list (the validator ran at
    // submit time in bulkReceiveFlow). All we do here is:
    //   1. Re-check file_hash duplicate (race condition guard: two admins
    //      could approve two pending uploads of the same file).
    //   2. Append the GRN header with source + file_hash provenance.
    //   3. Append bales via inventoryRepository.appendBale (composite-key
    //      stamping happens server-side per row — see P1).
    //   4. Drop Stock_Ledger rows.
    //   5. If po_id is set, push to procurementOrdersRepo and recompute.
    const goodsReceiptsRepo = require('../repositories/goodsReceiptsRepository');
    const stockLedgerRepo = require('../repositories/stockLedgerRepository');

    const fileHash = String(aj.fileHash || '').trim();
    if (fileHash) {
      try {
        const dup = await goodsReceiptsRepo.getByFileHash(fileHash);
        if (dup) {
          return {
            ok: false,
            message: `File already imported as ${dup.grn_id} (hash ${fileHash}). Refusing to duplicate.`,
          };
        }
      } catch (e) {
        // Read failure is non-fatal — fall through and rely on the
        // optimistic write below; the worst case is a re-import which
        // will surface in audit, and the operator can revert.
        logger.warn(`bulk_receive_goods: file_hash dedup read failed (continuing): ${e.message}`);
      }
    }

    // PL-1 — whole-container uploads stage their rows to disk (the
    // ApprovalQueue cell can't hold 3k+ rows). Re-read + hash-verify here;
    // fail CLOSED if the staged file vanished (bot redeploy between submit
    // and approval) — the operator simply re-uploads the packing list.
    let thans = Array.isArray(aj.bales) ? aj.bales : [];
    if (!thans.length && aj.balesStagedPath) {
      const fs = require('fs');
      const crypto = require('crypto');
      let payload;
      try {
        payload = fs.readFileSync(aj.balesStagedPath, 'utf8');
      } catch (_) {
        return { ok: false, message: 'Staged container file is gone (bot restarted since submission). Please re-upload the packing list and submit again.' };
      }
      const sha = crypto.createHash('sha256').update(payload).digest('hex');
      if (aj.stagedSha256 && sha !== aj.stagedSha256) {
        return { ok: false, message: 'Staged container file failed integrity check. Please re-upload the packing list and submit again.' };
      }
      try {
        thans = JSON.parse(payload);
      } catch (_) {
        return { ok: false, message: 'Staged container file is corrupted. Please re-upload the packing list and submit again.' };
      }
    }
    if (!thans.length) return { ok: false, message: 'No thans in payload.' };
    const totalThans = thans.length;
    const totalYards = thans.reduce((s, b) => s + (parseFloat(b.yards) || 0), 0);
    // Bale count = distinct PackageNo. The validator already enforces
    // (PackageNo, ThanNo) uniqueness and per-bale uniformity, so this
    // is just a final tally for the GRN header.
    const distinctBales = new Set(thans.map((b) => b.packageNo));
    const totalBales = distinctBales.size;

    const grn = await goodsReceiptsRepo.append({
      warehouse: aj.warehouse,
      supplier: aj.supplier || '',
      supplier_id: aj.supplier_id || '',
      po_id: aj.po_id || '',
      received_by: item.user,
      total_bales: totalBales,
      total_yards: totalYards,
      photo_file_id: '',
      notes: aj.fileName ? `bulk: ${aj.fileName} · ${totalThans} thans` : `bulk: ${totalThans} thans`,
      status: 'received',
      source: aj.source || 'bulk_csv',
      file_hash: fileHash,
      // FILE-C1: persist the clickable Drive link + readable filename so
      // the admin can open the source slip / CSV straight from the sheet.
      source_url: aj.sourceUrl || '',
      source_filename: aj.sourceFilename || '',
    });

    // FILE-C1: best-effort enrichment — once we have a real grn_id,
    // stamp the Drive file's description with "{grn_id} | {supplier} |
    // {warehouse}" so an operator browsing Drive sees the context
    // without opening the sheet. Renames are avoided so any URL stored
    // elsewhere stays valid. Failures are logged and swallowed.
    if (aj.driveFileId) {
      try {
        const driveBackup = require('./vision/driveBackup');
        const desc = `${grn.grn_id} | ${aj.supplier || 'no supplier'} | ${aj.warehouse} | ${grn.received_at || ''}`;
        await driveBackup.updateDescription(aj.driveFileId, desc);
      } catch (e) {
        logger.warn(`bulk_receive_goods: drive description stamp failed (continuing): ${e.message}`);
      }
    }

    const baleRows = thans.map((b) => ({
      packageNo: b.packageNo,
      design: b.design,
      shade: b.shade || '',
      thanNo: parseInt(b.thanNo, 10) > 0 ? parseInt(b.thanNo, 10) : 1,
      yards: parseFloat(b.yards) || 0,
      netMtrs: parseFloat(b.netMtrs) || 0,
      netWeight: parseFloat(b.netWeight) || 0,
      warehouse: aj.warehouse,
      pricePerYard: 0,
      dateReceived: aj.dateReceived || new Date().toISOString().split('T')[0],
      productType: aj.productType || 'fabric',
      grnId: grn.grn_id,
      // ARRIVAL-BATCH C1 — operator-chosen container label (e.g. "July26").
      arrivalBatch: aj.arrivalBatch || '',
      // BULK-INDENT — supplier indent + CS number from the upload file, so
      // container rows match hand-entered rows (Indent / CSNo columns).
      indent: b.indent || '',
      csNo: b.csNo || '',
    }));
    const persisted = await inventoryRepository.appendBale(baleRows);
    // PL-1 — staged rows are in the sheet now; drop the temp file.
    if (aj.balesStagedPath) {
      try { require('fs').unlinkSync(aj.balesStagedPath); } catch (_) { /* best-effort */ }
    }

    try {
      const idGen = require('../utils/idGenerator');
      const today = new Date().toISOString().split('T')[0];
      for (const b of persisted) {
        await stockLedgerRepo.append({
          entry_id: idGen.stockLedger(),
          date: today,
          item_id: b.baleUid, package_no: b.packageNo, branch: b.warehouse,
          type: 'received', qty_in: b.yards, qty_out: 0,
          reference_id: grn.grn_id,
        });
      }
    } catch (_) { /* non-fatal: GRN + Inventory persisted; ledger is supplementary */ }

    await transactionsRepository.append({
      user: item.user, action: 'bulk_receive_goods',
      design: persisted[0]?.design || '', color: persisted[0]?.shade || '',
      qty: totalYards, before: '', after: aj.warehouse, status: 'approved',
      saleRefId: grn.grn_id,
    });

    let poUpdate = null;
    if (aj.po_id) {
      try {
        const procurementRepo = require('../repositories/procurementOrdersRepository');
        // Aggregate by (design, shade). qty_bales counts DISTINCT
        // PackageNos (because a PO line is sized in bales, not thans);
        // qty_yards aggregates across all thans of those bales.
        const byKey = new Map();
        for (const b of persisted) {
          const key = `${b.design}|${b.shade || ''}`;
          const acc = byKey.get(key) || {
            design: b.design, shade: b.shade || '',
            qty_bales: 0, qty_yards: 0,
            _bales: new Set(),
          };
          acc._bales.add(b.packageNo);
          acc.qty_yards += parseFloat(b.yards) || 0;
          byKey.set(key, acc);
        }
        const aggregated = Array.from(byKey.values()).map((a) => ({
          design: a.design, shade: a.shade,
          qty_bales: a._bales.size, qty_yards: a.qty_yards,
        }));
        poUpdate = await procurementRepo.applyReceived(aj.po_id, aggregated);
        await procurementRepo.recomputeStatus(aj.po_id);
      } catch (e) {
        await auditLogRepository.append('po_receive_link_failed',
          { grnId: grn.grn_id, poId: aj.po_id, error: e.message }, item.user);
      }
    }

    bundleReport = {
      grnId: grn.grn_id,
      baleCount: totalBales,
      thanCount: persisted.length,
      totalYards,
      poId: aj.po_id || '', poUpdate,
      source: aj.source || 'bulk_csv', fileHash, fileName: aj.fileName || '',
    };
  } else if (aj.action === 'record_office_expense') {
    // BR-OPS C1 — flip the eager pending rows on BranchOpsLog to
    // approved. All inputs (items, branch, manager) were snapshotted
    // into the action JSON at submit time, so we don't need to re-read
    // any free-text after the approver tapped Approve.
    const branchOpsService = require('./branchOpsService');
    try {
      const res = await branchOpsService.applyExpenseBatch({ aj, approvedBy, requestId });
      if (!res.ok) return { ok: false, message: res.message || 'Could not apply expense batch.' };
      // SEC-P2 (H7): fall through to the footer (marks the queue row approved
      // + writes the approval_approved audit) instead of returning early.
      customMessage = `Approved ${res.count} item(s) for ${res.branch}: total ₦${(res.total || 0).toLocaleString()}.`;
    } catch (e) {
      logger.error(`record_office_expense apply failed: ${e.message}`);
      return { ok: false, message: e.message || 'Failed to apply expense batch.' };
    }
  } else if (aj.action === 'finalize_landed_cost') {
    // LANDED-COST C1 — write the container charges + seal the GRN row's
    // lc_* columns. All inputs (USD/yard, charges, FX) are snapshotted
    // in the action JSON at submit time so the math here matches the
    // approval card exactly.
    const landedCostService = require('./landedCostService');
    try {
      const result = await landedCostService.applyApproved({
        aj, approvedBy, requestId,
      });
      // SEC-P2 (H7): fall through to the footer (see record_office_expense).
      customMessage = `Landed cost finalized for ${result.grnId} at ₦${result.allocation.ngnLandedPerYard.toFixed(2)}/yd.`;
    } catch (e) {
      logger.error(`finalize_landed_cost apply failed: ${e.message}`);
      return { ok: false, message: e.message || 'Failed to finalize landed cost.' };
    }
  } else if (aj.action === 'add_warehouse') {
    // P2 — warehouse creation is dual-admin gated (see ALWAYS_APPROVAL_ACTIONS
    // in risk/evaluate). There is no central Warehouses sheet today —
    // warehouses are derived from distinct Inventory.Warehouse values — so the
    // act of "creating" a warehouse is really registering its name so the
    // greeting/picker can offer it. We store it in Settings under
    // WAREHOUSE_LIST as a CSV so all flows see it immediately.
    //
    // WH-C1: dedup against the MERGED list (Inventory-derived ∪
    // WAREHOUSE_LIST). The previous version checked only the settings
    // CSV, so a name that existed solely as Inventory rows could be
    // re-registered, leading to two effective entries for the same
    // physical warehouse. The bot UI submits canonicalised names, but
    // approval-queue items submitted before WH-C1 may not be
    // canonicalised — case-insensitive dedup catches both shapes.
    const settingsRepo3 = require('../repositories/settingsRepository');
    const allS = await settingsRepo3.getAll();
    const existing = (allS.WAREHOUSE_LIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    const name = String(aj.name || '').trim();
    if (!name) return { ok: false, message: 'Warehouse name is empty.' };

    let fromInv = [];
    try { fromInv = await inventoryRepository.getWarehouses(); } catch (_) { /* repo unavailable */ }
    const mergedLower = new Set(
      [...(fromInv || []), ...existing].map((w) => (w || '').toLowerCase())
    );
    if (mergedLower.has(name.toLowerCase())) {
      return { ok: false, message: `Warehouse "${name}" already exists.` };
    }
    existing.push(name);
    await settingsRepo3.set('WAREHOUSE_LIST', existing.join(','));
    // Note: adminFeed.notify needs a `bot` instance which isn't in
    // scope inside executeApprovedAction (called from approvalEvents).
    // The feed broadcast for `warehouse.added` should hang off the
    // approval-events handler if/when we want it. For now the
    // requester + approver both get direct messages via the existing
    // approval pipeline, which is sufficient signal.
  } else if (aj.action === 'set_design_category') {
    // DCAT-1 — dual-admin design-category mapping (ALWAYS_APPROVAL_ACTIONS).
    // Stamps the Inventory `design_category` column (W) on every row of the
    // design; setCategory() also force-refreshes the read snapshot so every
    // screen (carts, transfer cards, Check Stock, pickers) shows the new
    // label immediately.
    const designCategoriesRepo = require('../repositories/designCategoriesRepository');
    const design = String(aj.design || '').trim();
    const category = String(aj.category || '').trim();
    if (!design || !category) {
      return { ok: false, message: 'set_design_category: design and category are required.' };
    }
    try {
      const res = await designCategoriesRepo.setCategory({ design, category });
      customMessage = `Design ${res.design} is now labelled "${res.category}" (${res.rows} inventory rows stamped).`;
    } catch (e) {
      logger.error(`set_design_category apply failed: ${e.message}`);
      return { ok: false, message: e.message || 'Failed to set design category.' };
    }
  } else if (aj.action === 'add_user') {
    // USR-C3 — in-bot user onboarding. Validates one more time (someone
    // else might have added this Telegram ID since the request was
    // queued), appends to Users sheet, ensures the department exists,
    // marks any PendingUsers row as onboarded, and invalidates the auth
    // cache so the new person can use the bot immediately.
    const usersRepo = require('../repositories/usersRepository');
    const deptsRepo = require('../repositories/departmentsRepository');
    const auth = require('../middlewares/auth');

    const tgId = String(aj.telegram_id || '').trim();
    const name = String(aj.name || '').trim();
    const dept = String(aj.department || '').trim();
    const role = String(aj.role || 'employee').trim();
    const branch = String(aj.branch || '').trim();
    const warehouses = Array.isArray(aj.warehouses) ? aj.warehouses : [];
    // Manager scope: department(s) this user heads (Users column J). Only
    // meaningful for the 'manager' role.
    const manages = (role === 'manager' && Array.isArray(aj.manages)) ? aj.manages.filter(Boolean) : [];

    if (!tgId || !name || !dept || !role) {
      return { ok: false, message: 'add_user: missing one of telegram_id / name / department / role.' };
    }
    if (!['employee', 'manager', 'marketer', 'salesman'].includes(role)) {
      return { ok: false, message: `add_user: role "${role}" not allowed via this flow.` };
    }

    // Race-safe dedup: reject if an active user already exists.
    const dup = await usersRepo.findByUserId(tgId);
    if (dup && (dup.status || 'active') === 'active') {
      return { ok: false, message: `Telegram ID ${tgId} is already an active user (${dup.name || dup.user_id}).` };
    }

    // Ensure the department exists; create empty-activities row if it doesn't.
    try {
      const existingDept = await deptsRepo.findByName(dept);
      if (!existingDept) {
        await deptsRepo.append({
          dept_id: `DEPT-${dept.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'NEW'}`,
          dept_name: dept,
          allowed_activities: '',
          created_at: new Date().toISOString(),
        });
        logger.info(`add_user: created dept "${dept}"`);
      }
    } catch (e) {
      logger.warn(`add_user: dept-ensure failed (${e.message}) — continuing with append`);
    }

    // Write the user row. If a row already exists for this id (inactive — an
    // active one was rejected above), REACTIVATE it in place so we never end
    // up with two rows mapping to one Telegram ID (which used to shadow each
    // other and break deactivate / role reads). History lives in AuditLog.
    if (dup) {
      await usersRepo.reactivate(tgId, { name, role, branch, departments: [dept], warehouses, manages });
    } else {
      await usersRepo.append({
        user_id: tgId,
        name,
        role,
        branch,
        access_level: 'branch_only',
        status: 'active',
        departments: [dept],
        warehouses,
        manages,
      });
    }

    // Mark any PendingUsers row as onboarded (best-effort).
    try {
      const pendingUserService = require('./pendingUserService');
      await pendingUserService.markOnboarded(tgId, item.user);
    } catch (e) {
      logger.warn(`add_user: markOnboarded failed: ${e.message}`);
    }

    // Invalidate the auth cache so the new user can be admitted on their
    // very next message without waiting for the 10s TTL.
    try { await auth.invalidate(); } catch (_) {}

    bundleReport = { telegramId: tgId, name, dept, role, warehouses };
  } else if (aj.action === 'promote_admin') {
    // USR-C3b — flip a target user's role to 'admin'. The approver gate
    // (super-admin) is enforced upstream in approvalEvents; here we
    // assume the request is already authorised.
    const usersRepo = require('../repositories/usersRepository');
    const auth = require('../middlewares/auth');
    const tgId = String(aj.telegram_id || '').trim();
    if (!tgId) return { ok: false, message: 'promote_admin: telegram_id missing.' };
    const target = await usersRepo.findByUserId(tgId);
    if (!target || (target.status || 'active') !== 'active') {
      return { ok: false, message: `promote_admin: ${tgId} is not an active user.` };
    }
    if (String(target.role || '').toLowerCase() === 'admin') {
      return { ok: false, message: `promote_admin: ${tgId} is already an admin.` };
    }
    await usersRepo.updateRole(tgId, 'admin');
    try { await auth.invalidate(); } catch (_) {}
    bundleReport = { telegramId: tgId, name: target.name || tgId, fromRole: target.role || 'employee', toRole: 'admin' };
  } else if (aj.action === 'deactivate_user') {
    // USR-C4 — flip status=inactive. Row + history preserved; bot access
    // revoked on the next auth refresh (or immediately via invalidate()).
    const usersRepo = require('../repositories/usersRepository');
    const auth = require('../middlewares/auth');
    const tgId = String(aj.telegram_id || '').trim();
    if (!tgId) return { ok: false, message: 'deactivate_user: telegram_id missing.' };
    const target = await usersRepo.findByUserId(tgId);
    if (!target) return { ok: false, message: `deactivate_user: ${tgId} not found.` };
    if ((target.status || 'active') !== 'active') {
      return { ok: false, message: `deactivate_user: ${tgId} is already ${target.status}.` };
    }
    await usersRepo.updateStatus(tgId, 'inactive');
    try { await auth.invalidate(); } catch (_) {}
    bundleReport = { telegramId: tgId, name: target.name || tgId, fromStatus: 'active', toStatus: 'inactive' };
  } else if (aj.action === 'rename_warehouse') {
    // P2 — dual-admin gated. Renames touch every Inventory row that
    // references the old warehouse name. Cap at a sane batch size to keep
    // Sheets API happy; very large renames should be done out-of-band.
    const oldName = String(aj.oldName || '').trim();
    const newName = String(aj.newName || '').trim();
    if (!oldName || !newName) return { ok: false, message: 'Old/new warehouse names required.' };
    const all = await inventoryRepository.getAll();
    const matches = all.filter((r) => (r.warehouse || '').toLowerCase() === oldName.toLowerCase());
    if (!matches.length) return { ok: false, message: `No inventory rows reference "${oldName}".` };
    const now = new Date().toISOString();
    const updates = [];
    for (const row of matches) {
      updates.push({ range: `I${row.rowIndex}`, values: [[newName]] });
      updates.push({ range: `P${row.rowIndex}`, values: [[now]] });
    }
    const sheetsClient = require('../repositories/sheetsClient');
    await sheetsClient.batchUpdateRanges('Inventory', updates);
    inventoryRepository.invalidateCache();
    // Mirror the rename into the WAREHOUSE_LIST setting if present.
    try {
      const settingsRepo4 = require('../repositories/settingsRepository');
      const allS = await settingsRepo4.getAll();
      const existing = (allS.WAREHOUSE_LIST || '').split(',').map((s) => s.trim()).filter(Boolean);
      const idx = existing.findIndex((w) => w.toLowerCase() === oldName.toLowerCase());
      if (idx >= 0) {
        existing[idx] = newName;
        await settingsRepo4.set('WAREHOUSE_LIST', existing.join(','));
      }
    } catch (_) {}
    bundleReport = { renamed: matches.length, from: oldName, to: newName };
  } else if (aj.action === 'transfer_than' || aj.action === 'transfer_package' || aj.action === 'transfer_batch') {
    // TRF-5 — legacy instant transfers retired: every entry point now
    // redirects to the staged Transfer Stock flow (dispatcher logs bales,
    // receiver confirms, photos attach). Refuse stale pending rows too, so
    // approving one can never teleport stock the unaccountable way.
    return { ok: false, message: 'Legacy instant transfers are retired — use 🚚 Transfer Stock (dispatcher + receiver confirmation) instead.' };
  } else if (aj.action === 'sale_bundle') {
    const byDesign = {};
    let totalYards = 0, totalThans = 0;
    // Fix B — track every item that silently fails to apply so the caller
    // (approvalEvents) can surface it back to the admin AND the requester.
    const appliedPkgs = new Set();
    const failedItems = [];
    for (const si of (aj.items || [])) {
      if (si.type === 'package') {
        const results = await inventoryRepository.markPackageSold(si.packageNo, aj.customer, aj.salesDate);
        if (!results.length) {
          failedItems.push({ packageNo: si.packageNo, type: 'package', reason: 'not found or no available thans' });
          continue;
        }
        totalThans += results.length;
        const pkgYards = results.reduce((s, t) => s + t.yards, 0);
        totalYards += pkgYards;
        appliedPkgs.add(si.packageNo);
        const design = results[0]?.design || '';
        if (design) byDesign[design] = (byDesign[design] || 0) + pkgYards;
        if (enrichment?.ratePerUnitByDesign && results[0]) {
          const rate = getPricePerYard(enrichment, design);
          if (rate > 0) await inventoryRepository.updatePrice({ packageNo: si.packageNo }, rate);
        }
      } else if (si.type === 'than') {
        const result = await inventoryRepository.markThanSold(si.packageNo, si.thanNo, aj.customer, aj.salesDate);
        if (!result) {
          failedItems.push({ packageNo: si.packageNo, thanNo: si.thanNo, type: 'than', reason: 'not found or not available' });
          continue;
        }
        totalThans += 1;
        totalYards += result.yards;
        appliedPkgs.add(si.packageNo);
        const design = result.design || '';
        if (design) byDesign[design] = (byDesign[design] || 0) + result.yards;
        if (enrichment?.ratePerUnitByDesign && result.design) {
          const rate = getPricePerYard(enrichment, result.design);
          if (rate > 0) await inventoryRepository.updatePrice({ packageNo: si.packageNo }, rate);
        }
      } else {
        failedItems.push({ packageNo: si.packageNo, thanNo: si.thanNo, type: si.type || 'unknown', reason: `unknown item type "${si.type}"` });
      }
    }
    bundleReport = {
      requestedItems: (aj.items || []).length,
      appliedPkgCount: appliedPkgs.size,
      appliedThans: totalThans,
      appliedYards: totalYards,
      failedItems,
    };
    if (failedItems.length) {
      try {
        await auditLogRepository.append('sale_bundle_partial', { requestId, failedItems }, approvedBy);
      } catch (_) {}
    }
    const firstPrice = enrichment ? (Object.values(enrichment.ratePerUnitByDesign || {})[0] || 0) : 0;
    await transactionsRepository.append({
      user: item.user, action: 'sale_bundle', design: '', color: '',
      qty: totalYards, before: `${totalThans} thans`, after: 'sold', status: 'approved',
      salesDate: aj.salesDate || '', customerName: aj.customer || '',
      salesPerson: aj.salesPerson || '', paymentMode: enrichment?.paymentMode || aj.paymentMode || '',
      saleRefId: requestId, pricePerYard: firstPrice || '', amountPaid: enrichment?.amountPaid ?? '',
    });
    // Post sale to ledger so customer has DR (receivable) = yards * rate; outstanding = previous + this sale - payments
    const designsToEmit = Object.keys(byDesign).length ? Object.entries(byDesign) : [['', totalYards]];
    for (const [design, yards] of designsToEmit) {
      if (!yards || yards <= 0) continue;
      const pricePerYard = getPricePerYard(enrichment, design);
      const payload = { type: 'sale_bundle', customer: aj.customer, yards, pricePerYard, design: design || undefined, shade: '', userId: item.user, txnId: `${requestId}-${design || 'sale'}`, paymentMode: enrichment?.paymentMode ?? '', amountPaid: enrichment?.amountPaid ?? 0 };
      try {
        await erpEmitAsync('sale', payload);
      } catch (e) { await recordErpFailure(`sale ledger (bundle${design ? ` ${design}` : ''})`, e); }
    }
    if (enrichment?.amountPaid > 0) {
      try {
        const crmService = require('./crmService');
        await crmService.recordPayment({ customer: aj.customer, amount: enrichment.amountPaid, method: enrichment.paymentMode || 'Cash', userId: approvedBy });
      } catch (e) { await recordErpFailure('payment record (bundle)', e); }
    }
  } else if (aj.action === 'supply_request') {
    // Intimation only — no inventory changes. Approval + assignment handled in approvalEvents.
  } else if (aj.action === 'design_asset_upload') {
    // Activate the staged DesignAssets row keyed by this requestId. Any
    // older active asset for the same design is automatically marked
    // 'replaced' so consumers always read the freshest photo.
    const designAssetsService = require('./designAssetsService');
    const r = await designAssetsService.activateByApprovalRequestId(requestId, approvedBy);
    if (!r.ok) return { ok: false, message: r.message || 'Could not activate design photo asset.' };
  } else if (aj.action === 'give_sample') {
    const samplesRepo = require('../repositories/samplesRepository');
    const sampleSaved = await samplesRepo.append({
      design: aj.design || '',
      shade: aj.shade || '',
      sample_type: aj.sample_type || '',
      customer: aj.customer || '',
      quantity: aj.quantity || '1',
      followup_date: aj.followup_date || '',
      status: 'with_customer',
      updated_by: approvedBy,
    });
    // BR-OPS C1 — pointer for the branch daily roll-up.
    try {
      const branchOpsService = require('./branchOpsService');
      await branchOpsService.logPointer({
        kind: 'sample_issued', userId: item.user,
        ref_id: sampleSaved?.sample_id || '',
        subject: `Sample to ${aj.customer || ''}: ${aj.design || ''} / ${aj.shade || ''}`,
      });
    } catch (_) { /* swallowed in service */ }
  } else if (aj.action === 'register_marketer') {
    const marketersRepo = require('../repositories/marketersRepository');
    const row = await marketersRepo.findByApprovalRequestId(requestId);
    if (!row) return { ok: false, message: 'Marketer record not found.' };
    await marketersRepo.updateStatus(row.rowIndex, 'active', approvedBy);
    // BR-OPS C1 — pointer for the branch daily roll-up.
    try {
      const branchOpsService = require('./branchOpsService');
      await branchOpsService.logPointer({
        kind: 'marketer_registered', userId: item.user,
        ref_id: row.marketer_id || row.name || '',
        subject: `Marketer: ${row.name || ''}`,
      });
    } catch (_) { /* swallowed in service */ }
  } else if (aj.action === 'catalog_supply' || aj.action === 'catalog_loan') {
    const catalogStockRepo = require('../repositories/catalogStockRepository');
    const catalogLedgerRepo = require('../repositories/catalogLedgerRepository');
    const stockRow = await catalogStockRepo.find(aj.design, aj.catalogSize, aj.warehouse);
    if (!stockRow) return { ok: false, message: `No catalog stock found for ${aj.design} ${aj.catalogSize} at ${aj.warehouse}.` };
    const qty = parseInt(aj.quantity, 10) || 1;
    if (stockRow.inOfficeQty < qty) return { ok: false, message: `Insufficient stock: only ${stockRow.inOfficeQty} available.` };
    const isLoan = aj.action === 'catalog_loan';
    await catalogStockRepo.updateQty(
      stockRow.rowIndex,
      stockRow.inOfficeQty - qty,
      isLoan ? stockRow.withCustomersQty : stockRow.withCustomersQty + qty,
      isLoan ? stockRow.withMarketersQty + qty : stockRow.withMarketersQty,
    );
    await catalogLedgerRepo.append({
      design: aj.design,
      catalogSize: aj.catalogSize,
      warehouse: aj.warehouse,
      quantity: qty,
      action: isLoan ? 'loan' : 'supply',
      recipientType: isLoan ? 'marketer' : 'customer',
      recipientName: aj.recipientName,
      status: 'active',
      dateOut: new Date().toISOString(),
      requestedBy: item.user,
      approvedBy,
      approvalRequestId: requestId,
      notes: aj.notes || '',
    });
    catalogStockRepo.invalidateCache();
    catalogLedgerRepo.invalidateCache();
  } else if (aj.action === 'catalog_return') {
    const catalogStockRepo = require('../repositories/catalogStockRepository');
    const catalogLedgerRepo = require('../repositories/catalogLedgerRepository');
    const returnItems = aj.returnItems || [];
    for (const ri of returnItems) {
      const ledgerRow = (await catalogLedgerRepo.getAll()).find(
        (r) => r.ledgerId === ri.ledgerId && r.status === 'active'
      );
      if (!ledgerRow) continue;
      await catalogLedgerRepo.markReturned(ledgerRow.rowIndex, approvedBy, new Date().toISOString());
      const returnWarehouse = aj.returnWarehouse || ledgerRow.warehouse;
      const stockRow = await catalogStockRepo.find(ledgerRow.design, ledgerRow.catalogSize, returnWarehouse);
      if (stockRow) {
        const isMarketer = ledgerRow.recipientType === 'marketer';
        await catalogStockRepo.updateQty(
          stockRow.rowIndex,
          stockRow.inOfficeQty + ledgerRow.quantity,
          isMarketer ? stockRow.withCustomersQty : stockRow.withCustomersQty - ledgerRow.quantity,
          isMarketer ? stockRow.withMarketersQty - ledgerRow.quantity : stockRow.withMarketersQty,
        );
      }
    }
    catalogStockRepo.invalidateCache();
    catalogLedgerRepo.invalidateCache();
  } else {
    return { ok: false, message: 'Unknown action type.' };
  }

  await approvalQueueRepository.updateStatus(requestId, 'approved', new Date().toISOString());
  await auditLogRepository.append('approval_approved', { requestId, approvedBy }, approvedBy);
  // H6 — erpFailures non-empty means stock moved but books did not.
  return { ok: true, bundleReport, message: customMessage, erpFailures };
}

async function rejectApproval(requestId, rejectedBy) {
  // SEC-P2 (C4): serialized with executeApprovedAction on the same requestId.
  return mutex.runExclusive(requestId, () => rejectApprovalInner(requestId, rejectedBy));
}

async function rejectApprovalInner(requestId, rejectedBy) {
  const pending = await approvalQueueRepository.getAllPending();
  const item = pending.find((p) => p.requestId === requestId);
  if (!item) return { ok: false, message: 'Request not found or already resolved.' };
  // Type-specific cleanup before marking rejected.
  const aj = item.actionJSON || {};
  if (aj.action === 'design_asset_upload') {
    try {
      const designAssetsService = require('./designAssetsService');
      await designAssetsService.rejectByApprovalRequestId(requestId, rejectedBy);
    } catch (_) { /* non-fatal: row stays pending; admin can clean up via Manage hub */ }
  }
  if (aj.action === 'record_office_expense') {
    // BR-OPS C1 — flip the eager pending rows on BranchOpsLog to
    // rejected so the manager's "Today" lens reflects the decision.
    // Non-fatal: even if the cell-write fails the approval row is
    // already marked rejected by the caller.
    try {
      const branchOpsService = require('./branchOpsService');
      await branchOpsService.cancelExpenseBatch({ requestId, rejectedBy });
    } catch (e) {
      logger.warn(`record_office_expense reject cleanup failed: ${e.message}`);
    }
  }
  if (aj.action === 'finalize_landed_cost' && aj.grn_id) {
    // LANDED-COST C1 — flip the GRN back to provisional so the admin
    // can re-submit with corrected numbers. Non-fatal: even if this
    // fails the approval row still gets marked rejected.
    try {
      const landedCostService = require('./landedCostService');
      await landedCostService.cancelPending(aj.grn_id);
    } catch (e) {
      logger.warn(`finalize_landed_cost reject: failed to clear GRN ${aj.grn_id} pending state: ${e.message}`);
    }
  }
  await approvalQueueRepository.updateStatus(requestId, 'rejected', new Date().toISOString());
  await auditLogRepository.append('approval_rejected', { requestId, rejectedBy }, rejectedBy);
  return { ok: true };
}

/**
 * Revert a sale_bundle by requestId: mark items available again and reverse ledger.
 * Used when reverting the last transaction that was a sale_bundle.
 */
async function revertSaleBundle(requestId, userId) {
  const approvalRow = await approvalQueueRepository.getByRequestId(requestId);
  if (!approvalRow || !approvalRow.actionJSON) return { ok: false, message: 'Approval request not found.' };
  const aj = approvalRow.actionJSON;
  if (aj.action !== 'sale_bundle' || !Array.isArray(aj.items)) return { ok: false, message: 'Not a sale_bundle or no items.' };
  const customer = aj.customer || '';
  const returnedThans = [];
  for (const si of aj.items) {
    if (si.type === 'package') {
      const sold = await inventoryRepository.findByPackage(si.packageNo);
      const soldThans = sold.filter((t) => t.status === 'sold');
      if (soldThans.length) {
        const undone = await inventoryRepository.markPackageAvailable(si.packageNo);
        returnedThans.push(...undone);
      }
    } else if (si.type === 'than') {
      const than = await inventoryRepository.findThan(si.packageNo, si.thanNo);
      if (than && than.status === 'sold') {
        const undone = await inventoryRepository.markThanAvailable(si.packageNo, si.thanNo);
        if (undone) returnedThans.push(undone);
      }
    }
  }
  if (!returnedThans.length) return { ok: false, message: 'No sold items found to revert.' };
  const byDesign = {};
  for (const t of returnedThans) {
    const key = (t.design || '').trim() || 'unknown';
    if (!byDesign[key]) byDesign[key] = { yards: 0, pricePerYard: t.pricePerYard || 0, packageNo: t.packageNo, shade: t.shade || '' };
    byDesign[key].yards += t.yards || 0;
  }
  const accountingService = require('./accountingService');
  for (const [design, g] of Object.entries(byDesign)) {
    if (g.yards > 0) {
      try {
        await accountingService.recordReturn({ yards: g.yards, pricePerYard: g.pricePerYard, packageNo: g.packageNo, design, shade: g.shade, userId, txnId: `REVERT-${requestId}-${design}` });
      } catch (e) {
        // continue with other designs
      }
    }
  }
  return { ok: true, revertedThans: returnedThans.length };
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
  revertSaleBundle,
  getWarehouses,
  formatMoney,
};
