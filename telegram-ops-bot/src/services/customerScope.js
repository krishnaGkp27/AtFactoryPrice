'use strict';
/**
 * CUS-3 (owner, 19-Oct-2026) — which customers a STORE's pickers offer.
 *
 * "All the customers from both locations are shown in all sales, which
 * causes a lengthy search operation … Kafaya takes the supply from Lagos and
 * Idumota, so she must not be shown to the Kano office, and vice versa."
 * And: "Don't go through a real-time check inquiry all the time" — so the
 * answer comes from two cells on the Customers sheet alone: column N
 * `stores` (the stores the customer buys from, declared or stamped at an
 * approved sale) and column O `first_sale_at` (stamped once). Never from the
 * stock sheet at pick time.
 *
 *  - in scope at a store: the cell names the store, OR the cell is empty
 *    (an unplaced customer is offered everywhere until placed);
 *  - buyers (first sale on file) come first, alphabetical; a customer who
 *    has never bought comes LAST, marked 🆕 (owner: "will always show in
 *    last to pick … with some different identification");
 *  - every picker keeps a 🌐 All customers door and typed search, so an
 *    out-of-place sale is one tap away, never blocked.
 *
 * Store granularity (owner: "let the granularity of storing it be store
 * first"); city grouping comes later through the Locations sheet.
 */
const logger = require('../utils/logger');

const key = (s) => String(s == null ? '' : s).trim().toUpperCase();
const isActive = (c) => String((c && c.status) || 'Active').trim().toLowerCase() === 'active';

/** True when the customer's stores cell names `store`, or is empty. */
function inStore(c, store) {
  const k = key(store);
  if (!k) return true;
  const list = Array.isArray(c && c.stores) ? c.stores : [];
  if (!list.length) return true;
  return list.some((s) => key(s) === k);
}

const hasBought = (c) => !!(c && c.first_sale_at);

/** `🆕 Kafaya` for a customer with no sale on file, `👤 ABBA` otherwise. */
function chipLabel(c, icon) {
  const ic = typeof icon === 'string' && icon.trim() ? icon : '👤';
  return `${hasBought(c) ? ic : '🆕'} ${c.name}`;
}

/**
 * The active customers a store's picker offers, in picker order.
 * @param {Array<object>} customers rows from customersRepository
 * @param {string} store '' = no store filter (still buyers first)
 * @returns {{buyers:Array<object>, fresh:Array<object>, all:Array<object>}}
 */
function forStore(customers, store) {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const live = (customers || []).filter((c) => c && c.name && isActive(c) && inStore(c, store));
  const buyers = live.filter(hasBought).sort(byName);
  const fresh = live.filter((c) => !hasBought(c)).sort(byName);
  return { buyers, fresh, all: [...buyers, ...fresh] };
}

/**
 * After an approved sale: the store joins the customer's cell when it is not
 * there yet, and the first sale is stamped once. Best-effort — a sale never
 * fails on this, and a customer the registry cannot resolve is left alone.
 * @param {{name:string, stores:string[], soldDate?:string}} p
 */
async function noteSale({ name, stores, soldDate } = {}) {
  try {
    if (!name) return false;
    const customerEntity = require('./customerEntity');
    const repo = require('../repositories/customersRepository');
    const c = await customerEntity.resolve({ name });
    if (!c || !c.customer_id) return false;
    const have = Array.isArray(c.stores) ? c.stores.slice() : [];
    const haveKeys = new Set(have.map(key));
    let changed = false;
    for (const s of stores || []) {
      const t = String(s || '').trim();
      if (!t || haveKeys.has(key(t))) continue;
      have.push(t); haveKeys.add(key(t)); changed = true;
    }
    if (changed) await repo.setStores(c.customer_id, have);
    if (!c.first_sale_at) await repo.noteFirstSale(c.customer_id, soldDate || new Date().toISOString());
    return changed || !c.first_sale_at;
  } catch (e) {
    logger.warn(`customerScope.noteSale(${name}): ${e.message}`);
    return false;
  }
}

module.exports = { inStore, hasBought, chipLabel, forStore, noteSale, _internals: { key } };
