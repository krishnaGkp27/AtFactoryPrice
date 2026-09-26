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
 *      date) — flipped or not;
 *   3. the Transactions row carrying this SaleRefId;
 *   4. the Ledger entries whose txn id starts with this request id;
 *   5. the Invoices row for this request.
 *
 * READ-ONLY. Writes nothing to any sheet. Usage:
 *   node scripts/check-sale-request.js R-9BF6
 *   node scripts/check-sale-request.js <full request uuid>
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const approvalQueueRepository = require('../src/repositories/approvalQueueRepository');
const inventoryRepository = require('../src/repositories/inventoryRepository');
const transactionsRepository = require('../src/repositories/transactionsRepository');
const ledgerRepository = require('../src/repositories/ledgerRepository');
const invoicesRepository = require('../src/repositories/invoicesRepository');

const arg = String(process.argv[2] || '').trim();
if (!arg) {
  console.error('Usage: node scripts/check-sale-request.js <requestId or short ref like R-9BF6>');
  process.exit(2);
}

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** A short ref (R-9BF6) is the last 4 hex chars of the request id. */
function matchesRef(requestId, ref) {
  const id = String(requestId || '');
  const r = upper(ref).replace(/^R-/, '');
  return upper(id) === upper(ref) || (r.length === 4 && upper(id.replace(/-/g, '')).endsWith(r));
}

(async () => {
  const rows = await approvalQueueRepository.getAllWithRowIndex();
  const hits = rows.filter((r) => matchesRef(r.requestId, arg));
  if (!hits.length) { console.log(`No ApprovalQueue row matches "${arg}".`); return; }
  if (hits.length > 1) console.log(`⚠️ ${hits.length} rows match "${arg}" — showing each.\n`);

  const inventory = await inventoryRepository.getAll();
  const txns = await transactionsRepository.getLast(2000).catch(() => []);
  const ledger = await ledgerRepository.getAll().catch(() => []);

  for (const q of hits) {
    const aj = q.actionJSON || {};
    console.log('════════════════════════════════════════════════════════');
    console.log(`Request ${q.requestId}  (sheet row ${q.rowIndex})`);
    console.log(`  status: ${q.status || '(blank)'}   raised by: ${q.user || '?'}   action: ${aj.action || '?'}`);
    console.log(`  customer: ${aj.customer || '?'}   sale date: ${aj.salesDate || '?'}   approver cell: ${q.approver || q.approvedBy || '(blank)'}`);
    const items = Array.isArray(aj.items) ? aj.items : [];
    console.log(`\n1. Items requested: ${items.length}`);
    let flipped = 0; let notFlipped = 0;
    for (const it of items) {
      const wh = it.warehouse || aj.warehouse || '';
      const mine = inventory.filter((r) => String(r.packageNo) === String(it.packageNo)
        && (!wh || upper(r.warehouse) === upper(wh))
        && (it.type !== 'than' || Number(r.thanNo) === Number(it.thanNo)));
      if (!mine.length) { console.log(`   • ${it.type} ${it.packageNo}${it.type === 'than' ? ` #${it.thanNo}` : ''} — NOT FOUND in Inventory`); continue; }
      for (const r of mine) {
        const soldHere = r.status === 'sold' && upper(r.soldTo) === upper(aj.customer) && String(r.soldDate || '').slice(0, 10) === String(aj.salesDate || '').slice(0, 10);
        if (soldHere) flipped += 1; else if (r.status === 'available') notFlipped += 1;
        console.log(`   • ${it.type} ${r.packageNo} #${r.thanNo} · ${r.design} · ${r.yards} yds · ${r.warehouse} → ${r.status}${r.status === 'sold' ? ` to ${r.soldTo} on ${r.soldDate}` : ''}${soldHere ? '   ✅ this sale' : ''}`);
      }
    }
    console.log(`   flipped by this sale: ${flipped}   still available: ${notFlipped}`);

    const t = txns.filter((x) => String(x.saleRefId || x.SaleRefId || '') === String(q.requestId));
    console.log(`\n2. Transactions rows with SaleRefId = request: ${t.length}`);
    for (const x of t) console.log(`   • ${x.timestamp || x.Timestamp || ''} · ${x.action || x.Action} · qty ${x.qty ?? x.Qty} · ${x.customerName || x.CustomerName || ''} · status ${x.status || x.Status || ''}`);

    const l = ledger.filter((e) => String(e.txn_id || '').startsWith(String(q.requestId)));
    console.log(`\n3. Ledger entries whose txn id starts with the request id: ${l.length}`);
    for (const e of l) console.log(`   • ${JSON.stringify(e)}`);

    let inv = null;
    try { inv = await invoicesRepository.getByRequestId(q.requestId); } catch (_) { inv = null; }
    console.log(`\n4. Invoice: ${inv ? `${inv.invoiceNo || inv.invoice_no || '(no number)'} · total ${inv.total ?? '?'} · status ${inv.status || '?'}` : 'none'}`);

    console.log('\nReading:');
    if (q.status === 'approved' && flipped === items.length && t.length && l.length) {
      console.log('  ✅ Whole: every item flipped, Transactions + ledger posted.');
    } else if (flipped && (!t.length || !l.length)) {
      console.log(`  ⚠️ HALF-DONE: ${flipped} item(s) are sold to this customer on this date but no ${!t.length ? 'Transactions row' : 'ledger entry'} carries the request — the money side is missing for them.`);
    } else if (!flipped && q.status !== 'approved') {
      console.log('  ⏳ Untouched: nothing flipped; the request can be approved again as it is.');
    } else {
      console.log('  ❔ Mixed — read the lines above; Mark-as-done / re-approve only after checking the ledger.');
    }
  }
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
