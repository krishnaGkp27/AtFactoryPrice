#!/usr/bin/env node
'use strict';

/**
 * RET-3 — list every approved customer return that never credited the buyer.
 *
 * Before RET-3 the approved-return executors posted the ledger event
 * without a rate, so `recordReturn` skipped the row: stock came back, the
 * customer's debt stayed. This script pairs each BaleMovements `return`
 * row with the LedgerTransactions credit that should carry its txn id
 * (`RT-<bale>-<than>` / `RP-<bale>`, and `RN-<bale>-<requestId>` for a RET-4
 * multi-than return card) and prints the ones with no credit,
 * with the rate the bale holds today and the credit that would have been
 * posted — so the owner can decide about a backfill with the numbers in
 * front of him.
 *
 * READ-ONLY. Writes nothing to any sheet. Usage:
 *   node scripts/list-uncredited-returns.js            # table to stdout
 *   node scripts/list-uncredited-returns.js --csv      # CSV to stdout
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const baleMovementsRepository = require('../src/repositories/baleMovementsRepository');
const ledgerRepository = require('../src/repositories/ledgerRepository');
const inventoryRepository = require('../src/repositories/inventoryRepository');

const CSV = process.argv.includes('--csv');

function ngn(n) { return `₦${Math.round(Number(n) || 0).toLocaleString('en-NG')}`; }

/**
 * Pair movements with ledger credits and price the uncredited ones.
 * Pure — exported so it can be tested without a sheet.
 */
function findUncredited({ movements, ledger, inventory }) {
  const creditedRefs = new Set(ledger
    // RET-4 adds RN-<bale>-<requestId> to the RT-/RP- return txn shapes.
    .filter((e) => Number(e.credit) > 0 && /^R[TPN]-/.test(e.txn_id))
    .map((e) => e.txn_id));
  const rateByBale = new Map();
  for (const r of inventory) {
    if (!(Number(r.pricePerYard) > 0)) continue;
    const key = `${r.packageNo}|${r.warehouse}`;
    const cur = rateByBale.get(key) || { yards: 0, amount: 0 };
    cur.yards += Number(r.yards) || 0;
    cur.amount += (Number(r.yards) || 0) * Number(r.pricePerYard);
    rateByBale.set(key, cur);
  }
  const yardsByBale = new Map();
  for (const r of inventory) {
    const key = `${r.packageNo}|${r.warehouse}`;
    const cur = yardsByBale.get(key) || { thans: 0, yards: 0 };
    cur.thans += 1; cur.yards += Number(r.yards) || 0;
    yardsByBale.set(key, cur);
  }
  const out = [];
  for (const m of movements) {
    if (m.kind !== 'return') continue;
    const wh = (m.toState.split('@')[1] || '').trim();
    const key = `${m.baleNo}|${wh}`;
    // A whole-bale return is RP-<bale>; a single than RT-<bale>-<than>; a
    // RET-4 set of ticked thans RN-<bale>-<requestId>. The movement row does
    // not record WHICH than, so any RT-/RN- credit for the bale counts as
    // credited (RET-4 writes one movement row per than but ONE credit for
    // the whole set, so the credit cannot be matched than by than).
    const rp = creditedRefs.has(`RP-${m.baleNo}`);
    const rt = [...creditedRefs].some((ref) => ref.startsWith(`RT-${m.baleNo}-`)
      || ref.startsWith(`RN-${m.baleNo}-`));
    if (rp || rt) continue;
    const priced = rateByBale.get(key);
    const rate = priced && priced.yards > 0 ? priced.amount / priced.yards : 0;
    const bale = yardsByBale.get(key);
    const yards = bale && bale.thans > 0 ? (bale.yards / bale.thans) * (m.thans || 0) : 0;
    out.push({
      movedOn: m.movedOn, baleNo: m.baleNo, design: m.design, shade: m.shade, warehouse: wh,
      thans: m.thans, buyer: m.ref, yards: Math.round(yards * 100) / 100, rate: Math.round(rate * 100) / 100,
      credit: Math.round(yards * rate), user: m.user,
    });
  }
  return out.sort((a, b) => String(a.movedOn).localeCompare(String(b.movedOn)));
}

async function main() {
  const [movements, ledger, inventory] = await Promise.all([
    baleMovementsRepository.getAll(),
    ledgerRepository.getAll(),
    inventoryRepository.getAll(true),
  ]);
  const rows = findUncredited({ movements, ledger, inventory });
  if (CSV) {
    console.log('moved_on,bale,design,shade,warehouse,thans,buyer,yards_est,rate_today,credit_est,user');
    for (const r of rows) console.log([r.movedOn, r.baleNo, r.design, r.shade, r.warehouse, r.thans, JSON.stringify(r.buyer), r.yards, r.rate, r.credit, r.user].join(','));
    return;
  }
  if (!rows.length) { console.log('Every approved return has a ledger credit. Nothing to backfill.'); return; }
  console.log(`${rows.length} approved return(s) with NO customer credit (read-only listing):\n`);
  for (const r of rows) {
    console.log(`${r.movedOn}  Bale ${r.baleNo} ${r.design} ${r.shade}  @ ${r.warehouse || '?'}  ${r.thans} than(s) ≈ ${r.yards} yds`
      + `\n    buyer: ${r.buyer || '(none recorded)'}   rate today: ${r.rate ? ngn(r.rate) + '/yd' : 'none'}   would credit: ${r.credit ? ngn(r.credit) : '—'}   by ${r.user}`);
  }
  const total = rows.reduce((s, r) => s + r.credit, 0);
  console.log(`\nTotal credit never posted (at today's rates, yards estimated per than): ${ngn(total)}`);
  console.log('Yards are the bale average × thans returned — the movement row does not name the than. No sheet was written.');
}

module.exports = { findUncredited };

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
