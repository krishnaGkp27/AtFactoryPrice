'use strict';

/**
 * saleStockCheck — APF-2: ONE answer to "is this sale request's stock
 * already gone?", shared by every surface that cares (owner's standing
 * anti-duplication order):
 *
 *   - approvalEvents skips the pointless enrichment wizard and offers
 *     Mark-as-done / Reject directly;
 *   - the Approvals Inbox marks such rows ⚠️ on the chip and swaps the
 *     card's buttons for the two real choices;
 *   - Sentinel C8 flags them nightly.
 *
 * "Gone" means: for EVERY item in the request there is no available
 * Inventory row under its printed number (scoped to the item's warehouse
 * when one was stored — pre-TRF-INT4 rows match any store). That is the
 * executed-but-unresolved zombie, or a duplicate of a sale that ran under
 * another request. The bot never guesses which — it only reports.
 */

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** The sale actions this check understands. */
const SALE_ACTIONS = ['sale_bundle', 'sell_package', 'sell_than'];

/** Normalize a sale actionJSON into its item list. */
function itemsOf(aj) {
  if (!aj || !SALE_ACTIONS.includes(aj.action)) return [];
  if (aj.action === 'sale_bundle') return Array.isArray(aj.items) ? aj.items : [];
  return [{ packageNo: aj.packageNo, warehouse: aj.warehouse }];
}

/**
 * True when the request has items and NONE of them has available stock.
 * @param {object} aj the queue row's actionJSON
 * @param {Array<object>} inventoryRows inventoryRepository.getAll() rows
 */
function allItemsGone(aj, inventoryRows) {
  const items = itemsOf(aj);
  if (!items.length) return false;
  const availPkgWh = new Set();
  const availPkg = new Set();
  for (const r of inventoryRows || []) {
    if (r.status !== 'available') continue;
    const p = upper(r.packageNo);
    if (!p) continue;
    availPkg.add(p);
    availPkgWh.add(`${p}|${upper(r.warehouse)}`);
  }
  return items.every((si) => {
    const p = upper(si.packageNo);
    if (!p) return false;
    const wh = upper(si.warehouse || aj.warehouse);
    return wh ? !availPkgWh.has(`${p}|${wh}`) : !availPkg.has(p);
  });
}

module.exports = { itemsOf, allItemsGone, SALE_ACTIONS };
