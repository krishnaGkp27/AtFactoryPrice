#!/usr/bin/env node
'use strict';
/**
 * CUS-3 — fill the Customers sheet's `stores` (N) and `first_sale_at` (O)
 * cells ONCE from the sales history, so the pickers never read the stock
 * sheet at pick time (owner: "don't go through a real-time check inquiry").
 *
 * For every active customer with a BLANK stores cell: the stores they were
 * sold to from (Inventory rows with status sold, matched by canonical name
 * or alias), in order of first sale; and, when `first_sale_at` is blank, the
 * earliest sale date. A cell that already holds a value is never touched.
 * Customers with no sale on file are listed for the owner to place.
 *
 * READ-ONLY by default (prints the plan). `--commit` writes.
 *   node scripts/backfill-customer-stores.js
 *   node scripts/backfill-customer-stores.js --commit
 *   node scripts/backfill-customer-stores.js --drop "CJE:Kano office" --commit
 * `--drop NAME:STORE` leaves that pairing out (a sale recorded at the wrong
 * store — the owner's CJE case, 19-Oct-2026).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const day = (v) => String(v || '').slice(0, 10);

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const drops = new Set();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--drop' && args[i + 1]) { drops.add(norm(args[i + 1])); i += 1; }
  }
  const customersRepository = require('../src/repositories/customersRepository');
  const inventoryRepository = require('../src/repositories/inventoryRepository');
  const customers = await customersRepository.getAll();
  const inv = await inventoryRepository.getAll();

  // name/alias → customer
  const byKey = new Map();
  for (const c of customers) {
    if (norm(c.status) === 'MERGED') continue;
    byKey.set(norm(c.name), c);
    for (const a of c.aliases || []) if (!byKey.has(norm(a))) byKey.set(norm(a), c);
  }
  const hist = new Map(); // customer_id → { stores: Map<storeKey,{name, first}>, first }
  for (const r of inv) {
    if (String(r.status || '').toLowerCase() !== 'sold' || !r.soldTo || !r.warehouse) continue;
    const c = byKey.get(norm(r.soldTo));
    if (!c) continue;
    if (drops.has(`${norm(c.name)}:${norm(r.warehouse)}`)) continue;
    if (!hist.has(c.customer_id)) hist.set(c.customer_id, { stores: new Map(), first: '' });
    const h = hist.get(c.customer_id);
    const d = day(r.soldDate);
    const k = norm(r.warehouse);
    if (!h.stores.has(k)) h.stores.set(k, { name: String(r.warehouse).trim(), first: d });
    else if (d && (!h.stores.get(k).first || d < h.stores.get(k).first)) h.stores.get(k).first = d;
    if (d && (!h.first || d < h.first)) h.first = d;
  }

  const plan = [];
  const unplaced = [];
  for (const c of customers) {
    if (norm(c.status) !== 'ACTIVE' && norm(c.status) !== '') continue;
    const h = hist.get(c.customer_id);
    const stores = h ? [...h.stores.values()].sort((a, b) => (a.first || '').localeCompare(b.first || '')).map((s) => s.name) : [];
    const writeStores = !(c.stores || []).length && stores.length;
    const writeFirst = !c.first_sale_at && h && h.first;
    if (writeStores || writeFirst) plan.push({ c, stores: writeStores ? stores : null, first: writeFirst ? h.first : null });
    if (!stores.length && !(c.stores || []).length) unplaced.push(c.name);
  }

  console.log(`${customers.length} customers · ${plan.length} to fill · ${unplaced.length} with no sale on file and no store declared`);
  for (const p of plan) {
    console.log(`  ${p.c.name.padEnd(28)} ${p.stores ? `stores → ${p.stores.join(', ')}` : '(stores kept)'}${p.first ? ` · first sale → ${p.first}` : ''}`);
  }
  if (unplaced.length) console.log(`\nNo sale on file — place by hand (column N):\n  ${unplaced.join('\n  ')}`);
  if (!commit) { console.log('\nDry run — nothing written. Re-run with --commit to write.'); return; }
  let n = 0;
  for (const p of plan) {
    if (p.stores) { await customersRepository.setStores(p.c.customer_id, p.stores); n += 1; }
    if (p.first) { await customersRepository.noteFirstSale(p.c.customer_id, p.first); n += 1; }
  }
  console.log(`\nWrote ${n} cell(s).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
