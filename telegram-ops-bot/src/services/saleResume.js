'use strict';

/**
 * saleResume — QTA-2 (owner go 27-Sep-2026): FINISH a sale whose earlier
 * run flipped some thans and then died before the books were written.
 *
 * The 24-Sep incident: R-9BF6 flipped 27 of 33 thans to Ayubal Ansari on
 * 25-Sep-2026 and was refused by Google's write cap before the Transactions
 * row, the ledger debit and the invoice. The request stayed pending. A
 * plain re-approve would have sold only the 6 remaining thans and charged
 * him for 180 of 990 yards.
 *
 * One question, answered here for every surface: **is this item's stock
 * gone because THIS sale already took it?** A row is "this sale's" when
 * it is sold to the request's customer on the request's sale date. Such
 * an item is RESUMED — counted, not sold again, and never charged twice —
 * unless another APPROVED request for the same customer on the same day
 * covers the same bale or than: then it is a DUPLICATE and refused, as
 * before. The bot never guesses between the two; with the resolved queue
 * unreadable nothing is resumed.
 */

const { normDay } = require('../utils/dates');

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** The sale actions whose approved rows can claim a bale or than. */
const SALE_ACTIONS = ['sale_bundle', 'sell_package', 'sell_than'];

function sameCustomer(a, b) {
  const x = upper(a);
  return Boolean(x) && x === upper(b);
}

function sameDay(a, b) {
  const x = normDay(a);
  return Boolean(x) && x === normDay(b);
}

/** True when the row is sold to the request's customer on the request's sale date. */
function rowSoldForThisSale(row, aj) {
  return Boolean(row) && row.status === 'sold'
    && sameCustomer(row.soldTo, aj && aj.customer)
    && sameDay(row.soldDate, aj && aj.salesDate);
}

/** True when there are rows and every one of them is this sale's. */
function rowsSoldForThisSale(rows, aj) {
  return Array.isArray(rows) && rows.length > 0 && rows.every((r) => rowSoldForThisSale(r, aj));
}

/** The item list of a sale actionJSON, one shape for every door. */
function itemsOf(aj) {
  if (!aj || !SALE_ACTIONS.includes(aj.action)) return [];
  if (aj.action === 'sale_bundle') return Array.isArray(aj.items) ? aj.items : [];
  return [{
    type: aj.action === 'sell_than' ? 'than' : 'package',
    packageNo: aj.packageNo, thanNo: aj.thanNo, warehouse: aj.warehouse,
  }];
}

/** The Inventory rows an item names (bale in its warehouse; one than for a than item). */
function itemRows(item, aj, inventoryRows) {
  const p = upper(item && item.packageNo);
  if (!p) return [];
  const wh = upper((item && item.warehouse) || (aj && aj.warehouse));
  return (inventoryRows || []).filter((r) => upper(r.packageNo) === p
    && (!wh || upper(r.warehouse) === wh)
    && (item.type !== 'than' || Number(r.thanNo) === Number(item.thanNo)));
}

/** True when the item's stock is gone BECAUSE this sale already took it. */
function isResumableItem(item, aj, inventoryRows) {
  return rowsSoldForThisSale(itemRows(item, aj, inventoryRows), aj);
}

/** The items of a request whose stock this same sale already took. */
function resumableItems(aj, inventoryRows) {
  return itemsOf(aj).filter((it) => isResumableItem(it, aj, inventoryRows));
}

/** True when another item (of another request) covers this item's bale or than. */
function covers(other, item) {
  if (upper(other.packageNo) !== upper(item.packageNo)) return false;
  if (other.type === 'than' && item.type === 'than') return Number(other.thanNo) === Number(item.thanNo);
  return true; // a whole-bale item covers every than of it; a than item covers the bale's claim
}

const isApproved = (r) => String((r && r.status) || '').toLowerCase() === 'approved';

/**
 * The sales undone by an APPROVED `revert_sale_bundle` (the original row
 * keeps status=approved — RATE-1 reads them the same way). A reverted sale
 * claims nothing.
 * @returns {Set<string>} the reverted requests' ids
 */
function revertedSaleIds(resolved) {
  return new Set((resolved || [])
    .filter((r) => isApproved(r) && (r.actionJSON || {}).action === 'revert_sale_bundle' && (r.actionJSON || {}).saleRefId)
    .map((r) => String(r.actionJSON.saleRefId)));
}

/**
 * The APPROVED request, other than this one, for the same customer on the
 * same day whose items cover this item — the duplicate, when there is one.
 * @param {Set<string>} [reverted]  revertedSaleIds(resolved), computed once by the caller
 * @returns {string|null} that request's id
 */
function otherRequestCovering(item, aj, requestId, resolved, reverted = revertedSaleIds(resolved)) {
  for (const r of resolved || []) {
    if (!r || String(r.requestId) === String(requestId)) continue;
    if (!isApproved(r) || reverted.has(String(r.requestId))) continue;
    const oj = r.actionJSON || {};
    if (!SALE_ACTIONS.includes(oj.action)) continue;
    if (!sameCustomer(oj.customer, aj.customer) || !sameDay(oj.salesDate, aj.salesDate)) continue;
    if (itemsOf(oj).some((o) => covers(o, item))) return String(r.requestId);
  }
  return null;
}

/**
 * Classify the items the batched writer could not sell.
 * @param {object} p
 * @param {Array<{item:object, reason:string, rows?:Array<object>}>} p.failed  from markItemsSold
 * @param {object} p.aj
 * @param {string} p.requestId
 * @param {Array<object>|null} p.resolved  approvalQueueRepository.getResolved(); null = unreadable → nothing resumes
 * @returns {Array<{entry:object, kind:'resumed'|'duplicate'|'failed', rows:Array<object>, otherRequestId:string|null}>}
 */
function classifyFailed({ failed, aj, requestId, resolved }) {
  const reverted = revertedSaleIds(resolved);
  return (failed || []).map((entry) => {
    const rows = Array.isArray(entry.rows) ? entry.rows : [];
    if (!Array.isArray(resolved) || !rowsSoldForThisSale(rows, aj)) {
      return { entry, kind: 'failed', rows, otherRequestId: null };
    }
    const other = otherRequestCovering(entry.item || {}, aj, requestId, resolved, reverted);
    if (other) return { entry, kind: 'duplicate', rows, otherRequestId: other };
    return { entry, kind: 'resumed', rows, otherRequestId: null };
  });
}

module.exports = {
  SALE_ACTIONS,
  sameCustomer,
  sameDay,
  rowSoldForThisSale,
  rowsSoldForThisSale,
  itemsOf,
  itemRows,
  isResumableItem,
  resumableItems,
  revertedSaleIds,
  otherRequestCovering,
  classifyFailed,
};
