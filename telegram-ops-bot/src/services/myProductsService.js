'use strict';

/**
 * MYP-2 — the product set a LINKED customer/marketer sees (§16, v4).
 *
 * ALLOCATION-DRIVEN ONLY (owner, 23-Aug-2026): the display is exactly what
 * the admin allocated — per design, and per shade where the matrix set
 * shade rows. Purchase history feeds the SUPPLIED numbers (their own goods
 * received so far), never the display set. The recursive one-grammar law:
 * every pair reads (supplied-to-them / allocated-to-them); no warehouse
 * fact of any kind ever reaches their world.
 *
 * The source warehouse is still computed INTERNALLY (most recent purchase)
 * — it routes their supply requests and scopes the §16 cap; it is never
 * displayed to them.
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

/**
 * Build the person's allocation-driven view.
 * @returns {{warehouse:string|null, items:[{design, allocatedB, suppliedB,
 *            shades:[{shade, allocatedB, suppliedB}]}]}}
 */
async function buildFor(info) {
  const inventoryRepository = require('../repositories/inventoryRepository');
  const allocationsRepo = require('../repositories/marketerAllocationsRepository');

  const [sold, allocRows] = await Promise.all([
    inventoryRepository.getSoldRows(),
    allocationsRepo.getAll().catch(() => []),
  ]);

  const aliases = await aliasSetFor(info);
  const mine = sold.filter((r) => aliases.has(norm(r.soldTo)));

  // Supplied-to-them: distinct bales per design and per (design, shade),
  // plus the source warehouse (most recent purchase) for routing/cap.
  const supByDesign = new Map(); // design(norm) → Set(packageNo)
  const supByShade = new Map();  // design|shade → Set(packageNo)
  let latest = null;
  for (const r of mine) {
    const d = norm(r.design);
    if (!d) continue;
    if (!supByDesign.has(d)) supByDesign.set(d, new Set());
    supByDesign.get(d).add(r.packageNo);
    const key = `${d}|${norm(r.shade)}`;
    if (!supByShade.has(key)) supByShade.set(key, new Set());
    supByShade.get(key).add(r.packageNo);
    if (!latest || r.soldDate > latest.soldDate) latest = r;
  }
  const warehouse = latest ? latest.warehouse : null;

  // Allocation rows for this person; '*' legacy mode rows are ignored.
  const myRows = (allocRows || []).filter((a) => String(a.marketer_id) === String(info.telegramId)
    && String(a.design).trim() !== '*' && Number(a.allocated_qty) > 0);

  const byDesign = new Map(); // design(norm) → {label, designLevelB, shades:[]}
  for (const a of myRows) {
    const d = norm(a.design);
    if (!byDesign.has(d)) byDesign.set(d, { label: a.design, designLevelB: 0, shades: [] });
    const e = byDesign.get(d);
    const sh = String(a.shade || '').trim();
    if (sh) {
      e.shades.push({
        shade: sh,
        allocatedB: Number(a.allocated_qty),
        suppliedB: (supByShade.get(`${d}|${norm(sh)}`) || new Set()).size,
      });
    } else {
      e.designLevelB += Number(a.allocated_qty);
    }
  }

  const items = [];
  for (const [d, e] of byDesign) {
    const shadeSum = e.shades.reduce((n, s) => n + s.allocatedB, 0);
    e.shades.sort((a, b) => b.allocatedB - a.allocatedB || a.shade.localeCompare(b.shade, undefined, { numeric: true }));
    items.push({
      design: e.label,
      allocatedB: shadeSum + e.designLevelB,
      suppliedB: (supByDesign.get(d) || new Set()).size,
      shades: e.shades,
    });
  }
  items.sort((x, y) => y.allocatedB - x.allocatedB || String(x.design).localeCompare(String(y.design), undefined, { numeric: true }));
  return { warehouse, items };
}

/** Live available bale count for one design(+shade) — the §16 cap source. */
async function availableForDesign(design, warehouse, shade) {
  const inventoryRepository = require('../repositories/inventoryRepository');
  const all = await inventoryRepository.getAll();
  const set = new Set();
  for (const r of all) {
    if (r.status !== 'available') continue;
    if (norm(r.design) !== norm(design)) continue;
    if (warehouse && norm(r.warehouse) !== norm(warehouse)) continue;
    if (shade && norm(r.shade) !== norm(shade)) continue;
    set.add(r.packageNo);
  }
  return set.size;
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

module.exports = { buildFor, availableForDesign, sourceWarehouseFor, _internals: { aliasSetFor } };
