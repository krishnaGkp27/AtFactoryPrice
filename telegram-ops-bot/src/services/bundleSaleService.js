'use strict';

/**
 * bundleSaleService — pure-ish helpers powering the Kano bundle/than
 * sale flow (BUNDLE-SALE C1).
 *
 *   • Cart model: a flat array of than-level picks identified by
 *     baleUid+thanNo. Same shape regardless of whether the user tapped
 *     individual thans, "Take ALL of this bale", or used Smart-Pack.
 *
 *   • Smart-Pack: given a target yardage and a list of available bales
 *     (one shade), return the set of thans that gets closest to the
 *     target. Greedy FIFO-first heuristic — good enough for textiles
 *     where bundle sizes are uniform-ish (25 yd ± 1).
 *
 *   • Conflict check: at submit time, re-resolve the cart against the
 *     LIVE inventory and surface anything that's been sold/moved
 *     between cart-building and submission.
 *
 *   • Approval payload: build the {action: 'sale_bundle', items, ...}
 *     JSON that inventoryService.executeApprovedAction already knows
 *     how to apply. Reusing the existing handler means the approval
 *     UI, audit log, and ledger emission keep working unchanged.
 *
 * Pure: no Telegram, no UI strings, no sheet writes from this module.
 * The flow file talks to the UI; this file talks to inventory + math.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const idGenerator = require('../utils/idGenerator');

function upper(v) { return (v || '').toString().toUpperCase().trim(); }
function num(v) { return parseFloat(v) || 0; }

/* ──────────────────────────────────────────────────────────────────── */
/*  Cart model                                                          */
/* ──────────────────────────────────────────────────────────────────── */

/**
 * A cart line is one physical than. The same than can only appear once.
 * Compose a stable key so dedupe is O(1).
 *   key = `${baleUid}|${thanNo}`  when baleUid present
 *   key = `pkg:${packageNo}|${thanNo}` for legacy rows lacking baleUid
 */
function keyOf(line) {
  if (line.baleUid) return `${line.baleUid}|${line.thanNo}`;
  return `pkg:${line.packageNo}|${line.thanNo}`;
}

function emptyCart() {
  return { lines: [], byKey: new Set(), createdAt: new Date().toISOString() };
}

/** Add zero or more than rows to the cart. Returns count actually added. */
function addLines(cart, lines) {
  let added = 0;
  for (const l of lines || []) {
    const k = keyOf(l);
    if (cart.byKey.has(k)) continue;
    cart.byKey.add(k);
    cart.lines.push({
      baleUid: l.baleUid || '',
      packageNo: l.packageNo,
      thanNo: l.thanNo,
      yards: num(l.yards),
      design: l.design || '',
      shade: l.shade || '',
      binLocation: l.binLocation || '',
      _key: k,
    });
    added += 1;
  }
  return added;
}

function removeLines(cart, keys) {
  const drop = new Set(keys);
  const before = cart.lines.length;
  cart.lines = cart.lines.filter((l) => {
    if (drop.has(l._key)) { cart.byKey.delete(l._key); return false; }
    return true;
  });
  return before - cart.lines.length;
}

function removeBale(cart, baleUid) {
  const before = cart.lines.length;
  cart.lines = cart.lines.filter((l) => {
    if (l.baleUid === baleUid) { cart.byKey.delete(l._key); return false; }
    return true;
  });
  return before - cart.lines.length;
}

function clearCart(cart) {
  cart.lines = [];
  cart.byKey = new Set();
}

function totals(cart) {
  let yards = 0, thans = 0;
  const bales = new Set();
  for (const l of cart.lines) { yards += l.yards; thans += 1; bales.add(l.baleUid || `pkg:${l.packageNo}`); }
  return { yards, thans, bales: bales.size };
}

/**
 * Roll up the cart by shade (and within each shade, by bale). Used to
 * render the collapsible cart view. Stable ordering: shade by yards
 * desc, bales within a shade by age (oldest first).
 */
function summarise(cart) {
  const byShade = new Map();
  for (const l of cart.lines) {
    const key = upper(l.shade) || '(NO-SHADE)';
    if (!byShade.has(key)) byShade.set(key, { shade: l.shade, shadeKey: key, yards: 0, thans: 0, bales: new Map() });
    const bucket = byShade.get(key);
    bucket.yards += l.yards;
    bucket.thans += 1;
    const baleKey = l.baleUid || `pkg:${l.packageNo}`;
    if (!bucket.bales.has(baleKey)) bucket.bales.set(baleKey, { baleUid: l.baleUid, packageNo: l.packageNo, binLocation: l.binLocation, thans: [], yards: 0 });
    const baleBucket = bucket.bales.get(baleKey);
    baleBucket.thans.push({ thanNo: l.thanNo, yards: l.yards, key: l._key });
    baleBucket.yards += l.yards;
  }
  const out = Array.from(byShade.values()).map((b) => ({
    shade: b.shade,
    shadeKey: b.shadeKey,
    yards: b.yards,
    thans: b.thans,
    bales: Array.from(b.bales.values()).map((bb) => ({
      ...bb,
      thans: bb.thans.sort((a, b2) => (a.thanNo || 0) - (b2.thanNo || 0)),
    })),
  }));
  out.sort((a, b) => b.yards - a.yards);
  return out;
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Smart-Pack — target-yardage assist                                  */
/* ──────────────────────────────────────────────────────────────────── */

/**
 * Greedy heuristic. Walk available bales oldest-first (FIFO discipline),
 * adding whole thans until the cumulative yardage meets or exceeds the
 * target. Caller passes thans already restricted to one shade & one
 * warehouse + already filtered to status=available.
 *
 *   thans: [{ baleUid, packageNo, thanNo, yards, addedAt, _key }, ...]
 *
 * Returns { picks: [...thans], shortBy } where shortBy >= 0 means we
 * ran out of stock before reaching the target.
 *
 * Heuristic notes:
 *   – We don't backtrack: if a single 25-yd than would push us 5 yd
 *     past target, we still take it. Textile customers generally
 *     accept "a few extra" over "a few short".
 *   – Caller can compare shortBy / overshoot in the UI and offer
 *     "Take fewer thans?" as a manual tweak.
 */
function smartPackForTarget({ targetYards, thans }) {
  const target = num(targetYards);
  if (target <= 0 || !thans || !thans.length) return { picks: [], shortBy: target, overshoot: 0 };
  const ordered = [...thans].sort((a, b) => {
    const ax = Date.parse(a.addedAt || '') || 0;
    const bx = Date.parse(b.addedAt || '') || 0;
    return ax - bx;
  });
  const picks = [];
  let acc = 0;
  for (const t of ordered) {
    if (acc >= target) break;
    picks.push(t);
    acc += num(t.yards);
  }
  return {
    picks,
    pickedYards: acc,
    shortBy: Math.max(0, target - acc),
    overshoot: Math.max(0, acc - target),
  };
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Conflict re-check                                                   */
/* ──────────────────────────────────────────────────────────────────── */

/**
 * Re-fetch live inventory and verify every line in `cart` is still
 * status='available'. Anything that's been marked sold/transferred
 * between cart build and submit is returned as a `dropped[]` array.
 *
 * Returns:
 *   {
 *     ok: boolean,        // true when every line is still valid
 *     stillValid: [...],  // cart lines that survived
 *     dropped: [...],     // {line, reason}
 *   }
 */
async function reconcileWithLive(cart) {
  if (!cart || !cart.lines || !cart.lines.length) return { ok: true, stillValid: [], dropped: [] };
  const live = await inventoryRepository.getAll();
  const byKey = new Map();
  for (const r of live) {
    const k1 = r.baleUid ? `${r.baleUid}|${r.thanNo}` : null;
    const k2 = `pkg:${r.packageNo}|${r.thanNo}`;
    if (k1) byKey.set(k1, r);
    byKey.set(k2, r);
  }
  const stillValid = [];
  const dropped = [];
  for (const l of cart.lines) {
    const row = byKey.get(l._key) || byKey.get(`pkg:${l.packageNo}|${l.thanNo}`);
    if (!row) { dropped.push({ line: l, reason: 'not_found' }); continue; }
    if (row.status !== 'available') { dropped.push({ line: l, reason: row.status || 'unavailable' }); continue; }
    stillValid.push(l);
  }
  return { ok: dropped.length === 0, stillValid, dropped };
}

/* ──────────────────────────────────────────────────────────────────── */
/*  Approval submission                                                 */
/* ──────────────────────────────────────────────────────────────────── */

/**
 * Build the approval-queue payload for the cart. Reuses the existing
 * sale_bundle action so inventoryService.executeApprovedAction does
 * the heavy lifting (markThanSold loop, ledger DR, transactions row).
 *
 * @param {object}  cart
 * @param {object}  sale  — { customer, salesDate, salesPerson, paymentMode, pricePerYard, designSummary }
 * @param {object}  user  — Telegram user that initiated the sale
 */
function buildApprovalPayload(cart, sale, user) {
  const items = cart.lines.map((l) => ({
    type: 'than',
    packageNo: l.packageNo,
    thanNo: l.thanNo,
    baleUid: l.baleUid || '',
    yards: l.yards,
    design: l.design,
    shade: l.shade,
  }));
  return {
    action: 'sale_bundle',
    items,
    customer: sale.customer,
    salesDate: sale.salesDate,
    salesPerson: sale.salesPerson || (user && user.username) || '',
    paymentMode: sale.paymentMode || '',
    pricePerYard: num(sale.pricePerYard),
    bundleFlow: 'BUNDLE-SALE-C1',
    designSummary: sale.designSummary || '',
    warehouse: sale.warehouse || '',
    submittedBy: user && (user.id || user.userId) || '',
    submittedAt: new Date().toISOString(),
  };
}

/**
 * Push the payload through the existing approval pipeline. Caller
 * receives the requestId so it can render the "Pending approval" card
 * and, separately, kick off `approvalEvents.notifyAdminsApprovalRequest`
 * with the bot instance (which this module deliberately doesn't import).
 *
 * `enrichment` is what inventoryService passes to its post-approval
 * handler — it carries pricePerYard + paymentMode + amountPaid so the
 * ledger row gets the correct numbers. Keeping it inside the action
 * JSON ensures it survives a queue replay even if the in-memory
 * enrichment cache is lost.
 */
async function submitForApproval({ cart, sale, user, riskReason }) {
  const payload = buildApprovalPayload(cart, sale, user);
  const requestId = (idGenerator.requestId && idGenerator.requestId()) || `AR-${Date.now()}`;
  const designKey = sale.designSummary || (payload.items[0] && payload.items[0].design) || '';
  const enrichment = {
    ratePerUnitByDesign: designKey ? { [designKey]: num(sale.pricePerYard) } : {},
    paymentMode: sale.paymentMode || '',
    amountPaid: num(sale.amountPaid) || 0,
  };
  const actionJSON = { ...payload, enrichment, requestId };
  await approvalQueueRepository.append({
    requestId,
    user: String((user && (user.id || user.userId)) || ''),
    actionJSON,
    riskReason: riskReason || 'All sale operations require admin approval.',
    status: 'pending',
  });
  try {
    await auditLogRepository.append('approval_queued',
      { requestId, action: 'sale_bundle', flow: 'BUNDLE-SALE-C1', thans: cart.lines.length },
      String((user && (user.id || user.userId)) || 'system'));
  } catch (_) { /* audit failures must never block the sale */ }
  return { requestId, actionJSON };
}

/* ──────────────────────────────────────────────────────────────────── */
/*  UX helpers                                                          */
/* ──────────────────────────────────────────────────────────────────── */

/**
 * Render an "age bucket" emoji + label for a bale based on days since
 * intake. Used in the bundle picker so the manager naturally clears
 * older stock first.
 *   < 30d  → fresh        🟢
 *   30-90  → settled
 *   90-180 → ageing       🟠
 *   180+   → stale        🔴
 */
function ageBucket(ageDays) {
  const d = num(ageDays);
  if (!d || d < 30) return { label: 'fresh', emoji: '🟢' };
  if (d < 90) return { label: 'settled', emoji: '⚪' };
  if (d < 180) return { label: 'ageing', emoji: '🟠' };
  return { label: 'stale', emoji: '🔴' };
}

module.exports = {
  keyOf,
  emptyCart,
  addLines,
  removeLines,
  removeBale,
  clearCart,
  totals,
  summarise,
  smartPackForTarget,
  reconcileWithLive,
  buildApprovalPayload,
  submitForApproval,
  ageBucket,
};
