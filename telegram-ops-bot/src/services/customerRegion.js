'use strict';

/**
 * customerRegion — CRM-R1 (owner, 29/30-Oct-2026).
 *
 * "Under CRM, I need a separate selection of chips from different regions …
 * Lagos which consists of two stores: Lagos and Idumota, and another which is
 * the Kano office." … "this bifurcation of customers between the regions
 * shall always be done as and when required. Even when the employees who
 * belong to a certain region shall not be seen from another region, only
 * admin can see all of them at once." … "Prospect will be given a region as
 * and when they get added by employees … tagged temporarily."
 *
 * A customer belongs to the REGION of their stores: the Locations register
 * (LOC-1) says which city a store sits in, and since CUS-3 every customer's
 * row carries the stores they buy from (col N). A buyer's store is stamped by
 * the approved sale; a prospect's store is stamped when they are added (the
 * adding employee's own store — provisional until the first sale). All of it
 * is computed at read time from those two sheets: nobody tags by hand,
 * nothing runs on a schedule, a newly registered city is a region at once.
 *
 * Buckets (an active customer may sit in several):
 *   region     stores ∩ the region's places ≠ ∅
 *   prospects  first_sale_at blank (no sale yet), whatever the stores cell
 *   notPlaced  stores blank — buyer or prospect; the chip vanishes once every
 *              customer carries a store
 *
 * Viewer scope: an admin sees every region and everyone; an employee sees
 * only the region(s) of the stores on their own Users row (col I).
 * Read-only here; the one write (a prospect's store) goes through
 * customersRepository.setStores from the card.
 */

const auth = require('../middlewares/auth');
const logger = require('../utils/logger');

const PAGE_SIZE = 8;
const NAV_TTL_MS = 30 * 60 * 1000;
const _nav = new Map(); // userId → { key, page, at }

const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const isActive = (c) => String((c && c.status) || 'Active').trim().toLowerCase() === 'active';
const hasBought = (c) => !!(c && c.first_sale_at);
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' });

/**
 * The regions and the place → region map, from the Locations register.
 * Unregistered places (no city) are not in any region.
 * @returns {Promise<{regions:Array<{name:string, places:string[]}>, placeRegion:Map<string,string>}>}
 */
async function regionMap() {
  const placeRegion = new Map();
  const regions = new Map();
  try {
    const locationService = require('./locationService');
    for (const p of await locationService.allPlaces()) {
      if (!p.location) continue;
      placeRegion.set(norm(p.name), p.location);
      if (!regions.has(p.location)) regions.set(p.location, []);
      regions.get(p.location).push(p.name);
    }
  } catch (e) {
    logger.warn(`customerRegion.regionMap: register read failed: ${e.message}`);
  }
  return {
    regions: [...regions.entries()]
      .map(([name, places]) => ({ name, places: places.sort((a, b) => a.localeCompare(b, 'en')) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en')),
    placeRegion,
  };
}

/** The regions a stores list touches. */
function regionsOfStores(stores, placeRegion) {
  const out = new Set();
  for (const s of stores || []) {
    const r = placeRegion.get(norm(s));
    if (r) out.add(r);
  }
  return out;
}

/**
 * Split the active customers into the buckets. Pure.
 * Each list is buyers A–Z then prospects A–Z (the CUS-3 picker grammar).
 * @returns {{byRegion:Map<string,object[]>, prospects:object[], notPlaced:object[], all:object[], regions:Array<{name:string, places:string[], count:number}>}}
 */
function classify(customers, map) {
  const live = (customers || []).filter((c) => c && c.name && isActive(c));
  const order = (list) => [...list.filter(hasBought).sort(byName), ...list.filter((c) => !hasBought(c)).sort(byName)];
  const byRegion = new Map(map.regions.map((r) => [r.name, []]));
  const prospects = [];
  const notPlaced = [];
  for (const c of live) {
    const stores = Array.isArray(c.stores) ? c.stores.filter(Boolean) : [];
    for (const r of regionsOfStores(stores, map.placeRegion)) {
      if (!byRegion.has(r)) byRegion.set(r, []);
      byRegion.get(r).push(c);
    }
    if (!hasBought(c)) prospects.push(c);
    if (!stores.length) notPlaced.push(c);
  }
  for (const [k, v] of byRegion) byRegion.set(k, order(v));
  const regions = [...byRegion.entries()]
    .map(([name, list]) => ({ name, places: (map.regions.find((r) => r.name === name) || { places: [] }).places, count: list.length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en'));
  return { byRegion, prospects: order(prospects), notPlaced: order(notPlaced), all: order(live), regions };
}

/**
 * The regions this viewer may see: null = every region (admin); [] = none.
 * @param {string} userId
 * @param {Map<string,string>} placeRegion
 */
async function viewerRegions(userId, placeRegion) {
  if (auth.isAdmin(userId)) return null;
  try {
    const usersRepository = require('../repositories/usersRepository');
    const u = await usersRepository.findByUserId(String(userId));
    const stores = (u && Array.isArray(u.warehouses)) ? u.warehouses : [];
    return [...regionsOfStores(stores, placeRegion)];
  } catch (e) {
    logger.warn(`customerRegion.viewerRegions(${userId}): ${e.message}`);
    return [];
  }
}

/** True when the viewer may see / re-place this customer (admin, or their region, or not placed). */
function mayTouch(viewerRegions_, customer, placeRegion) {
  if (viewerRegions_ === null) return true;
  const rs = regionsOfStores((customer && customer.stores) || [], placeRegion);
  if (!rs.size) return true;
  return [...rs].some((r) => viewerRegions_.includes(r));
}

/** A–Al style range of a page from the names' first letters. */
function rangeLabel(items) {
  if (!items.length) return '';
  const ab = (c) => {
    const s = String(c.name || '').trim();
    return s ? (s[0].toUpperCase() + (s[1] && /[a-z]/i.test(s[1]) ? s[1].toLowerCase() : '')) : '';
  };
  const a = ab(items[0]); const b = ab(items[items.length - 1]);
  return a === b ? a : `${a}–${b}`;
}

/**
 * One page of a list.
 * @returns {{items:object[], page:number, pages:number, total:number, range:string}}
 */
function page(list, n, size = PAGE_SIZE) {
  const total = (list || []).length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(0, Number(n) || 0), pages - 1);
  const items = (list || []).slice(p * size, p * size + size);
  return { items, page: p, pages, total, range: rangeLabel(items) };
}

/** `🏙 Kano office · IDUMOTA` / `🏙 Kano office · provisional` / `🏙 Not placed yet`. */
function storesLine(c) {
  const stores = (c && Array.isArray(c.stores)) ? c.stores.filter(Boolean) : [];
  if (!stores.length) return '🏙 Not placed yet';
  return `🏙 ${stores.join(' · ')}${hasBought(c) ? '' : ' · provisional'}`;
}

/** Who raised the approved add_contact for this name, best-effort. */
async function addedBy(name) {
  try {
    const approvalQueueRepository = require('../repositories/approvalQueueRepository');
    const rows = await approvalQueueRepository.getAll();
    const hit = rows
      .filter((r) => r && r.status === 'approved' && r.actionJSON && r.actionJSON.action === 'add_contact' && norm(r.actionJSON.name) === norm(name))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    if (!hit) return null;
    let label = String(hit.user || '');
    try {
      const usersRepository = require('../repositories/usersRepository');
      const u = await usersRepository.findByUserId(String(hit.user));
      if (u && u.name) label = u.name;
    } catch (_) { /* id */ }
    return { by: label, at: hit.createdAt || '' };
  } catch (_) { return null; }
}

/* ── where the viewer was, so the card's Back returns to that page ── */
function rememberNav(userId, nav) {
  _nav.set(String(userId), { ...nav, at: Date.now() });
  for (const [k, v] of _nav) if (Date.now() - v.at > NAV_TTL_MS) _nav.delete(k);
}
function navOf(userId) {
  const v = _nav.get(String(userId));
  return v && Date.now() - v.at <= NAV_TTL_MS ? { key: v.key, page: v.page } : null;
}
function _resetForTests() { _nav.clear(); }

module.exports = {
  PAGE_SIZE, regionMap, regionsOfStores, classify, viewerRegions, mayTouch, page, rangeLabel,
  storesLine, addedBy, rememberNav, navOf, hasBought, _resetForTests,
};
