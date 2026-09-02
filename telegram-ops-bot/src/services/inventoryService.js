/**
 * Inventory business logic — Package/Than ORM layer.
 * Supports drill-down/up queries, per-than and per-package selling, and approval workflow.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const { todayInLagos } = require('../utils/dates');
// STK-E1 — every stock mutation names its event + authority through here.
const stockEngine = require('./stockEngine');
const stockBuckets = require('../utils/stockBuckets');
const transactionsRepository = require('../repositories/transactionsRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const riskEvaluate = require('../risk/evaluate');
const config = require('../config');
const logger = require('../utils/logger');
const mutex = require('../utils/asyncMutex');
const { bus: erpBus, emitAsync: erpEmitAsync } = require('../events/erpEventBus');

const CURRENCY = config.currency || 'NGN';

/**
 * CUS-2 — canonicalize an Inventory soldTo spelling into {name, id} for
 * ledger reversal stamping. Falls back to the raw spelling (walk-ins,
 * pre-CUS-1 rows) with an empty id — never throws.
 */
/**
 * RET-3 — the rate an approved return is credited at.
 *
 * Order: an explicit `pricePerYard` on the request (the slot the return
 * card fills once it asks for one) → the sold Inventory row's own price
 * (the sale executor stamps the enriched sale rate onto the row, so this
 * IS the booked rate unless a price edit followed the sale) → 0.
 * Transactions cannot be the source: it has no bale column to look up by.
 *
 * Returns the total credit and the weighted rate that reproduces it, so a
 * whole-bale return of thans priced differently still credits the exact sum.
 */
function returnCreditFor(aj, rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  const override = Number(aj && aj.pricePerYard) > 0 ? Number(aj.pricePerYard) : 0;
  const yards = list.reduce((s, t) => s + (Number(t.yards) || 0), 0);
  const amount = list.reduce((s, t) => s + (Number(t.yards) || 0) * (override || Number(t.pricePerYard) || 0), 0);
  return { yards, amount, rate: yards > 0 && amount > 0 ? amount / yards : 0 };
}

function fmtNgn(n) { return `₦${Math.round(Number(n) || 0).toLocaleString('en-NG')}`; }

async function resolveReturnCustomer(soldTo) {
  const raw = String(soldTo || '').trim();
  if (!raw) return { name: '', id: '' };
  try {
    const cust = await require('./customerEntity').resolve({ name: raw });
    if (cust) return { name: cust.name, id: cust.customer_id };
  } catch (_) { /* raw spelling still lands in the narration */ }
  return { name: raw, id: '' };
}

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
 * TRF-INT4 — opts.warehouse scopes to one physical bale when the printed
 * number exists in more than one warehouse.
 */
async function getPackageSummary(packageNo, opts = {}) {
  const thans = await inventoryRepository.findByPackage(packageNo, { warehouse: opts.warehouse });
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
        warehouse: r.warehouse, total: 0, available: 0, sold: 0, inTransit: 0, other: 0,
        totalYards: 0, availableYards: 0, inTransitYards: 0,
      });
    }
    const g = grouped.get(r.packageNo);
    g.total++;
    g.totalYards += r.yards;
    // STK-B1 — in transit is its own bucket (owner, 04-Aug-2026). This used
    // to be `else { g.sold++ }`, which booked every travelling bale as sold.
    const b = stockBuckets.bucketOf(r);
    if (b === stockBuckets.AVAILABLE) { g.available++; g.availableYards += r.yards; }
    else if (b === stockBuckets.IN_TRANSIT) { g.inTransit++; g.inTransitYards += r.yards; }
    else if (b === stockBuckets.SOLD) { g.sold++; }
    else { g.other++; }
  });
  return Array.from(grouped.values());
}

/**
 * Sell a single than. Risk-checks first; queues approval if needed.
 */
async function sellThan(packageNo, thanNo, customer, userId, salesDate, opts = {}) {
  // TRF-INT4 — opts.warehouse pins the sale to the physical than the caller
  // picked; the resolved row's warehouse then rides the queue/mutation so a
  // same-numbered duplicate elsewhere can never be flipped.
  const than = await inventoryRepository.findThan(packageNo, thanNo, { warehouse: opts.warehouse });
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
      actionJSON: { action: 'sell_than', packageNo, thanNo, customer, yards: than.yards, design: than.design, shade: than.shade, warehouse: than.warehouse || '', salesDate: salesDate || null },
      riskReason: risk.reason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
    return { status: 'approval_required', requestId, reason: risk.reason };
  }

  const result = await stockEngine.sellThan(packageNo, thanNo, customer, salesDate, { warehouse: than.warehouse }, { event: 'sale', adminId: userId });
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
async function sellPackage(packageNo, customer, userId, salesDate, opts = {}) {
  // TRF-INT4 — opts.warehouse pins the sale to the physical bale the caller
  // picked. When unscoped but every available than lives in ONE warehouse,
  // that warehouse is stamped anyway so the executed sale stays pinned even
  // if a duplicate number is intaken elsewhere before approval.
  const thans = await inventoryRepository.findByPackage(packageNo, { warehouse: opts.warehouse });
  if (!thans.length) return { status: 'not_found', message: `Bale ${packageNo} not found.` };
  let available = thans.filter((t) => t.status === 'available');
  if (!available.length) return { status: 'already_sold', message: `Bale ${packageNo} is fully sold.` };
  const whs = [];
  for (const t of available) {
    const w = String(t.warehouse || '').trim();
    if (w && !whs.some((x) => x.toUpperCase() === w.toUpperCase())) whs.push(w);
  }
  const saleWarehouse = opts.warehouse || (whs.length === 1 ? whs[0] : '');
  if (saleWarehouse) {
    // Totals, the queued aj and the mutation must all describe the SAME
    // rows: once a warehouse is pinned, blank-warehouse legacy rows (which
    // markPackageSold's scope will not flip) drop out of the counts too.
    available = available.filter((t) => String(t.warehouse || '').trim().toUpperCase() === String(saleWarehouse).trim().toUpperCase());
    if (!available.length) return { status: 'already_sold', message: `Bale ${packageNo} has no available thans in ${saleWarehouse}.` };
  }

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
      actionJSON: { action: 'sell_package', packageNo, customer, yards: totalYards, thans: available.length, design: available[0].design, shade: available[0].shade, warehouse: saleWarehouse, salesDate: salesDate || null },
      riskReason: risk.reason, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason }, userId);
    return { status: 'approval_required', requestId, reason: risk.reason };
  }

  const results = await stockEngine.sellPackage(packageNo, customer, salesDate, { warehouse: saleWarehouse || undefined }, { event: 'sale', adminId: userId });
  await transactionsRepository.append({
    user: userId, action: 'sell_package', design: available[0].design, color: available[0].shade,
    qty: totalYards, before: `${available.length} thans`, after: 'sold', status: 'completed',
  });
  await auditLogRepository.append('sell_package', { packageNo, customer, yards: totalYards, thans: results.length }, userId);
  try { erpBus.emit('sale', { type: 'sell_package', packageNo, customer, yards: totalYards, pricePerYard: available[0]?.pricePerYard || 0, design: available[0]?.design, shade: available[0]?.shade, warehouse: available[0]?.warehouse, userId, txnId: `SP-${packageNo}` }); } catch (_) {}
  return { status: 'completed', soldThans: results.length, soldYards: totalYards };
}

/* STK-E1 — the dead exports addStock() and sellBatch() are DELETED. They
 * had no live caller (NLP 'add' opens addStockFlow → bulk_receive_goods;
 * 'sell_batch' rides startSaleFlow → sale_bundle), appended rows without
 * the intake collision gate or bale_uid stamping, and would have become
 * ungated doors for any future caller (07-Aug audit, door #19). */

/**
 * Return a sold than (undo sale, mark available again).
 */
async function returnThan(packageNo, thanNo, userId, opts = {}) {
  // TRF-INT4 — opts.warehouse pins the return to the physical than sold there.
  const result = await stockEngine.returnThan(packageNo, thanNo, { warehouse: opts.warehouse }, { event: 'return', adminId: userId });
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
async function returnPackage(packageNo, userId, opts = {}) {
  // TRF-INT4 — opts.warehouse pins the return to the physical bale sold there.
  const results = await stockEngine.returnPackage(packageNo, { warehouse: opts.warehouse }, { event: 'return', adminId: userId });
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
/**
 * IDR-4 — bind a Pending user's Telegram account to the record an approval
 * just created (marketer / customer / contact). Best-effort by design: the
 * approval's own write must never be undone by a register hiccup, so this
 * returns false instead of throwing, and the caller says so in the result
 * message. Also drops the living stranger card and refreshes linked access
 * so the person's next tap already lands on their new surface.
 */
async function _linkPendingAccount(telegramId, linkSpec, approvedBy) {
  try {
    const identityService = require('./identityService');
    const res = await identityService.link(telegramId, linkSpec, approvedBy);
    if (!res.ok) {
      logger.warn(`IDR-4 link-on-approval failed for ${telegramId}: ${res.reason}`);
      return false;
    }
    try { require('./linkedAccessService').invalidate(); } catch (_) { /* cache only */ }
    try { require('./pendingUserService')._internals._clearLiveCard(telegramId); } catch (_) { /* card only */ }
    return true;
  } catch (e) {
    logger.warn(`IDR-4 link-on-approval failed for ${telegramId}: ${e.message}`);
    return false;
  }
}

async function executeApprovedAction(requestId, approvedBy, enrichment) {
  // ANL-2 — the approval TAP was already tracked at decision time; this
  // records whether the executor (the thing that actually mutates sheets)
  // then succeeded or failed. Benign idempotent no-ops (second admin's tap
  // finding the row already resolved) are not activity and are skipped.
  const usageTracker = require('./usageTracker');
  const t0 = Date.now();
  try {
    const result = await mutex.runExclusive(requestId, () => executeApprovedActionInner(requestId, approvedBy, enrichment));
    if (result && result.ok === false) {
      if (result.message !== 'Request not found or already resolved.') {
        usageTracker.track({
          userId: approvedBy, surface: 'system', feature: 'approvals',
          event: 'exec_error', requestId, durationMs: Date.now() - t0,
          meta: { message: String(result.message || '').slice(0, 200) },
        });
      }
    } else {
      usageTracker.track({
        userId: approvedBy, surface: 'system', feature: 'approvals',
        event: 'approval_executed', requestId, durationMs: Date.now() - t0,
      });
    }
    return result;
  } catch (e) {
    usageTracker.track({
      userId: approvedBy, surface: 'system', feature: 'approvals',
      event: 'exec_error', requestId, durationMs: Date.now() - t0,
      meta: { error: String(e.message || e).slice(0, 200) },
    });
    throw e;
  }
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
  let creditNote = null; // RET-3 — what a return credited, shown on the approve reply
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
    // TRF-INT4 — sell only in the warehouse the request was made from, so a
    // same-numbered duplicate elsewhere can never be flipped by this sale.
    // Pre-TRF-INT4 pending rows carry no warehouse → legacy unscoped match.
    const result = await stockEngine.sellThan(aj.packageNo, aj.thanNo, aj.customer, aj.salesDate, { warehouse: aj.warehouse }, { event: 'sale', approvalId: requestId, adminId: approvedBy });
    if (!result) return { ok: false, message: 'Than not found or no longer available.' };
    const pricePerYard = getPricePerYard(enrichment, aj.design);
    if (pricePerYard > 0) await inventoryRepository.updatePrice({ packageNo: aj.packageNo, warehouse: aj.warehouse }, pricePerYard);
    await transactionsRepository.append({
      user: item.user, action: 'sell_than', design: aj.design, color: aj.shade,
      qty: aj.yards, before: 'available', after: 'sold', status: 'approved',
      // SLP-1 (owner 10-Aug-2026, "are you logging the salesperson?") — the
      // Transactions sheet has had a SalesPerson column since APU-1 and only
      // sale_bundle filled it. Snap Sale queues sell_package with the name on
      // the row and it was dropped at execution; sales history could not be
      // read per seller. Same one line on both approved sale executors.
      salesPerson: aj.salesPerson || '',
      salesDate: aj.salesDate || '', customerName: aj.customer || '', paymentMode: enrichment?.paymentMode || '',
      saleRefId: requestId, pricePerYard: pricePerYard || '', amountPaid: enrichment?.amountPaid ?? '',
      customerId: aj.customerId || '',
    });
    try {
      await erpEmitAsync('sale', { type: 'sell_than', packageNo: aj.packageNo, thanNo: aj.thanNo, customer: aj.customer, customerId: aj.customerId || '', yards: aj.yards, pricePerYard, design: aj.design, shade: aj.shade, userId: item.user, txnId: `ST-${aj.packageNo}-${aj.thanNo}`, paymentMode: enrichment?.paymentMode ?? '', amountPaid: enrichment?.amountPaid ?? 0 });
    } catch (e) { await recordErpFailure('sale ledger (sell_than)', e); }
    if (enrichment?.amountPaid > 0) {
      try {
        const crmService = require('./crmService');
        await crmService.recordPayment({ customer: aj.customer, amount: enrichment.amountPaid, method: enrichment.paymentMode || 'Cash', userId: approvedBy });
      } catch (e) { await recordErpFailure('payment record (sell_than)', e); }
    }
  } else if (aj.action === 'sell_package') {
    // TRF-INT4 — see sell_than note above.
    const results = await stockEngine.sellPackage(aj.packageNo, aj.customer, aj.salesDate, { warehouse: aj.warehouse }, { event: 'sale', approvalId: requestId, adminId: approvedBy });
    if (!results.length) return { ok: false, message: 'Bale already sold.' };
    const pricePerYard = getPricePerYard(enrichment, aj.design);
    if (pricePerYard > 0) await inventoryRepository.updatePrice({ packageNo: aj.packageNo, warehouse: aj.warehouse }, pricePerYard);
    await transactionsRepository.append({
      user: item.user, action: 'sell_package', design: aj.design, color: aj.shade,
      qty: aj.yards, before: `${aj.thans} thans`, after: 'sold', status: 'approved',
      salesPerson: aj.salesPerson || '',   // SLP-1 — see the sell_than note above
      salesDate: aj.salesDate || '', customerName: aj.customer || '', paymentMode: enrichment?.paymentMode || '',
      saleRefId: requestId, pricePerYard: pricePerYard || '', amountPaid: enrichment?.amountPaid ?? '',
      customerId: aj.customerId || '',
    });
    try {
      await erpEmitAsync('sale', { type: 'sell_package', packageNo: aj.packageNo, customer: aj.customer, customerId: aj.customerId || '', yards: aj.yards, pricePerYard, design: aj.design, shade: aj.shade, userId: item.user, txnId: `SP-${aj.packageNo}`, paymentMode: enrichment?.paymentMode ?? '', amountPaid: enrichment?.amountPaid ?? 0 });
    } catch (e) { await recordErpFailure('sale ledger (sell_package)', e); }
    if (enrichment?.amountPaid > 0) {
      try {
        const crmService = require('./crmService');
        await crmService.recordPayment({ customer: aj.customer, amount: enrichment.amountPaid, method: enrichment.paymentMode || 'Cash', userId: approvedBy });
      } catch (e) { await recordErpFailure('payment record (sell_package)', e); }
    }
  } else if (aj.action === 'return_than') {
    // CUS-2 — capture who it was sold to BEFORE the flip blanks soldTo, so
    // the ledger reversal lands on that customer's statement.
    const soldRow = await inventoryRepository.findThan(aj.packageNo, aj.thanNo, { warehouse: aj.warehouse }).catch(() => null);
    const returnCust = await resolveReturnCustomer(soldRow ? soldRow.soldTo : '');
    // TRF-INT4 — return only in the request's warehouse (see sell_than note).
    // RET-3 — `on` lets a request carry the day the goods actually came
    // back (the return card's date step); absent, the movement is dated today.
    const result = await stockEngine.returnThan(aj.packageNo, aj.thanNo, { warehouse: aj.warehouse, on: aj.returnedOn || undefined }, { event: 'return', approvalId: requestId, adminId: approvedBy });
    if (!result) return { ok: false, message: 'Than not found or already available.' };
    const credit = returnCreditFor(aj, result);
    await transactionsRepository.append({
      user: item.user, action: 'return_than', design: result.design, color: result.shade,
      qty: result.yards, before: 'sold', after: 'available', status: 'approved',
      warehouse: aj.warehouse || result.warehouse || '', customerName: returnCust.name, customerId: returnCust.id,
      saleRefId: requestId, pricePerYard: credit.rate || '',
    });
    // RET-3 — the credit rides the SAME propagating emitter as the sale
    // debit it undoes: a failed ledger write is reported on the card, and a
    // return with no rate on record is reported the same way instead of
    // silently crediting ₦0.
    try {
      await erpEmitAsync('return', { type: 'return_than', packageNo: aj.packageNo, thanNo: aj.thanNo, yards: result.yards, pricePerYard: credit.rate, design: result.design, shade: result.shade, warehouse: aj.warehouse || result.warehouse, userId: item.user, txnId: `RT-${aj.packageNo}-${aj.thanNo}`, customer: returnCust.name, customerId: returnCust.id });
      if (credit.amount > 0) creditNote = `↩️ Credited ${fmtNgn(credit.amount)} to ${returnCust.name || 'the buyer'} (${result.yards} yds × ${fmtNgn(credit.rate)}/yd).`;
      else await recordErpFailure('return credit (return_than)', new Error(`no rate on record for Bale ${aj.packageNo} Than ${aj.thanNo} — stock returned, credit NOT posted; post it manually`));
    } catch (e) { await recordErpFailure('return credit (return_than)', e); }
  } else if (aj.action === 'return_package') {
    // CUS-2 — capture the buyer before the flip clears soldTo.
    const soldRows = await inventoryRepository.findByPackage(aj.packageNo, { warehouse: aj.warehouse }).catch(() => []);
    const soldToPrior = (soldRows.find((t) => t.status === 'sold' && t.soldTo) || {}).soldTo || '';
    const returnCust = await resolveReturnCustomer(soldToPrior);
    // TRF-INT4 — return only in the request's warehouse (see sell_than note).
    const results = await stockEngine.returnPackage(aj.packageNo, { warehouse: aj.warehouse, on: aj.returnedOn || undefined }, { event: 'return', approvalId: requestId, adminId: approvedBy });
    if (!results.length) return { ok: false, message: 'No sold thans to return.' };
    const totalYards = results.reduce((s, t) => s + t.yards, 0);
    const credit = returnCreditFor(aj, results);
    await transactionsRepository.append({
      user: item.user, action: 'return_package', design: results[0]?.design, color: results[0]?.shade,
      qty: totalYards, before: 'sold', after: 'available', status: 'approved',
      warehouse: aj.warehouse || results[0]?.warehouse || '', customerName: returnCust.name, customerId: returnCust.id,
      saleRefId: requestId, pricePerYard: credit.rate || '',
    });
    // RET-3 — see return_than above.
    try {
      await erpEmitAsync('return', { type: 'return_package', packageNo: aj.packageNo, yards: totalYards, pricePerYard: credit.rate, design: results[0]?.design, shade: results[0]?.shade, warehouse: aj.warehouse || results[0]?.warehouse, userId: item.user, txnId: `RP-${aj.packageNo}`, customer: returnCust.name, customerId: returnCust.id });
      if (credit.amount > 0) creditNote = `↩️ Credited ${fmtNgn(credit.amount)} to ${returnCust.name || 'the buyer'} (${results.length} than${results.length === 1 ? '' : 's'}, ${totalYards} yds).`;
      else await recordErpFailure('return credit (return_package)', new Error(`no rate on record for Bale ${aj.packageNo} — stock returned, credit NOT posted; post it manually`));
    } catch (e) { await recordErpFailure('return credit (return_package)', e); }
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
  } else if (aj.action === 'merge_customers') {
    // CUS-1 Phase E — fold the typo into the canonical customer. All the
    // heavy lifting (aliases, Merged status, audit note) lives in the
    // entity; this branch only translates the result for the admin.
    const customerEntity = require('./customerEntity');
    const merged = await customerEntity.mergeInto(aj.canonicalId, aj.typoId);
    if (!merged.ok) {
      return { ok: false, message: `Merge failed: ${merged.reason || 'unknown'}.` };
    }
    await auditLogRepository.append('customers_merged',
      { typo: aj.typoName, typoId: aj.typoId, canonical: aj.canonicalName, canonicalId: aj.canonicalId },
      approvedBy);
  } else if (aj.action === 'record_payment') {
    const crmService = require('./crmService');
    const payRes = await crmService.recordPayment({ customer: aj.customerId || aj.customer, amount: aj.amount, method: aj.method, userId: item.user });
    if (payRes.status !== 'completed') return { ok: false, message: payRes.message || 'Payment failed.' };
  } else if (aj.action === 'add_customer') {
    const crmService = require('./crmService');
    const addRes = await crmService.addCustomer({
      name: aj.name, phone: aj.phone, address: aj.address,
      category: aj.category, credit_limit: aj.credit_limit,
      payment_terms: aj.payment_terms, notes: aj.notes,
    });
    // CUS-2 — a name/alias collision used to be swallowed here and the
    // approval reported success for a no-op. Fail loud instead.
    if (!addRes || addRes.status !== 'created') {
      const ex = (addRes && addRes.customer) || {};
      return { ok: false, message: `Customer "${aj.name}" already exists as ${ex.name || 'an existing customer'}${ex.customer_id ? ` (${ex.customer_id})` : ''} — nothing was created. Pick them from the customer list instead.` };
    }
    // CON-1 — this action is retired (nothing produces it any more), but
    // rows raised before the change can still be sitting in the queue.
    // Approving one used to leave a customer with no node in the network.
    // Stitch it here too, so the retired door cannot deposit a split-brain
    // on its way out. Fire-and-forget: the customer already exists, so a
    // node failure must not report the approval as failed.
    try {
      const contactsRepository = require('../repositories/contactsRepository');
      await contactsRepository.append({
        name: aj.name || '', phone: aj.phone || '', type: 'customer',
        address: aj.address || '', notes: aj.notes || '',
        customer_id: addRes.customer.customer_id, updated_by: approvedBy,
      });
    } catch (nodeErr) {
      logger.error(`add_customer: contacts node failed for ${aj.name}: ${nodeErr.message}`);
    }
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
  } else if (aj.action === 'remove_customer' || aj.action === 'restore_customer') {
    // RMV-1 (owner, 16-Aug-2026) — removal is a STATUS FLIP, never a
    // deletion (§14). The bot has no row-delete primitive and must not
    // gain one: the Inventory sold rows recording what this customer was
    // supplied are history, and §12 forbids falsifying them.
    //
    // CON-1 made a customer exist in BOTH registers — the Customers row
    // and a bound Contacts node. So removal moves BOTH. Flipping one and
    // leaving the other re-opens the split-brain from the other side: a
    // person gone from the customer list but still live in the network,
    // or the reverse.
    const removing = aj.action === 'remove_customer';
    const customersRepo2 = require('../repositories/customersRepository');
    const contactsRepo2 = require('../repositories/contactsRepository');

    const all = await customersRepo2.getAll();
    const target = all.find((c) => c.customer_id === String(aj.customer_id || ''));
    if (!target) {
      return { ok: false, message: `Customer ${aj.customer_id || '(no id)'} no longer exists — nothing was changed.` };
    }
    const isInactive = String(target.status || 'Active').trim().toLowerCase() === 'inactive';
    // CUS-2 fail-loud: an approval must never report success for a no-op.
    if (removing && isInactive) {
      return { ok: false, message: `*${target.name}* was already removed — nothing was changed.` };
    }
    if (!removing && !isInactive) {
      return { ok: false, message: `*${target.name}* is already active — nothing was changed.` };
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const reason = String(aj.reason || '').trim();
    // §14 keeps the STATUS cell as machinery. The why goes to the queue row
    // (permanent), the AuditLog, and a short dated stamp a human reading
    // the sheet can follow — no new column (CLAUDE.md rule 4).
    const noteStamp = removing
      ? `[removed ${stamp}${reason ? `: ${reason}` : ''}]`
      : `[restored ${stamp}${reason ? `: ${reason}` : ''}]`;
    const notes = [String(target.notes || '').trim(), noteStamp].filter(Boolean).join(' ');

    await customersRepo2.updateRow(target.customer_id, {
      status: removing ? 'inactive' : 'Active',
      notes,
    });

    // The bound node. Fire-and-forget: the register is already correct, so
    // a node failure must not report the approval as failed — but it must
    // be loud in the log, because the two registers are now out of step.
    let nodeMoved = false;
    try {
      const node = await contactsRepo2.findByCustomerId(target.customer_id);
      if (node) {
        await contactsRepo2.update(node.contact_id,
          { status: removing ? 'inactive' : 'active' }, approvedBy);
        nodeMoved = true;
      }
    } catch (nodeErr) {
      logger.error(`${aj.action}: contacts node not moved for ${target.name}: ${nodeErr.message}`);
    }

    await auditLogRepository.append(aj.action, {
      customer_id: target.customer_id, name: target.name,
      reason: reason || '(none given)', node_moved: nodeMoved,
      outstanding_at_action: target.outstanding_balance || 0,
    }, approvedBy);

    // NOT an early return: the shared tail marks the queue row approved and
    // writes the approval audit line. Returning here would leave the request
    // pending for ever — a live card that a second admin could execute again.
    customMessage = removing
      ? `🚪 *${target.name}* removed.\nThey no longer appear in customer pickers, search or the network. Every sale on record is untouched.${nodeMoved ? '' : '\n\n⚠️ Their network node was not found — the customer list is correct, the network may still show them.'}`
      : `↩️ *${target.name}* restored and active again.${nodeMoved ? '' : '\n\n⚠️ Their network node was not found — restore it from Contact Network if needed.'}`;
  } else if (aj.action === 'add_bank') {
    const settingsRepo2 = require('../repositories/settingsRepository');
    const bankEntry = require('../utils/bankEntry');
    const all = await settingsRepo2.getAll();
    const banks = (all.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean);
    // BANK-3 — normalise at the WRITE, so "OPAY — OPAY" can never enter the
    // list even from a request queued before the flow fix (or by any future
    // caller). Dedupe compares normalised too: "X — X" IS "X".
    const entry = bankEntry.normalize(aj.bank_name);
    if (!entry) return { ok: false, message: 'Bank name missing.' };
    if (banks.some((b) => bankEntry.same(b, entry))) {
      return { ok: false, message: `Bank "${entry}" already exists.` };
    }
    banks.push(entry);
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
    // CNET-2 (owner, 13-Aug-2026) — the approving admin ROUTES the contact.
    // aj.destination is persisted by the triage chips before approval:
    //   'customer' → CRM entity + a Contacts node bound to it (buyer node)
    //   'network'  → Contacts node + subordinate_of edge under aj.boss_contact_id
    //   'contact' / absent → phonebook only (pre-CNET-2 behaviour, and the
    //   safe default for a plain approve from any old or generic surface)
    const contactsRepository = require('../repositories/contactsRepository');
    // CON-1 (owner, 15-Aug-2026) — a plain Approve now HONOURS the kind
    // the requester picked. Before, every untriaged approval fell to the
    // phonebook, so a request explicitly raised as a CUSTOMER could be
    // approved and still not exist in the customer list — the exact
    // split-brain CNET-2 was built to end, arriving through the other
    // door. The chips remain the admin's override; this only changes
    // what silence means.
    const dest = aj.destination || (aj.type === 'customer' ? 'customer' : 'contact');
    if (dest === 'customer') {
      const crmService = require('./crmService');
      const addRes = await crmService.addCustomer({
        name: aj.name, phone: aj.phone, address: aj.address, notes: aj.notes,
        // CON-1 — the sub-categories the flow collected for a customer.
        // Absent on a request raised as any other kind, and crmService
        // applies its own defaults then.
        category: aj.category, credit_limit: aj.credit_limit,
        payment_terms: aj.payment_terms,
      });
      // CUS-2 fail-loud, same as add_customer: a collision must never
      // report success for a no-op. The request stays pending so the admin
      // can route it to 📒 Contact instead (or reject).
      if (!addRes || addRes.status !== 'created') {
        const ex = (addRes && addRes.customer) || {};
        return { ok: false, message: `"${aj.name}" already exists as customer ${ex.name || ''}${ex.customer_id ? ` (${ex.customer_id})` : ''} — nothing was created. Choose 📒 Contact on the card, or reject.` };
      }
      await contactsRepository.append({
        name: aj.name || '', phone: aj.phone || '', type: 'customer',
        address: aj.address || '', notes: aj.notes || '',
        customer_id: addRes.customer.customer_id, updated_by: approvedBy,
      });
      customMessage = `✅ ${aj.name} registered as a CUSTOMER (${addRes.customer.customer_id}) — sale-assignable, and in the network as a buyer.`;
      // IDR-4 — raised from a Pending user's card: bind their Telegram
      // account to the new customer entity. Best-effort, never un-approves.
      if (aj.pendingTelegramId) {
        const linked = await _linkPendingAccount(aj.pendingTelegramId,
          { type: 'customer', id: addRes.customer.customer_id, name: aj.name }, approvedBy);
        customMessage += linked ? ' Telegram account linked.'
          : ' ⚠️ Telegram link failed — link them from 👋 Pending Users.';
      }
    } else if (dest === 'network' && aj.boss_contact_id) {
      const created = await contactsRepository.append({
        name: aj.name || '', phone: aj.phone || '', type: aj.type || 'other',
        address: aj.address || '', notes: aj.notes || '', updated_by: approvedBy,
      });
      const contactLinksRepo = require('../repositories/contactLinksRepository');
      const link = await contactLinksRepo.append({
        from_contact_id: created.contact_id, to_contact_id: aj.boss_contact_id,
        relation: 'subordinate_of', notes: aj.notes || '', created_by: item.user,
      });
      customMessage = link.duplicate
        ? `ℹ️ ${aj.name} added to contacts — the link under ${aj.boss_name} already existed.`
        : `✅ ${aj.name} added to contacts and placed under ${aj.boss_name} in the network.`;
      if (aj.pendingTelegramId) {
        await _linkPendingAccount(aj.pendingTelegramId,
          { type: 'contact', id: created.contact_id, name: aj.name }, approvedBy);
      }
    } else {
      const createdContact = await contactsRepository.append({
        name: aj.name || '', phone: aj.phone || '', type: aj.type || 'other',
        address: aj.address || '', notes: aj.notes || '', updated_by: approvedBy,
      });
      customMessage = `✅ ${aj.name} added to the contacts phonebook (${aj.type || 'other'}).`;
      // IDR-4 — the approving admin may route a pending-user request to the
      // phonebook via the chips; the account still gets bound, as a contact.
      if (aj.pendingTelegramId) {
        await _linkPendingAccount(aj.pendingTelegramId,
          { type: 'contact', id: (createdContact && createdContact.contact_id) || '', name: aj.name }, approvedBy);
      }
    }
  } else if (aj.action === 'receive_goods') {
    // P2 — write GRN header, then append bales via inventoryRepository so
    // server-generated bale_uid + addedAt are stamped per row, then drop a
    // Stock_Ledger line per bale for the audit trail.
    const goodsReceiptsRepo = require('../repositories/goodsReceiptsRepository');
    const balesIn = Array.isArray(aj.bales) ? aj.bales : [];
    // TRF-INT3 (owner rule 1) — an incoming bale number colliding with a
    // LIVE bale (available / in_transit) in this warehouse is refused: no
    // proof of no-collision → no row. Only the clashing lines are dropped;
    // a number whose previous bale is fully SOLD may return.
    const pk = (v) => String(v ?? '').trim();
    const conflicts = await inventoryRepository.liveBaleConflicts(balesIn.map((b) => b.packageNo), aj.warehouse);
    const collisionLines = [...conflicts.values()].map((c) =>
      `Bale ${c.packageNo}: already live in ${aj.warehouse} (${c.design}${c.status === 'in_transit' ? ', in transit' : ''}${c.dateReceived ? `, received ${c.dateReceived}` : ''}) — NOT added`);
    const bales = balesIn.filter((b) => !conflicts.has(pk(b.packageNo)));
    if (!bales.length) {
      return { ok: false, message: `Every bale number already exists live in ${aj.warehouse}:\n${collisionLines.join('\n')}` };
    }
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
      dateReceived: aj.dateReceived || todayInLagos(),  // TIME-1 — Lagos day
      productType: aj.productType || 'fabric',
      grnId: grn.grn_id,
      binLocation: b.binLocation || aj.binLocation || '',
      // ARRIVAL-BATCH C1 — operator-chosen container label (e.g. "July26").
      arrivalBatch: aj.arrivalBatch || '',
    }));
    const persisted = await stockEngine.intakeBale(baleRows, { event: 'intake', approvalId: requestId, adminId: approvedBy });
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
                     poId: aj.po_id || '', poUpdate,
                     // TRF-INT3 — colliding lines the gate refused (owner rule 1).
                     collisions: collisionLines };
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
    // TRF-INT3 (owner rule 1) — same intake gate as receive_goods: a than
    // whose bale number is already LIVE (available/in_transit) in this
    // warehouse is refused before any totals or the GRN header are written.
    const pkB = (v) => String(v ?? '').trim();
    const bulkConflicts = await inventoryRepository.liveBaleConflicts(thans.map((b) => b.packageNo), aj.warehouse);
    const bulkCollisionLines = [...bulkConflicts.values()].map((c) =>
      `Bale ${c.packageNo}: already live in ${aj.warehouse} (${c.design}${c.status === 'in_transit' ? ', in transit' : ''}) — NOT added`);
    thans = thans.filter((b) => !bulkConflicts.has(pkB(b.packageNo)));
    if (!thans.length) {
      return { ok: false, message: `Every bale number already exists live in ${aj.warehouse}:\n${bulkCollisionLines.join('\n')}` };
    }
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
      dateReceived: aj.dateReceived || todayInLagos(),  // TIME-1 — Lagos day
      productType: aj.productType || 'fabric',
      grnId: grn.grn_id,
      // ARRIVAL-BATCH C1 — operator-chosen container label (e.g. "July26").
      arrivalBatch: aj.arrivalBatch || '',
      // BULK-INDENT — supplier indent + CS number from the upload file, so
      // container rows match hand-entered rows (Indent / CSNo columns).
      indent: b.indent || '',
      csNo: b.csNo || '',
    }));
    const persisted = await stockEngine.intakeBale(baleRows, { event: 'intake', approvalId: requestId, adminId: approvedBy });
    // PL-1 — staged rows are in the sheet now; drop the temp file.
    if (aj.balesStagedPath) {
      try { require('fs').unlinkSync(aj.balesStagedPath); } catch (_) { /* best-effort */ }
    }


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

    // CAT-C1 — fresh-photo checklist for the landed container: which of its
    // designs still lack an active (design, batch) catalogue photo. Consumed
    // by approvalEvents to broadcast ONE card to env admins.
    let photoChecklist = null;
    if (aj.arrivalBatch) {
      try {
        const designAssetsService2 = require('./designAssetsService');
        const landedDesigns = [...new Set(thans.map((b) => String(b.design || '').trim()).filter(Boolean))];
        const missing = await designAssetsService2.listDesignsMissingBatchPhoto(landedDesigns, aj.arrivalBatch);
        if (missing.length) photoChecklist = { batch: aj.arrivalBatch, missingDesigns: missing };
      } catch (e) {
        logger.warn(`CAT-C1 photo checklist skipped: ${e.message}`);
      }
    }

    bundleReport = {
      grnId: grn.grn_id,
      baleCount: totalBales,
      thanCount: persisted.length,
      totalYards,
      poId: aj.po_id || '', poUpdate,
      source: aj.source || 'bulk_csv', fileHash, fileName: aj.fileName || '',
      photoChecklist,
      // TRF-INT3 — colliding lines the gate refused (owner rule 1).
      collisions: bulkCollisionLines,
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
  } else if (aj.action === 'task_reminder_enable') {
    // TRM-1 — the second admin's signature is what arms a task's automatic
    // reminders (owner: "the last door of reminder will only go through it
    // once it gets approved through two admin gateways"). Everything else
    // about the task is untouched: this flips one flag, and the sweep is
    // what actually speaks.
    const tasksRepo = require('../repositories/tasksRepository');
    const taskId = String(aj.task_id || '').trim();
    if (!taskId) return { ok: false, message: 'task_reminder_enable: task_id missing.' };
    const task = await tasksRepo.getById(taskId);
    if (!task) return { ok: false, message: `task_reminder_enable: ${taskId} not found.` };
    if (task.auto_remind) {
      // Idempotent: a double-approve must not report a second arming.
      customMessage = `🔁 Reminders were already armed for "${task.title}".`;
    } else {
      const openStatuses = ['assigned', 'awaiting_timeline_ack', 'awaiting_incentive',
        'awaiting_final_ack', 'active', 'submitted'];
      if (!openStatuses.includes(task.status)) {
        return { ok: false, message: `task_reminder_enable: "${task.title}" is ${task.status} — nothing left to remind about.` };
      }
      await tasksRepo.updateFields(taskId, { auto_remind: '1' });
      try {
        await require('../repositories/taskEventsRepository').append({
          task_id: taskId, event_type: 'auto_remind_armed',
          from_status: task.status, to_status: task.status,
          actor_user_id: approvedBy, meta: { requested_by: item.user },
        });
      } catch (e) { logger.warn(`task_reminder_enable audit failed: ${e.message}`); }
      // NOTE (TRM-1, verified 27-Aug-2026): `customMessage` is NOT rendered
      // on the approve-success path — both callers in approvalEvents write
      // their own generic "approved. Changes applied." line. That is a
      // repo-wide gap, not this feature's, and closing it means editing
      // approvalEvents (owner sign-off required). So TRM-1 never depends on
      // it: the doer learns from the next sweep, the assigner from the
      // mirror line, and the task card itself says reminders are ON.
      customMessage = `🔁 Automatic reminders armed for "${task.title}" — ${aj.doer_name || 'the doer'} will be nudged until it is no longer their move, and you are copied on every nudge.`;
    }
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
    if (String(target.status || 'active').trim().toLowerCase() !== 'active') {
      return { ok: false, message: `deactivate_user: ${tgId} is already ${target.status}.` };
    }
    // RMV-1 (owner, 16-Aug-2026) — two guards the analysis found missing.
    // The picker deliberately offers admins and the executor checked only
    // "not found" / "already inactive", so nothing stopped an admin from
    // removing themselves, or the business from being left with none.
    if (tgId === String(item.user || '').trim()) {
      return { ok: false, message: 'You cannot remove yourself. Ask another admin to raise it.' };
    }
    const isAdminRow = String(target.role || '').trim().toLowerCase() === 'admin';
    if (isAdminRow) {
      const remaining = (await usersRepo.getAll()).filter((u) =>
        String(u.user_id || '') !== tgId
        && String(u.role || '').trim().toLowerCase() === 'admin'
        && String(u.status || 'active').trim().toLowerCase() === 'active');
      // Env-held admins (config.access.adminIds) are not in the sheet at
      // all and cannot be removed by this action, so they count as cover.
      const envAdmins = (config.access.adminIds || []).map(String).filter((id) => id !== tgId);
      if (!remaining.length && !envAdmins.length) {
        return { ok: false, message: `Refusing: *${target.name || tgId}* is the last active admin. Promote someone else first.` };
      }
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
    // STK-E1 — through the repository like every other Inventory write;
    // this executor was the ONE raw column-I writer outside it.
    const renamed = await stockEngine.renameWarehouse(oldName, newName,
      { event: 'rename', approvalId: requestId, adminId: approvedBy });
    if (!renamed) return { ok: false, message: `No inventory rows reference "${oldName}".` };
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
    bundleReport = { renamed, from: oldName, to: newName };
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
      // TRF-INT4 — each item sells only in the warehouse the flow picked it
      // from (per-item, falling back to the bundle's). Pre-TRF-INT4 pending
      // bundles carry neither → legacy unscoped match.
      const siWh = si.warehouse || aj.warehouse;
      if (si.type === 'package') {
        const results = await stockEngine.sellPackage(si.packageNo, aj.customer, aj.salesDate, { warehouse: siWh }, { event: 'sale', approvalId: requestId, adminId: approvedBy });
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
          if (rate > 0) await inventoryRepository.updatePrice({ packageNo: si.packageNo, warehouse: siWh }, rate);
        }
      } else if (si.type === 'than') {
        const result = await stockEngine.sellThan(si.packageNo, si.thanNo, aj.customer, aj.salesDate, { warehouse: siWh }, { event: 'sale', approvalId: requestId, adminId: approvedBy });
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
          if (rate > 0) await inventoryRepository.updatePrice({ packageNo: si.packageNo, warehouse: siWh }, rate);
        }
      } else {
        failedItems.push({ packageNo: si.packageNo, thanNo: si.thanNo, type: si.type || 'unknown', reason: `unknown item type "${si.type}"` });
      }
    }
    // APF-1 (owner report, 08-Aug-2026): when NOTHING flipped, this must
    // not fall through to the money footer — it used to post the payment,
    // issue a fresh invoice and append a qty-0 Transactions row for a sale
    // that sold nothing (reachable via a duplicate request, or when
    // re-approving an executed-but-unresolved row). Refuse instead; the
    // admin gets the safe Mark-as-done / Reject choice upstream.
    if ((aj.items || []).length && failedItems.length === (aj.items || []).length) {
      return {
        ok: false, allItemsFailed: true,
        message: 'no item could be applied — every bale/than in this request is already sold or not found.',
      };
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
      customerId: aj.customerId || '',
    });
    // Post sale to ledger so customer has DR (receivable) = yards * rate; outstanding = previous + this sale - payments
    const designsToEmit = Object.keys(byDesign).length ? Object.entries(byDesign) : [['', totalYards]];
    for (const [design, yards] of designsToEmit) {
      if (!yards || yards <= 0) continue;
      const pricePerYard = getPricePerYard(enrichment, design);
      const payload = { type: 'sale_bundle', customer: aj.customer, customerId: aj.customerId || '', yards, pricePerYard, design: design || undefined, shade: '', userId: item.user, txnId: `${requestId}-${design || 'sale'}`, paymentMode: enrichment?.paymentMode ?? '', amountPaid: enrichment?.amountPaid ?? 0 };
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
  } else if (aj.action === 'register_payment_account') {
    // PAY-1 — the second admin's signature is what turns a proposed payee
    // account into one the business may actually send money to. Until
    // this runs the row is 'pending' and no payment flow will offer it.
    const paymentAccountsRepo = require('../repositories/paymentAccountsRepository');
    const acct = await paymentAccountsRepo.findByApprovalRequestId(requestId);
    if (!acct) return { ok: false, message: 'Payment account row not found for this request.' };
    // PAY-ID (owner hard rule, 23-Aug-2026) — re-verify the linked identity
    // AT APPROVAL, not just at submit. A request raised while someone was an
    // employee must not become a payable account after they were deactivated
    // or removed. Contractors carry no Telegram identity by design; PAY-1's
    // admin-vouches rule covers them at the door.
    const ownerType = String(acct.owner_type || aj.owner_type || '').toLowerCase();
    if (ownerType !== 'contractor') {
      const linkedId = acct.owner_telegram_id || aj.owner_telegram_id || '';
      const employeeIdentity = require('./employeeIdentity');
      const check = await employeeIdentity.verifyEmployee(linkedId);
      if (!check.ok) {
        return { ok: false, message: `Not registered: ${check.message}` };
      }
    }
    if (acct.status === 'active') {
      customMessage = `ℹ️ ${acct.owner_name}'s account was already active — nothing changed.`;
    } else {
      await paymentAccountsRepo.setStatus(acct.account_id, 'active', approvedBy);
      customMessage = `✅ Account registered for *${acct.owner_name}* — ${acct.bank} ${acct.account_number}. Payments may now be raised against it.`;
    }
  } else if (aj.action === 'request_payment') {
    // PAY-1 — approval AUTHORISES the payment; it does not pay it. The
    // request moves to the finance head's queue, and the money only
    // leaves when a human transfers it at the bank and taps Mark Done.
    const paymentRequestsRepo = require('../repositories/paymentRequestsRepository');
    const pay = await paymentRequestsRepo.findByApprovalRequestId(requestId);
    if (!pay) return { ok: false, message: 'Payment request row not found for this request.' };
    if (pay.status !== 'pending_approval') {
      customMessage = `ℹ️ Payment ${pay.payment_id} is already ${pay.status} — nothing changed.`;
    } else {
      await paymentRequestsRepo.update(pay.payment_id, { status: 'approved', approved_by: approvedBy });
      const paymentService = require('./paymentService');
      customMessage = `✅ Payment of ${paymentService.fmtNaira(pay.amount_ngn)} to *${pay.payee_name}* approved — now with finance to pay.`;
    }
  } else if (aj.action === 'design_asset_upload' && aj.kind === 'shade') {
    // SHP-1 — a batch of per-shade garment photos rides the same action
    // code as catalogue pages; each shade supersedes the earlier active
    // photo for the SAME (design, shade, container) and goes live.
    const shadeAssets = require('./designShadeAssetsService');
    const r = await shadeAssets.activateByApprovalRequestId(requestId, approvedBy);
    if (!r.ok) return { ok: false, message: r.message || 'Could not activate the shade photos.' };
    const names = (r.shades || []).map((s) => `#${s.number}${s.name ? ` ${s.name}` : ''}`).join(' · ');
    customMessage = `✅ ${r.count} shade photo(s) for *${r.design}* now live — ${names}. They show the moment that shade is picked in Orders and My Collection.`;
  } else if (aj.action === 'design_asset_upload') {
    // Activate the staged DesignAssets row keyed by this requestId. Any
    // older active asset for the same design is automatically marked
    // 'replaced' so consumers always read the freshest photo.
    const designAssetsService = require('./designAssetsService');
    // CAT-P1 — the uploader chose "add as page" or "replace" at upload time;
    // the choice rides the request so approval simply honours it.
    const r = await designAssetsService.activateByApprovalRequestId(requestId, approvedBy,
      { addPage: aj.catalogMode === 'add_page' });
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
  } else if (aj.action === 'add_contact_link') {
    // CNET-1b — create/reuse the person node, then the subordinate edge.
    const contactsRepo = require('../repositories/contactsRepository');
    const contactLinksRepo = require('../repositories/contactLinksRepository');
    let personId = aj.existing_contact_id;
    if (!personId) {
      const created = await contactsRepo.append({
        name: aj.name || '', phone: aj.phone || '', type: 'worker',
        notes: aj.notes || '', updated_by: approvedBy,
      });
      personId = created.contact_id;
    }
    const link = await contactLinksRepo.append({
      from_contact_id: personId, to_contact_id: aj.boss_contact_id,
      relation: 'subordinate_of', notes: aj.notes || '', created_by: item.user,
    });
    customMessage = link.duplicate
      ? `ℹ️ ${aj.name} was already linked under ${aj.boss_name}.`
      : `✅ ${aj.name} added under ${aj.boss_name}.`;
  } else if (aj.action === 'set_reminder_config') {
    // APR-2 — approved reminder toggle: write the Settings key. The
    // policy layer reads it live (30s Settings cache), no restart needed.
    // Falls through to the shared footer (SEC-P2: the row must be marked
    // approved or it stays re-approvable).
    const settingsRepo = require('../repositories/settingsRepository');
    const reminderPolicy = require('./reminderPolicy');
    const key = aj.setting_key || reminderPolicy.keyFor(aj.scope, aj.dept);
    await settingsRepo.set(key, String(Number(aj.hours) || 0));
    try {
      await auditLogRepository.append('reminder_config_changed',
        { key, hours: Number(aj.hours) || 0, scope: aj.scope, dept: aj.dept || '' }, approvedBy);
    } catch (_) { /* best effort */ }
    customMessage = `Reminders ${Number(aj.hours) > 0 ? `ON (every ${aj.hours}h)` : 'OFF'} for ${aj.scope === 'admin' ? 'admin nudges' : aj.dept}.`;
  } else if (aj.action === 'update_contact_info') {
    // CNET-1b.1 — apply the approved detail change to the Contacts row;
    // phone/address also mirror to the CRM Customers row when the person
    // is a registered buyer (the card reads the LIVE CRM value for them).
    const contactsRepo = require('../repositories/contactsRepository');
    const updated = await contactsRepo.update(aj.contact_id, { [aj.field]: aj.new_value }, approvedBy);
    if (!updated) return { ok: false, message: 'Contact not found.' };
    if (aj.customer_id && (aj.field === 'phone' || aj.field === 'address')) {
      try {
        const customersRepo = require('../repositories/customersRepository');
        await customersRepo.updateRow(aj.customer_id, { [aj.field]: updated[aj.field] });
      } catch (e) { await recordErpFailure('contact update CRM mirror', e); }
    }
    customMessage = `✅ ${aj.name}: ${aj.field} updated.`;
  } else if (aj.action === 'register_marketer') {
    const marketersRepo = require('../repositories/marketersRepository');
    const row = await marketersRepo.findByApprovalRequestId(requestId);
    if (!row) return { ok: false, message: 'Marketer record not found.' };
    await marketersRepo.updateStatus(row.rowIndex, 'active', approvedBy);
    // IDR-4 — a registration raised from a Pending user's card also binds
    // that Telegram account to the new marketer, so approve = active AND
    // linked (📦 My Products works on their next tap). Best-effort: a link
    // failure never un-approves the marketer.
    if (aj.pendingTelegramId) {
      const linked = await _linkPendingAccount(aj.pendingTelegramId,
        { type: 'marketer', id: row.marketer_id, name: row.name || aj.name }, approvedBy);
      customMessage = `✅ Marketer ${row.name || aj.name} approved and active.`
        + (linked ? ' Telegram account linked — their 🧵 collection is live.'
          : ' ⚠️ Telegram link failed — link them from 👋 Pending Users.');
    }
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

  // INV-1a — issue a customer invoice for every approved sale (owner
  // decision 14-Jul: sales only). Best-effort like the erp hooks: a failed
  // invoice must never fail the applied sale. The admin-entered enrichment
  // is persisted onto the queue row first so the invoice (and any future
  // regeneration) has the rates/payment that were previously lost.
  const INVOICED_ACTIONS = ['sell_than', 'sell_package', 'sell_batch', 'sell_mixed', 'sell', 'sale_bundle'];
  let invoice = null;
  if (INVOICED_ACTIONS.includes(aj.action)) {
    if (enrichment) {
      try {
        await approvalQueueRepository.updateActionJSON(requestId, { ...aj, enrichment });
      } catch (e) { await recordErpFailure('enrichment persist', e); }
    }
    try {
      const invoiceService = require('./invoiceService');
      invoice = await invoiceService.createForSale({ item, enrichment, approvedBy });
    } catch (e) { await recordErpFailure('invoice issue', e); }
  }

  // APR-1 — the final tap is the deciding signature; labelFor merges it with
  // any first signature parked in ActionJSON, so a dual approval names BOTH.
  const approverLabel = await require('./approverStamp')
    .labelFor({ actionJSON: aj, actorId: approvedBy });
  await approvalQueueRepository.updateStatus(requestId, 'approved', new Date().toISOString(), approverLabel);
  await auditLogRepository.append('approval_approved', { requestId, approvedBy, approver: approverLabel }, approvedBy);
  // H6 — erpFailures non-empty means stock moved but books did not.
  return { ok: true, bundleReport, message: customMessage, erpFailures, invoice, approver: approverLabel, creditNote };
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
  if (aj.action === 'design_asset_upload' && aj.kind === 'shade') {
    try {
      await require('./designShadeAssetsService').rejectByApprovalRequestId(requestId, rejectedBy);
    } catch (_) { /* non-fatal: rows stay pending */ }
  } else if (aj.action === 'design_asset_upload') {
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
      // EXP-1b — loud, not just a log line: rows stuck pending_approval
      // keep COUNTING AS SPENT in the running balance (H6 posture). The
      // audit row names the request so the sheet can be fixed by hand.
      logger.error(`record_office_expense reject cleanup FAILED for ${requestId}: ${e.message} — pending rows still depress the cash balance`);
      try {
        const auditLogRepository = require('../repositories/auditLogRepository');
        await auditLogRepository.append('office_expense_reject_cleanup_failed',
          { requestId, error: e.message }, String(rejectedBy || 'system'));
      } catch (_) { /* audit best-effort */ }
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
  const rejecterLabel = await require('./approverStamp')
    .labelFor({ actionJSON: aj, actorId: rejectedBy });
  await approvalQueueRepository.updateStatus(requestId, 'rejected', new Date().toISOString(), rejecterLabel);
  await auditLogRepository.append('approval_rejected', { requestId, rejectedBy, approver: rejecterLabel }, rejectedBy);
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
    // TRF-INT4 — undo the sale in the warehouse it was made in, so the revert
    // can never resurrect a same-numbered bale somewhere else.
    const siWh = si.warehouse || aj.warehouse;
    if (si.type === 'package') {
      const sold = await inventoryRepository.findByPackage(si.packageNo, { warehouse: siWh });
      const soldThans = sold.filter((t) => t.status === 'sold');
      if (soldThans.length) {
        const undone = await stockEngine.returnPackage(si.packageNo, { warehouse: siWh }, { event: 'return', approvalId: requestId, adminId: userId });
        returnedThans.push(...undone);
      }
    } else if (si.type === 'than') {
      const than = await inventoryRepository.findThan(si.packageNo, si.thanNo, { warehouse: siWh });
      if (than && than.status === 'sold') {
        const undone = await stockEngine.returnThan(si.packageNo, si.thanNo, { warehouse: siWh }, { event: 'return', approvalId: requestId, adminId: userId });
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
  // CUS-2 — the original sale's customer (admin-assigned at approval) rides
  // on the reversal so the credit lands on their statement, not anonymously.
  const revCust = await resolveReturnCustomer(customer);
  for (const [design, g] of Object.entries(byDesign)) {
    if (g.yards > 0) {
      try {
        await accountingService.recordReturn({ yards: g.yards, pricePerYard: g.pricePerYard, packageNo: g.packageNo, design, shade: g.shade, userId, txnId: `REVERT-${requestId}-${design}`, customer: revCust.name, customerId: aj.customerId || revCust.id });
      } catch (e) {
        // continue with other designs
      }
    }
  }
  return { ok: true, revertedThans: returnedThans.length };
}

async function getWarehouses() {
  return inventoryRepository.getWarehouses();
}

module.exports = {
  _internals: { returnCreditFor }, // RET-3 — pure helper, pinned by smoke S54.15
  checkStock,
  getPackageSummary,
  listPackages,
  sellThan,
  sellPackage,
  returnThan,
  returnPackage,
  updatePrice,
  executeApprovedAction,
  rejectApproval,
  revertSaleBundle,
  getWarehouses,
  formatMoney,
};
