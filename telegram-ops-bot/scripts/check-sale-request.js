#!/usr/bin/env node
'use strict';

/**
 * QTA-1 — what did an approved sale request actually leave behind?
 *
 * Written for the 24-Sep-2026 incident: an approval hit Google's Sheets
 * write cap halfway ("Quota exceeded for quota metric 'Write requests'"),
 * and with the old per-item writes that could leave SOME thans flipped to
 * sold with no Transactions row, no ledger debit and no invoice behind
 * them. This prints, for one request id, every trace the sale should have
 * left so the owner can see at a glance whether it is whole, half-done or
 * untouched:
 *
 *   1. the ApprovalQueue row (status, who decided, the items requested);
 *   2. each requested item's Inventory rows today (status, sold to, sold
 *      date) — flipped or not, judged PER ITEM (a bale item is flipped only
 *      when every than of it is);
 *   3. the Transactions row carrying this SaleRefId — and, when there is
 *      none, any Transactions row for the same customer on the same day
 *      under ANOTHER request (a duplicate request, not a half-done one);
 *   4. the Ledger entries whose txn id starts with this request id;
 *   5. the Invoices row for this request.
 *
 * READ-ONLY. Writes nothing to any sheet. Usage:
 *   node scripts/check-sale-request.js R-9BF6        # the card's short ref
 *   node scripts/check-sale-request.js <full request uuid>
 */

const path = require('path');

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();
const day = (v) => String(v || '').slice(0, 10);

/**
 * The card mints its ref from the FIRST four alphanumerics of the id
 * (approvalCards.shortRequestRef); accept that, the full id, or the id
 * with dashes stripped.
 */
function matchesRef(requestId, ref) {
  const id = String(requestId || '');
  const cleanId = upper(id).replace(/[^A-Z0-9]/g, '');
  const cleanRef = upper(ref).replace(/^R-/, '').replace(/[^A-Z0-9]/g, '');
  if (!cleanRef) return false;
  if (upper(id) === upper(ref) || cleanId === cleanRef) return true;
  return cleanRef.length === 4 && cleanId.startsWith(cleanRef);
}

/**
 * Pure: judge one request from what the sheets hold.
 * @param {object} p
 * @param {object} p.queue       the ApprovalQueue row ({status, actionJSON})
 * @param {Array<object>} p.inventory   every Inventory row
 * @param {Array<object>} p.txns        Transactions rows (any field spelling)
 * @param {Array<object>} p.ledger      Ledger entries ({txn_id})
 * @returns {{items:Array<object>, flippedItems:number, untouchedItems:number, mixedItems:number,
 *   txnsForRequest:Array<object>, txnsSameDay:Array<object>, ledgerForRequest:Array<object>, verdict:string, reading:string}}
 */
function judge({ queue, inventory, txns, ledger }) {
  const aj = (queue && queue.actionJSON) || {};
  const requestId = String((queue && queue.requestId) || '');
  // QTA-2 — one item shape for every sale door (a single-door request is
  // its one bale or than), so the checker can judge them too.
  const items = require('../src/services/saleRestart').itemsOf(aj);
  const custKey = upper(aj.customer);
  const saleDay = day(aj.salesDate);
  const soldHere = (r) => r.status === 'sold' && upper(r.soldTo) === custKey && day(r.soldDate) === saleDay;

  const judged = items.map((it) => {
    const wh = it.warehouse || aj.warehouse || '';
    const mine = (inventory || []).filter((r) => String(r.packageNo) === String(it.packageNo)
      && (!wh || upper(r.warehouse) === upper(wh))
      && (it.type !== 'than' || Number(r.thanNo) === Number(it.thanNo)));
    const here = mine.filter(soldHere).length;
    const avail = mine.filter((r) => r.status === 'available').length;
    let state;
    if (!mine.length) state = 'not found';
    else if (here === mine.length) state = 'flipped';
    else if (here === 0 && avail === mine.length) state = 'untouched';
    else if (here === 0) state = 'sold elsewhere';
    else state = 'mixed';
    return { item: it, rows: mine, state };
  });
  const flippedItems = judged.filter((j) => j.state === 'flipped').length;
  const untouchedItems = judged.filter((j) => j.state === 'untouched').length;
  const mixedItems = judged.filter((j) => j.state === 'mixed').length;
  const elsewhereItems = judged.filter((j) => j.state === 'sold elsewhere').length;

  const refOf = (x) => String(x.saleRefId || x.SaleRefId || '');
  const txnsForRequest = (txns || []).filter((x) => refOf(x) === requestId);
  const txnsSameDay = (txns || []).filter((x) => refOf(x) !== requestId
    && upper(x.customerName || x.CustomerName) === custKey && day(x.salesDate || x.SalesDate) === saleDay
    && /sale|sell/i.test(String(x.action || x.Action || '')));
  const ledgerForRequest = (ledger || []).filter((e) => String(e.txn_id || '').startsWith(requestId));

  const booked = txnsForRequest.length > 0 && ledgerForRequest.length > 0;
  let verdict; let reading;
  if (!items.length) {
    verdict = 'NO ITEMS'; reading = 'The request carries no items — nothing to judge.';
  } else if (flippedItems === items.length && booked) {
    verdict = 'WHOLE'; reading = `Every item flipped to ${aj.customer} on ${saleDay}; Transactions and ledger posted.`;
  } else if (flippedItems === items.length && !booked && txnsSameDay.length) {
    verdict = 'DUPLICATE?';
    reading = `Every item is sold to ${aj.customer} on ${saleDay}, but the money rows carry OTHER request id(s): ${[...new Set(txnsSameDay.map(refOf))].join(', ')}. This request looks like a duplicate of that sale — reject it; do NOT post its money side.`;
  } else if ((flippedItems || mixedItems) && !booked) {
    verdict = 'HALF-DONE';
    // QTA-2 — a BUNDLE's next Approve restarts it: the flipped thans are put
    // back and the whole request is sold afresh, the books written once.
    // The single doors have no restart path: their missing side is posted by hand.
    const next = aj.action === 'sale_bundle'
      ? 'Tap Approve ONCE on this request and walk the wizard: the bot puts the flipped thans back and sells the whole request afresh, writing the books once (QTA-2). If the reply names another request as a duplicate, Reject this one.'
      : 'Do not re-approve; post the missing side with these numbers in front of you.';
    reading = `${flippedItems + mixedItems} item(s) are sold to ${aj.customer} on ${saleDay} but no ${txnsForRequest.length ? 'ledger entry' : 'Transactions row'} carries this request — the goods left stock, the customer was not charged for them. ${next}`;
  } else if (flippedItems === 0 && mixedItems === 0 && untouchedItems === items.length - elsewhereItems && elsewhereItems === 0) {
    verdict = 'UNTOUCHED';
    reading = queue && queue.status === 'approved'
      ? 'Nothing flipped although the row reads approved — it was Marked as done or reverted.'
      : 'Nothing flipped; the request can be approved again as it is.';
  } else {
    verdict = 'MIXED';
    reading = `${flippedItems} flipped · ${untouchedItems} untouched · ${elsewhereItems} sold to someone else / another day · ${mixedItems} part-flipped. Read the item lines before deciding.`;
  }
  return { items: judged, flippedItems, untouchedItems, mixedItems, elsewhereItems, txnsForRequest, txnsSameDay, ledgerForRequest, verdict, reading };
}

async function main(arg) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const approvalQueueRepository = require('../src/repositories/approvalQueueRepository');
  const inventoryRepository = require('../src/repositories/inventoryRepository');
  const transactionsRepository = require('../src/repositories/transactionsRepository');
  const ledgerRepository = require('../src/repositories/ledgerRepository');
  const invoicesRepository = require('../src/repositories/invoicesRepository');

  const rows = await approvalQueueRepository.getAllWithRowIndex();
  const hits = rows.filter((r) => matchesRef(r.requestId, arg));
  if (!hits.length) { console.log(`No ApprovalQueue row matches "${arg}".`); return; }
  if (hits.length > 1) console.log(`⚠️ ${hits.length} rows match "${arg}" — showing each.\n`);

  const inventory = await inventoryRepository.getAll();
  // getLast reads the whole sheet anyway; take all of it so an old sale is found.
  const txns = await transactionsRepository.getLast(Number.MAX_SAFE_INTEGER).catch(() => []);
  const ledger = await ledgerRepository.getAll().catch(() => []);

  for (const q of hits) {
    const aj = q.actionJSON || {};
    const j = judge({ queue: q, inventory, txns, ledger });
    console.log('════════════════════════════════════════════════════════');
    console.log(`Request ${q.requestId}  (sheet row ${q.rowIndex})`);
    console.log(`  status: ${q.status || '(blank)'}   raised by: ${q.user || '?'}   action: ${aj.action || '?'}`);
    console.log(`  customer: ${aj.customer || '?'}   sale date: ${aj.salesDate || '?'}   approver cell: ${q.approver || q.approvedBy || '(blank)'}`);
    console.log(`\n1. Items requested: ${j.items.length}`);
    for (const { item: it, rows: mine, state } of j.items) {
      if (!mine.length) { console.log(`   • ${it.type} ${it.packageNo}${it.type === 'than' ? ` #${it.thanNo}` : ''} — NOT FOUND in Inventory`); continue; }
      console.log(`   • ${it.type} ${it.packageNo}${it.type === 'than' ? ` #${it.thanNo}` : ''} → ${state.toUpperCase()}`);
      for (const r of mine) {
        console.log(`       ${r.packageNo} #${r.thanNo} · ${r.design} · ${r.yards} yds · ${r.warehouse} → ${r.status}${r.status === 'sold' ? ` to ${r.soldTo} on ${r.soldDate}` : ''}`);
      }
    }
    console.log(`   items flipped by this sale: ${j.flippedItems}   untouched: ${j.untouchedItems}   sold elsewhere: ${j.elsewhereItems}   part-flipped: ${j.mixedItems}`);

    console.log(`\n2. Transactions rows with SaleRefId = request: ${j.txnsForRequest.length}`);
    for (const x of j.txnsForRequest) console.log(`   • ${x.timestamp || x.Timestamp || ''} · ${x.action || x.Action} · qty ${x.qty ?? x.Qty} · ${x.customerName || x.CustomerName || ''} · status ${x.status || x.Status || ''}`);
    if (j.txnsSameDay.length) {
      console.log(`   same customer, same day, OTHER request id: ${j.txnsSameDay.length}`);
      for (const x of j.txnsSameDay) console.log(`   • ${x.timestamp || x.Timestamp || ''} · ${x.action || x.Action} · qty ${x.qty ?? x.Qty} · ref ${x.saleRefId || x.SaleRefId}`);
    }

    console.log(`\n3. Ledger entries whose txn id starts with the request id: ${j.ledgerForRequest.length}`);
    for (const e of j.ledgerForRequest) console.log(`   • ${JSON.stringify(e)}`);

    let inv = null;
    try { inv = await invoicesRepository.getByRequestId(q.requestId); } catch (_) { inv = null; }
    console.log(`\n4. Invoice: ${inv ? `${inv.invoiceNo || inv.invoice_no || '(no number)'} · total ${inv.total ?? '?'} · status ${inv.status || '?'}` : 'none'}`);

    console.log(`\nReading: ${j.verdict}`);
    console.log(`  ${j.reading}`);
  }
}

if (require.main === module) {
  const arg = String(process.argv[2] || '').trim();
  if (!arg) {
    console.error('Usage: node scripts/check-sale-request.js <requestId or short ref like R-9BF6>');
    process.exit(2);
  }
  main(arg).catch((e) => { console.error('Failed:', e.message); process.exit(1); });
}

module.exports = { matchesRef, judge };
