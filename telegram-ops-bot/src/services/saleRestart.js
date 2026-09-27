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
 * The owner's ruling: those thans are PUT BACK (one write, BaleMovements
 * kind `restart` — neither a customer return nor a §6d correction, so no
 * ledger reads it as goods coming back or a sale being erased) and the
 * whole request is then sold AFRESH by the one batched sale write, so the
 * sale is one clean pass: every row at today's rate, the books written once.
 *
 * One question, answered here for every surface: **is this row's stock
 * gone because THIS sale already took it?** A row is *this sale's own* when
 * it is sold, on the request's sale date, to the request's customer under
 * any spelling that customer is registered with (canonical name or alias).
 * Judged per ROW, the way the sale writer resolves rows, so a bale carrying
 * a than sold to someone else months ago still restarts its own thans.
 *
 * The executor's guards (all fail-CLOSED — a record that cannot be read
 * means nothing is written), decided here:
 *   - the request's own SALE books (its Transactions row, a ledger entry
 *     `<id>-<design>`, its invoice) → the earlier run reached the books:
 *     nothing is put back or sold; the executor closes it and writes only
 *     the book rows that are missing, keyed to the request;
 *   - a row another PENDING sale of the same customer and day covers →
 *     BLOCKED until that request is decided (the message says which one
 *     carries the books, or that the two are twins);
 *   - a row an APPROVED one covers — or a REJECTED one whose sale books
 *     exist — is that sale's: left sold, the item refused as a duplicate;
 *   - a sale undone by an approved `revert_sale_bundle` claims nothing;
 *   - rows of the request's items sold on its date to SOMEONE ELSE that no
 *     request explains are STRANDED (the customer was changed on a re-run):
 *     refused, never left sold and unbooked behind an approved request.
 */

const { normalizeSalesDate } = require('../utils/dates');

const str = (v) => (v == null ? '' : v).toString().trim();
const upper = (v) => str(v).toUpperCase();
const lower = (v) => str(v).toLowerCase();
const num = (v) => parseFloat(v) || 0;

/** The sale actions whose queue rows can claim a bale or than. */
const SALE_ACTIONS = ['sale_bundle', 'sell_package', 'sell_than'];

/**
 * One ISO day for every spelling the doors and the sheet store
 * (`25/09/2026`, `25.09.2026`, `25-Sep-2026`, ISO). '' when unreadable. A
 * relative word (`today`, `yesterday`) is unreadable here: it names a
 * different day every day, so it can neither own a row nor clear a claim.
 * No `Date.parse` fallback — it shifts a day under a non-UTC server clock.
 */
function dayOf(v) {
  const s = str(v);
  if (!s || /^(today|yesterday|tomorrow)$/i.test(s)) return '';
  const iso = normalizeSalesDate(s) || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : '';
}

/** A spelling set: the lower-cased names a customer's history may be filed under. */
function nameSet(names) {
  return new Set((names || []).map(lower).filter(Boolean));
}

/**
 * Every spelling of the request's customer (canonical + aliases, CUS-2),
 * plus the name as typed. Throws when the Customers read fails.
 * @returns {Promise<Set<string>>}
 */
async function spellingsOf(customer) {
  const names = nameSet([customer]);
  if (!names.size) return names;
  const entity = require('./customerEntity');
  const row = await entity.resolve({ name: customer });
  if (row) entity.namesFor(row).forEach((n) => names.add(lower(n)));
  return names;
}

const namesOf = (aj, names) => (names instanceof Set ? names : nameSet([aj && aj.customer]));

/** True when the row is sold on the request's sale date to one of the customer's spellings. */
function rowSoldForThisSale(row, aj, names) {
  const day = dayOf(aj && aj.salesDate);
  return Boolean(row) && row.status === 'sold' && Boolean(day)
    && namesOf(aj, names).has(lower(row.soldTo))
    && dayOf(row.soldDate) === day;
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
function ownRows(item, aj, inventoryRows, names) {
  return itemRows(item, aj, inventoryRows).filter((r) => rowSoldForThisSale(r, aj, names));
}

function hasOwnRows(item, aj, inventoryRows, names) {
  return ownRows(item, aj, inventoryRows, names).length > 0;
}

const rowKey = (r) => (r && r.rowIndex ? `#${r.rowIndex}` : `${upper(r.packageNo)}|${num(r.thanNo)}|${upper(r.warehouse)}`);

/**
 * Every item of the request that has rows of its own earlier run. A row is
 * claimed by the FIRST item that names it (as the writer's `taken` guard
 * does), so a request naming a bale whole AND one of its thans never counts
 * or puts back one physical row twice.
 * @returns {Array<{item:object, rows:Array<object>}>}
 */
function ownRowsByItem(aj, inventoryRows, names) {
  const taken = new Set();
  const out = [];
  for (const item of itemsOf(aj)) {
    const rows = ownRows(item, aj, inventoryRows, names).filter((r) => !taken.has(rowKey(r)));
    rows.forEach((r) => taken.add(rowKey(r)));
    if (rows.length) out.push({ item, rows });
  }
  return out;
}

/**
 * Rows of the request's items sold ON its sale date to a name that is not
 * the request's customer — candidates for "stranded by a customer change".
 * @returns {Array<object>}
 */
function foreignSameDayRows(aj, inventoryRows, names) {
  const day = dayOf(aj && aj.salesDate);
  if (!day) return [];
  const set = namesOf(aj, names);
  const taken = new Set();
  const out = [];
  for (const item of itemsOf(aj)) {
    for (const r of itemRows(item, aj, inventoryRows)) {
      if (taken.has(rowKey(r))) continue;
      taken.add(rowKey(r));
      if (r.status === 'sold' && dayOf(r.soldDate) === day && !set.has(lower(r.soldTo))) out.push(r);
    }
  }
  return out;
}

const statusOf = (r) => lower(r && r.status);

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
 * True when queue row `r` — another request — claims `row`.
 *
 * `ctx.kind`:
 *   - 'pending'  a PENDING sale of the same customer;
 *   - 'booked'   an APPROVED sale of the same customer (not reverted), or a
 *                REJECTED one whose sale books exist (it sold and booked
 *                the row before it was rejected — BUSINESS_RULES §11: a
 *                booked sale is never re-sold under another request);
 *   - 'any'      any sale request, any customer, any status but a plain
 *                rejected one — used only to explain a foreign row.
 * The same (or an unreadable) sale day is required: only a readable,
 * DIFFERENT day clears a claim — a doubtful claim is treated as a claim.
 *
 * @param {object} r        queue row {requestId, status, actionJSON}
 * @param {object} row      the Inventory row
 * @param {object} ctx      {requestId, day, names:Set, reverted:Set, hasSaleBooks:(id)=>boolean, kind}
 */
function claimsRow(r, row, ctx) {
  if (!r || String(r.requestId) === String(ctx.requestId)) return false;
  const oj = r.actionJSON || {};
  if (!SALE_ACTIONS.includes(oj.action)) return false;
  const st = statusOf(r);
  const booked = (st === 'approved' && !ctx.reverted.has(String(r.requestId)))
    || (st === 'rejected' && ctx.hasSaleBooks(String(r.requestId)));
  if (ctx.kind === 'pending' && st !== 'pending') return false;
  if (ctx.kind === 'booked' && !booked) return false;
  if (ctx.kind === 'any' && st !== 'pending' && !booked) return false;
  if (ctx.kind !== 'any' && !ctx.names.has(lower(oj.customer))) return false;
  const od = dayOf(oj.salesDate);
  if (od && od !== ctx.day) return false;
  return itemsOf(oj).some((o) => coversRow(o, oj, row));
}

/**
 * Decide, row by row, what the restart does with this sale's own rows.
 * @param {object} p
 * @param {object} p.aj
 * @param {string} p.requestId
 * @param {Array<{item:object, rows:Array<object>}>} p.own   ownRowsByItem()
 * @param {Array<object>} p.foreign  foreignSameDayRows()
 * @param {Array<object>} p.resolved approvalQueueRepository.getResolved()
 * @param {Array<object>} p.pending  approvalQueueRepository.getAllPending()
 * @param {Set<string>} p.names      spellingsOf(aj.customer)
 * @param {(id:string)=>boolean} [p.hasSaleBooks]  from readBooks()
 * @returns {{
 *   items: Array<{item:object, rows:Array<object>, revert:Array<object>, duplicate:Array<{row:object, otherRequestId:string}>}>,
 *   revert: Array<object>,
 *   duplicates: Array<{row:object, otherRequestId:string}>,
 *   blockedBy: Array<{row:object, otherRequestId:string, otherBooked:boolean}>,
 *   stranded: Array<object>,
 * }}
 */
function planRestart({ aj, requestId, own, foreign, resolved, pending, names, hasSaleBooks = () => false }) {
  const ctx = {
    requestId, day: dayOf(aj.salesDate), names: namesOf(aj, names),
    reverted: revertedSaleIds(resolved), hasSaleBooks,
  };
  const queue = [...(pending || []), ...(resolved || [])];
  const find = (row, kind) => queue.find((r) => claimsRow(r, row, { ...ctx, kind }));
  const items = []; const revert = []; const duplicates = []; const blockedBy = [];
  for (const { item, rows } of own || []) {
    const entry = { item, rows, revert: [], duplicate: [] };
    for (const row of rows) {
      const pend = find(row, 'pending');
      if (pend) { blockedBy.push({ row, otherRequestId: String(pend.requestId), otherBooked: hasSaleBooks(String(pend.requestId)) }); continue; }
      const done = find(row, 'booked');
      if (done) {
        const d = { row, otherRequestId: String(done.requestId) };
        entry.duplicate.push(d); duplicates.push(d);
        continue;
      }
      entry.revert.push(row); revert.push(row);
    }
    items.push(entry);
  }
  const stranded = (foreign || []).filter((row) => !find(row, 'any'));
  return { items, revert, duplicates, blockedBy, stranded };
}

/**
 * Read the book records ONCE and index them by request id: Transactions
 * rows (column O), ledger entries whose txn id starts `<id>-` (the sale
 * debits `<id>-<design>` and, since QTA-2, the payment pair `<id>-PAY`) and
 * invoices. Throws when a read fails — the caller must then write nothing.
 */
async function readBooks() {
  const [transactions, ledger, invoices] = await Promise.all([
    require('../repositories/transactionsRepository').getAll(),
    require('../repositories/ledgerRepository').getAll(),
    require('../repositories/invoicesRepository').getAll(),
  ]);
  const forRequest = (id) => {
    const ref = str(id);
    if (!ref) return { transactions: [], ledgerSale: [], ledgerPay: [], invoice: null, sale: false };
    const prefix = `${ref}-`;
    const tx = transactions.filter((t) => str(t.saleRefId) === ref && /^(sell|sale)/i.test(str(t.action)));
    const led = ledger.filter((e) => str(e.txn_id).startsWith(prefix));
    const ledgerPay = led.filter((e) => str(e.txn_id) === `${ref}-PAY`);
    const ledgerSale = led.filter((e) => str(e.txn_id) !== `${ref}-PAY`);
    const invoice = invoices.find((v) => str(v.requestId) === ref) || null;
    return { transactions: tx, ledgerSale, ledgerPay, invoice, sale: tx.length > 0 || ledgerSale.length > 0 || Boolean(invoice) };
  };
  return { forRequest, hasSaleBooks: (id) => forRequest(id).sale };
}

module.exports = {
  SALE_ACTIONS,
  dayOf,
  nameSet,
  spellingsOf,
  rowSoldForThisSale,
  itemsOf,
  itemRows,
  ownRows,
  hasOwnRows,
  ownRowsByItem,
  foreignSameDayRows,
  revertedSaleIds,
  coversRow,
  claimsRow,
  planRestart,
  readBooks,
};
