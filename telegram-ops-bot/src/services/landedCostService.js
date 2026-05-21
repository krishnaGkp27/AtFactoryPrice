'use strict';

/**
 * src/services/landedCostService.js
 *
 * Pure(-ish) engine for the Landed Cost feature (LANDED-COST C1).
 *
 * The "math" portion (computeAllocation, buildPreview, getForBale) is
 * Telegram-free + offline-testable — smoke S27 hits it directly.
 *
 * The "submission" portion (submitForApproval, applyApproved,
 * cancelPending) talks to the approval queue + sheets, exactly mirroring
 * the warehouseFlow → approvalEvents handoff.
 *
 * Owner decisions (2026-05-21 brief):
 *   Q1 allocation rule    : PER YARD across all bales in the GRN
 *   Q2 charge types       : editable catalogue (LandedCostTypes sheet)
 *   Q3 entry time         : after receipt (separate "Finalize" flow)
 *   Q4 FX rate locking    : locked at FINALIZE time (from ForexRates)
 *   Q5 Inventory schema   : not touched — lookup via grn_id
 *   Q6 container model    : ONE GRN = ONE container (V1)
 *   Q7 approval gate      : dual-admin (finalize_landed_cost ∈ ALWAYS_APPROVAL_ACTIONS)
 *
 * Formula (allocation = PER YARD, charges sum first, then add per-yard):
 *
 *     usd_charges_per_yard  = total_charges_usd / total_yards_in_grn
 *     usd_landed_per_yard   = usd_cost_per_yard + usd_charges_per_yard
 *     ngn_landed_per_yard   = usd_landed_per_yard * fx_rate_at_receipt
 *
 * If total_yards == 0 (degenerate empty GRN) the service refuses to
 * finalize — owner sanity check.
 */

const containerChargesRepository = require('../repositories/containerChargesRepository');
const goodsReceiptsRepository    = require('../repositories/goodsReceiptsRepository');
const approvalQueueRepository    = require('../repositories/approvalQueueRepository');
const auditLogRepository         = require('../repositories/auditLogRepository');
const settingsRepository         = require('../repositories/settingsRepository');
const idGenerator                = require('../utils/idGenerator');
const riskEvaluate               = require('../risk/evaluate');
const auth                       = require('../middlewares/auth');
const logger                     = require('../utils/logger');
const forex                      = require('../integrations/forex');

/**
 * Compute the allocation for a single GRN given its own header + an
 * array of charge amounts (USD) + an FX rate.
 *
 * Pure function — no I/O. Used by both the preview card (before
 * approval) and the apply path (after approval).
 *
 * @param {Object} grn            { total_yards, lc_usd_per_yard }
 * @param {number} usdPerYard     admin's USD cost-per-yard input
 * @param {Array<{amount_usd:number}>} charges
 * @param {number} fxRate
 * @returns {{
 *   totalYards: number,
 *   chargesUsd: number,
 *   usdChargesPerYard: number,
 *   usdLandedPerYard: number,
 *   ngnLandedPerYard: number,
 *   fxRate: number,
 *   chargeCount: number,
 * }}
 */
function computeAllocation({ totalYards, usdPerYard, charges, fxRate }) {
  const y = Number(totalYards) || 0;
  const u = Number(usdPerYard) || 0;
  const fx = Number(fxRate) || 0;
  if (y <= 0) {
    const err = new Error('Cannot finalize landed cost: GRN has 0 yards.');
    err.code = 'LC_ZERO_YARDS';
    throw err;
  }
  if (u <= 0) {
    const err = new Error('USD cost per yard must be > 0.');
    err.code = 'LC_BAD_USD';
    throw err;
  }
  if (fx <= 0) {
    const err = new Error('FX rate must be > 0.');
    err.code = 'LC_BAD_FX';
    throw err;
  }
  const list = Array.isArray(charges) ? charges : [];
  const chargesUsd = list.reduce((s, c) => s + (Number(c.amount_usd) || 0), 0);
  const usdChargesPerYard = +(chargesUsd / y).toFixed(8);
  const usdLandedPerYard = +(u + usdChargesPerYard).toFixed(8);
  const ngnLandedPerYard = +(usdLandedPerYard * fx).toFixed(4);
  return {
    totalYards: y,
    chargesUsd: +chargesUsd.toFixed(4),
    usdChargesPerYard,
    usdLandedPerYard,
    ngnLandedPerYard,
    fxRate: fx,
    chargeCount: list.length,
  };
}

/**
 * Build a human-readable preview card text for the approval queue.
 * Markdown-safe (escapes characters that would break Telegram parsing).
 */
function buildPreviewText({ grn, usdPerYard, charges, allocation }) {
  const lines = [];
  lines.push(`💵 *Finalize Landed Cost — \`${grn.grn_id}\`*`);
  lines.push('');
  lines.push(`• Warehouse: *${escapeMd(grn.warehouse || '—')}*`);
  lines.push(`• Supplier:  ${escapeMd(grn.supplier || '—')}`);
  lines.push(`• Bales / Yards: ${grn.total_bales || 0} / ${allocation.totalYards}`);
  lines.push('');
  lines.push(`• USD cost / yard: *$${fmt(usdPerYard)}*`);
  lines.push(`• Charges (sum):   *$${fmt(allocation.chargesUsd)}*  (${allocation.chargeCount} items)`);
  if (charges && charges.length) {
    for (const c of charges) {
      lines.push(`    – ${escapeMd(c.type_name)}: $${fmt(c.amount_usd)}`);
    }
  }
  lines.push(`• Charges / yard:  $${fmt(allocation.usdChargesPerYard)}`);
  lines.push('');
  lines.push(`• USD landed / yd: *$${fmt(allocation.usdLandedPerYard)}*`);
  lines.push(`• FX (USD→NGN):    ${fmt(allocation.fxRate)}`);
  lines.push(`• *NGN landed / yd: ₦${fmt(allocation.ngnLandedPerYard)}*`);
  lines.push('');
  lines.push('_2nd-admin approval required. Once approved the numbers are sealed onto the GRN row._');
  return lines.join('\n');
}

function fmt(n) {
  const x = Number(n) || 0;
  if (Math.abs(x) >= 100) return x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return x.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
function escapeMd(s) {
  return String(s || '').replace(/([*_`\[\]])/g, '\\$1');
}

/**
 * Look up the cost-per-yard for a single bale via its grn_id back-pointer.
 * Returns 0 (not null) if the GRN has no finalized landed cost — callers
 * can then treat it as "not yet costed" and surface that distinctly.
 *
 * @param {{packageNo:string, grn_id?:string}} bale  inventory row
 * @returns {Promise<{ngnPerYard:number, usdPerYard:number, fxRate:number, finalized:boolean}>}
 */
async function getForBale(bale) {
  if (!bale || !bale.grn_id) return { ngnPerYard: 0, usdPerYard: 0, fxRate: 0, finalized: false };
  const grn = await goodsReceiptsRepository.getById(bale.grn_id);
  if (!grn || grn.lc_status !== 'finalized') {
    return { ngnPerYard: 0, usdPerYard: 0, fxRate: 0, finalized: false };
  }
  return {
    ngnPerYard: Number(grn.lc_ngn_per_yard) || 0,
    usdPerYard: Number(grn.lc_usd_per_yard) || 0,
    fxRate:     Number(grn.lc_fx_rate)      || 0,
    finalized:  true,
  };
}

/**
 * Resolve today's FX rate from the manual provider. Returns null +
 * a user-actionable message if no rate is on file (the flow must
 * catch this and prompt the admin to set it via the Forex Rates UI
 * once that ships, or by typing into the sheet directly today).
 */
async function resolveFxRate({ baseDate } = {}) {
  const date = baseDate || new Date().toISOString().slice(0, 10);
  try {
    const r = await forex.rate('USD', 'NGN', date);
    return { rate: Number(r.rate) || 0, source: r.source, date: r.date };
  } catch (err) {
    if (err.code === 'FOREX_NO_MANUAL_RATE') {
      return { rate: 0, source: 'missing', date, error: err.message };
    }
    throw err;
  }
}

/**
 * List GRNs whose landed-cost is still provisional (the "needs your
 * attention" view). Excludes already-finalized and pending-approval.
 */
async function listProvisional() {
  const all = await goodsReceiptsRepository.getAll();
  return all
    .filter((g) => g.status !== 'cancelled')
    .filter((g) => !g.lc_status || g.lc_status === 'provisional')
    .sort((a, b) => (a.received_at < b.received_at ? 1 : -1));
}

/**
 * Submit a finalize request to the dual-admin approval queue. Stashes
 * the charges + usdPerYard + fxRate in the action payload so the
 * approve handler can write them deterministically without re-reading
 * the (potentially edited) ContainerCharges sheet.
 *
 * @param {Object} p
 * @param {string} p.grnId
 * @param {string} p.userId       Telegram ID of the submitting admin
 * @param {number} p.usdPerYard
 * @param {Array<{type_id:string,type_name:string,amount_usd:number}>} p.charges
 * @param {number} p.fxRate
 * @returns {Promise<{requestId:string, allocation:object}>}
 */
async function submitForApproval({ grnId, userId, usdPerYard, charges, fxRate }) {
  const grn = await goodsReceiptsRepository.getById(grnId);
  if (!grn) throw new Error(`GRN ${grnId} not found`);
  if (grn.lc_status === 'finalized') {
    const err = new Error(`GRN ${grnId} landed cost is already finalized.`);
    err.code = 'LC_ALREADY_FINAL';
    throw err;
  }
  if (grn.lc_status === 'pending_approval') {
    const err = new Error(`GRN ${grnId} already has a pending finalize request.`);
    err.code = 'LC_ALREADY_PENDING';
    throw err;
  }

  // Recompute allocation so the approval card and the apply path use
  // identical numbers (truncation drift can't sneak in via JSON).
  const allocation = computeAllocation({
    totalYards: grn.total_yards,
    usdPerYard,
    charges,
    fxRate,
  });

  const requestId = idGenerator.requestId();
  const aj = {
    action: 'finalize_landed_cost',
    grn_id: grnId,
    usd_per_yard: usdPerYard,
    fx_rate: fxRate,
    fx_source: 'manual',
    total_yards: grn.total_yards,
    charges,                 // snapshot — sealed at submit time
    allocation,              // also snapshotted for the approval card
  };
  const risk = await riskEvaluate.evaluate({ action: 'finalize_landed_cost', userId });
  await approvalQueueRepository.append({
    requestId, user: userId, actionJSON: aj,
    riskReason: risk.reason || 'dual_admin_required', status: 'pending',
  });
  await goodsReceiptsRepository.markPendingLandedCost(grnId, requestId);
  await auditLogRepository.append('approval_queued',
    { requestId, action: 'finalize_landed_cost', grnId, ngnPerYard: allocation.ngnLandedPerYard }, userId);
  logger.info(`landedCostService.submit: queued finalize_landed_cost grn=${grnId} request=${requestId} by=${userId} ngn/yd=${allocation.ngnLandedPerYard}`);

  return { requestId, allocation };
}

/**
 * Apply an approved finalize_landed_cost action: write the charges,
 * then stamp the GRN row's lc_* columns with the locked numbers.
 *
 * Called from inventoryService.executeApprovedAction. The action JSON
 * carries everything we need — no need to re-read user inputs.
 */
async function applyApproved({ aj, approvedBy, requestId }) {
  const grnId = aj.grn_id;
  if (!grnId) throw new Error('applyApproved: missing grn_id in action JSON');

  const allocation = aj.allocation || computeAllocation({
    totalYards: aj.total_yards,
    usdPerYard: aj.usd_per_yard,
    charges: aj.charges || [],
    fxRate: aj.fx_rate,
  });

  // Persist the charges first. If any of them already exist for this
  // GRN (very unlikely — we cleared pending state on submit), we still
  // append: the audit trail values an over-recorded entry over a
  // missing one. Manual cleanup is cheaper than silent gaps.
  if (Array.isArray(aj.charges) && aj.charges.length) {
    await containerChargesRepository.appendMany(aj.charges.map((c) => ({
      grn_id: grnId,
      type_id: c.type_id || '',
      type_name: c.type_name,
      amount_usd: c.amount_usd,
      entered_by: aj.entered_by || String(approvedBy),
      notes: c.notes || '',
    })));
  }

  await goodsReceiptsRepository.finalizeLandedCost(grnId, {
    usdPerYard: aj.usd_per_yard,
    chargesUsd: allocation.chargesUsd,
    fxRate: aj.fx_rate,
    ngnPerYard: allocation.ngnLandedPerYard,
    finalizedAt: new Date().toISOString(),
    finalizedBy: String(approvedBy || ''),
    requestId: String(requestId || ''),
  });

  await auditLogRepository.append('landed_cost_finalized',
    { grnId, requestId, ngnPerYard: allocation.ngnLandedPerYard, chargesUsd: allocation.chargesUsd, fxRate: aj.fx_rate },
    String(approvedBy || 'system'));

  return { ok: true, allocation, grnId };
}

/**
 * If the approver REJECTS the finalize request, flip the GRN back to
 * `provisional` so the admin can re-submit with corrected numbers.
 */
async function cancelPending(grnId) {
  await goodsReceiptsRepository.clearPendingLandedCost(grnId);
  return true;
}

module.exports = {
  computeAllocation,
  buildPreviewText,
  getForBale,
  resolveFxRate,
  listProvisional,
  submitForApproval,
  applyApproved,
  cancelPending,
  _internals: { fmt, escapeMd },
};
