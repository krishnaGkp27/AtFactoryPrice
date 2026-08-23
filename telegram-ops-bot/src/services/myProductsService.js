'use strict';

/**
 * MYP-1 — the product set a LINKED customer/marketer sees (§16).
 *
 * Default mode AUTO: the designs this person already PURCHASED, with stock
 * details from the SAME warehouse those purchases were supplied from (the
 * warehouse of their most recent purchase — one source warehouse per
 * person in v1; a mixed history is flagged, never silently merged).
 * CURATED: only the admin-allocated designs (the matrix / mal: flow).
 *
 * All derived at read time (§10). Chip grammar is Supply Details verbatim:
 * `📦 <design> — <suppliedB>B / <availableB>B`.
 */

const logger = require('../utils/logger');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** Alias set for matching sold rows: customer entity when linked to one. */
async function aliasSetFor(info) {
  const names = new Set();
  if (info.linkName) names.add(norm(info.linkName));
  try {
    if (info.type === 'customer' && info.linkId) {
      const customerEntity = require('./customerEntity');
      const cust = await customerEntity.resolve({ id: info.linkId });
      if (cust) for (const n of customerEntity.namesFor(cust)) names.add(norm(n));
    }
  } catch (e) {
    logger.warn(`myProducts.aliases: ${e.message}`);
  }
  names.delete('');
  return names;
}

/** Distinct available bale count per design in one warehouse (all if null). */
function availableByDesign(allRows, warehouse) {
  const map = new Map(); // design(norm) → Set(packageNo)
  for (const r of allRows) {
    if (r.status !== 'available') continue;
    if (warehouse && norm(r.warehouse) !== norm(warehouse)) continue;
    const d = norm(r.design);
    if (!d) continue;
    if (!map.has(d)) map.set(d, new Set());
    map.get(d).add(r.packageNo);
  }
  return map;
}

/**
 * Build the person's product view.
 * @returns {{mode, warehouse, mixedHistory, items:[{design, suppliedB, availableB, allocatedB}]}}
 */
async function buildFor(info) {
  const inventoryRepository = require('../repositories/inventoryRepository');
  const allocationsRepo = require('../repositories/marketerAllocationsRepository');

  const [sold, all, allocRows] = await Promise.all([
    inventoryRepository.getSoldRows(),
    inventoryRepository.getAll(),
    allocationsRepo.getAll().catch(() => []),
  ]);

  const aliases = await aliasSetFor(info);
  const mine = sold.filter((r) => aliases.has(norm(r.soldTo)));

  // Purchase-derived facts: designs, bales per design, source warehouse.
  const suppliedMap = new Map(); // design(norm) → {label, bales:Set, lastDate}
  const warehouses = new Set();
  let latest = null;
  for (const r of mine) {
    const d = norm(r.design);
    if (!d) continue;
    if (!suppliedMap.has(d)) suppliedMap.set(d, { label: r.design, bales: new Set(), lastDate: '' });
    const e = suppliedMap.get(d);
    e.bales.add(r.packageNo);
    if (r.soldDate > e.lastDate) e.lastDate = r.soldDate;
    warehouses.add(norm(r.warehouse));
    if (!latest || r.soldDate > latest.soldDate) latest = r;
  }
  const warehouse = latest ? latest.warehouse : null;
  const mixedHistory = warehouses.size > 1;

  const myRows = (allocRows || []).filter((a) => String(a.marketer_id) === String(info.telegramId));
  const modeRow = myRows.find((a) => String(a.design).trim() === '*');
  const mode = modeRow && norm(modeRow.notes) === 'curated' ? 'curated' : 'auto';
  const allocByDesign = new Map();
  for (const a of myRows) {
    if (String(a.design).trim() === '*') continue;
    if (Number(a.allocated_qty) > 0) allocByDesign.set(norm(a.design), { label: a.design, qty: Number(a.allocated_qty) });
  }

  const avail = availableByDesign(all, warehouse);
  const items = [];
  if (mode === 'curated') {
    for (const [d, a] of allocByDesign) {
      const sup = suppliedMap.get(d);
      items.push({
        design: a.label, suppliedB: sup ? sup.bales.size : 0,
        availableB: (avail.get(d) || new Set()).size, allocatedB: a.qty,
      });
    }
  } else {
    for (const [d, e] of suppliedMap) {
      const a = allocByDesign.get(d);
      items.push({
        design: e.label, suppliedB: e.bales.size,
        availableB: (avail.get(d) || new Set()).size, allocatedB: a ? a.qty : 0,
      });
    }
  }
  items.sort((x, y) => y.suppliedB - x.suppliedB || String(x.design).localeCompare(String(y.design), undefined, { numeric: true }));
  return { mode, warehouse, mixedHistory, items };
}

/** Live available bale count for one design (the allocation cap's source). */
async function availableForDesign(design, warehouse) {
  const inventoryRepository = require('../repositories/inventoryRepository');
  const all = await inventoryRepository.getAll();
  return (availableByDesign(all, warehouse || null).get(norm(design)) || new Set()).size;
}

/** The person's source warehouse (most recent purchase), or null. */
async function sourceWarehouseFor(info) {
  const inventoryRepository = require('../repositories/inventoryRepository');
  const sold = await inventoryRepository.getSoldRows();
  const aliases = await aliasSetFor(info);
  let latest = null;
  for (const r of sold) {
    if (aliases.has(norm(r.soldTo)) && (!latest || r.soldDate > latest.soldDate)) latest = r;
  }
  return latest ? latest.warehouse : null;
}

module.exports = { buildFor, availableForDesign, sourceWarehouseFor, _internals: { availableByDesign, aliasSetFor } };
