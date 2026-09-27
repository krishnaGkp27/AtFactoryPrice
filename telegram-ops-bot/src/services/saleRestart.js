'use strict';

/**
 * saleRestart — QTA-2 (owner, 27-Sep-2026: "it should revert and restart for
 * complete sale"): FINISH a bundle sale whose earlier run flipped some thans
 * and then died before the books were written.
 *
 * The 24/25-Sep incident: R-9BF6 flipped 27 of 33 thans to Ayubal Ansari on
 * 25-Sep-2026 and was refused by Google's write cap before the Transactions
 * row, the ledger debit and the invoice. The request stayed pending. A
 * plain re-approve would have sold only the 6 remaining thans and charged
 * him for 180 of 990 yards.
 *
 * The owner's ruling: those thans are PUT BACK (one write, logged as an
 * admin correction — never a customer return, RET-2) and the whole request
 * is then sold AFRESH by the one batched sale write, so the sale is one
 * clean pass: every row at today's rate, one movement row per bale, the
 * books written once.
 *
 * One question, answered here for every surface: **is this row's stock
 * gone because THIS sale already took it?** A row is *this sale's own* when
 * it is sold to the request's customer on the request's sale date. Judged
 * per ROW, so a bale carrying a than sold to someone else months ago still
 * restarts its own thans.
 *
 * Guards (the executor applies them, all fail-CLOSED — a record that cannot
 * be read means nothing is written):
 *   - a row another PENDING sale request of the same customer and day
 *     covers BLOCKS the restart until that request is decided;
 *   - a row another APPROVED one covers is that sale's — left sold and the
 *     item refused as a duplicate, never sold or charged twice;
 *   - a sale undone by an approved `revert_sale_bundle` claims nothing;
 *   - when ANY book row already carries the request, the earlier run reached
 *     the books: nothing is put back, sold or booked again.
 */

const { normalizeSalesDate, normDay } = require('../utils/dates');

const str = (v) => (v == null ? '' : v).toString().trim();
const upper = (v) => str(v).toUpperCase();
const num = (v) => parseFloat(v) || 0;

/** The sale actions whose queue rows can claim a bale or than. */
const SALE_ACTIONS = ['sale_bundle', 'sell_package', 'sell_than'];

/**
 * One ISO day for every spelling the doors store (`yesterday`, `25.09.2026`,
 * `25/09/2026`, `25-Sep-2026`, ISO). '' when unreadable — normDay hands an
 * unreadable string back unchanged, which must never pass as a day.
 */
function dayOf(v) {
  const s = str(v);
  if (!s) return '';
  const iso = normalizeSalesDate(s) || normDay(s) || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

function sameCustomer(a, b) {
  const x = upper(a);
  return Boolean(x) && x === upper(b);
}

function sameDay(a, b) {
  const x = dayOf(a);
  return Boolean(x) && x === dayOf(b);
}

/** True when the row is sold to the request's customer on the request's sale date. */
function rowSoldForThisSale(row, aj) {
  return Boolean(row) && row.status === 'sold'
    && sameCustomer(row.soldTo, aj && aj.customer)
    && sameDay(row.soldDate, aj && aj.salesDate);
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

/**
 * The Inventory rows an item names — resolved the way `markItemsSold`
 * resolves them, so what is judged here is what the writer will touch: a
 * package = every row of that number in the item's store (falling back to
 * the bundle's); a than = the ONE row its baleUid pins, else the first
 * number+than(+store) match.
 */
function itemRows(item, aj, inventoryRows) {
  const p = str(item && item.packageNo);
  if (!p) return [];
  const wh = upper((item && item.warehouse) || (aj && aj.warehouse));
  const inWh = (r) => !wh || upper(r.warehouse) === wh;
  const all = inventoryRows || [];
  if (item.type === 'than') {
    const t = num(item.thanNo);
    const uid = item.baleUid ? str(item.baleUid) : null;
    const same = (x) => str(x.packageNo) === p && num(x.thanNo) === t && inWh(x);
    const r = (uid && all.find((x) => same(x) && str(x.baleUid) === uid)) || all.find(same);
    return r ? [r] : [];
  }
  if (item.type === 'package') return all.filter((r) => str(r.packageNo) === p && inWh(r));
  return [];
}

/** The item's rows that this sale's earlier run flipped. */
function ownRows(item, aj, inventoryRows) {
  return itemRows(item, aj, inventoryRows).filter((r) => rowSoldForThisSale(r, aj));
}

function hasOwnRows(item, aj, inventoryRows) {
  return ownRows(item, aj, inventoryRows).length > 0;
}

/**
 * Every item of the request that has rows of its own earlier run.
 * @returns {Array<{item:object, rows:Array<object>}>}
 */
function ownRowsByItem(aj, inventoryRows) {
  return itemsOf(aj)
    .map((item) => ({ item, rows: ownRows(item, aj, inventoryRows) }))
    .filter((x) => x.rows.length > 0);
}

const statusOf = (r) => String((r && r.status) || '').toLowerCase();

/**
 * The sales undone by an APPROVED `revert_sale_bundle` (the original row
 * keeps status=approved — RATE-1 reads them the same way).
 * @returns {Set<string>} the reverted requests' ids
 */
function revertedSaleIds(resolved) {
  return new Set((resolved || [])
    .filter((r) => statusOf(r) === 'approved' && (r.actionJSON || {}).action === 'revert_sale_bundle' && (r.actionJSON || {}).saleRefId)
    .map((r) => String(r.actionJSON.saleRefId)));
}

/** True when another request's item covers this ROW (bale + than, in that store). */
function coversRow(other, oj, row) {
  if (str(other.packageNo) !== str(row.packageNo)) return false;
  const wh = upper(other.warehouse || (oj && oj.warehouse));
  if (wh && upper(row.warehouse) !== wh) return false;
  if (other.type === 'than') return num(other.thanNo) === num(row.thanNo);
  return true; // a whole-bale item covers every than of the bale
}

/**
 * True when queue row `r` (status `want`, another request) is a sale of the
 * same customer that covers `row`. A date the other request spelled
 * unreadably cannot clear it — only a readable, DIFFERENT day does (the
 * safe direction: a doubtful claim is treated as a claim).
 */
function claimsRow(r, row, aj, requestId, reverted, want) {
  if (!r || String(r.requestId) === String(requestId)) return false;
  if (statusOf(r) !== want) return false;
  if (want === 'approved' && reverted.has(String(r.requestId))) return false;
  const oj = r.actionJSON || {};
  if (!SALE_ACTIONS.includes(oj.action)) return false;
  if (!sameCustomer(oj.customer, aj.customer)) return false;
  const od = dayOf(oj.salesDate);
  if (od && od !== dayOf(aj.salesDate)) return false;
  return itemsOf(oj).some((o) => coversRow(o, oj, row));
}

/**
 * Decide, row by row, what the restart does with this sale's own rows.
 * @param {object} p
 * @param {object} p.aj
 * @param {string} p.requestId
 * @param {Array<{item:object, rows:Array<object>}>} p.own   ownRowsByItem()
 * @param {Array<object>} p.resolved   approvalQueueRepository.getResolved()
 * @param {Array<object>} p.pending    approvalQueueRepository.getAllPending()
 * @returns {{
 *   items: Array<{item:object, rows:Array<object>, revert:Array<object>, duplicate:Array<{row:object, otherRequestId:string}>}>,
 *   revert: Array<object>,
 *   duplicates: Array<{row:object, otherRequestId:string}>,
 *   blockedBy: Array<{row:object, otherRequestId:string}>,
 * }}
 */
function planRestart({ aj, requestId, own, resolved, pending }) {
  const reverted = revertedSaleIds(resolved);
  const items = []; const revert = []; const duplicates = []; const blockedBy = [];
  for (const { item, rows } of own || []) {
    const entry = { item, rows, revert: [], duplicate: [] };
    for (const row of rows) {
      const pend = (pending || []).find((r) => claimsRow(r, row, aj, requestId, reverted, 'pending'));
      if (pend) { blockedBy.push({ row, otherRequestId: String(pend.requestId) }); continue; }
      const appr = (resolved || []).find((r) => claimsRow(r, row, aj, requestId, reverted, 'approved'));
      if (appr) {
        const d = { row, otherRequestId: String(appr.requestId) };
        entry.duplicate.push(d); duplicates.push(d);
        continue;
      }
      entry.revert.push(row); revert.push(row);
    }
    items.push(entry);
  }
  return { items, revert, duplicates, blockedBy };
}

/**
 * Every book row that already carries this request: the Transactions row
 * (column O), ledger entries whose txn id starts with the request id (the
 * sale debits `<id>-<design>` and, since QTA-2, the payment pair `<id>-PAY`)
 * and the invoice. Any of them means the earlier run reached the books.
 * Throws when a read fails — the caller must then write nothing.
 */
async function booksFor(requestId) {
  const transactions = await require('../repositories/transactionsRepository').findBySaleRef(requestId);
  const prefix = `${requestId}-`;
  const ledger = (await require('../repositories/ledgerRepository').getAll())
    .filter((e) => String(e.txn_id || '').startsWith(prefix));
  const invoice = await require('../repositories/invoicesRepository').getByRequestId(requestId);
  return {
    transactions, ledger, invoice: invoice || null,
    any: transactions.length > 0 || ledger.length > 0 || Boolean(invoice),
  };
}

module.exports = {
  SALE_ACTIONS,
  dayOf,
  sameCustomer,
  sameDay,
  rowSoldForThisSale,
  itemsOf,
  itemRows,
  ownRows,
  hasOwnRows,
  ownRowsByItem,
  revertedSaleIds,
  coversRow,
  claimsRow,
  planRestart,
  booksFor,
};
