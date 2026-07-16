'use strict';

/**
 * CNET-1a — the contact network graph (specs/CNET-1_CONTACT_NETWORK.md).
 *
 * Nodes = Contacts rows (people; buyers carry customer_id and read their
 * LIVE phone from the Customers row so CRM edits win). Edges = ContactLinks
 * rows (from=subordinate → to=boss). All traversal is cycle-safe (visited
 * set, deptGraph precedent) and depth-capped. Category→buyers is DERIVED
 * from one Inventory snapshot (col W category + soldTo/soldDate live on the
 * same rows) — never stored (storage rule 5b).
 */

const contactsRepository = require('../repositories/contactsRepository');
const contactLinksRepository = require('../repositories/contactLinksRepository');
const customersRepository = require('../repositories/customersRepository');
const designCategoriesRepo = require('../repositories/designCategoriesRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const logger = require('../utils/logger');

const MAX_DEPTH = 6;

/** Load nodes + active edges into adjacency maps (one shot, callers hold it). */
async function loadGraph() {
  const [contacts, links] = await Promise.all([
    contactsRepository.getAll(),
    contactLinksRepository.getActive(),
  ]);
  const nodes = new Map(contacts.filter((c) => c.status !== 'inactive').map((c) => [c.contact_id, c]));
  const down = new Map(); // boss contact_id → [subordinate nodes]
  const up = new Map();   // subordinate contact_id → [boss nodes]
  for (const l of links) {
    const sub = nodes.get(l.from_contact_id);
    const boss = nodes.get(l.to_contact_id);
    if (!sub || !boss) continue; // tolerate dangling edges (dirty-sheet rule)
    if (!down.has(boss.contact_id)) down.set(boss.contact_id, []);
    down.get(boss.contact_id).push(sub);
    if (!up.has(sub.contact_id)) up.set(sub.contact_id, []);
    up.get(sub.contact_id).push(boss);
  }
  return { nodes, down, up };
}

/** Direct reports of a contact. */
function subordinatesOf(graph, contactId) {
  return (graph.down.get(contactId) || []).slice();
}

/** Direct superiors (multi-parent expected). */
function superiorsOf(graph, contactId) {
  return (graph.up.get(contactId) || []).slice();
}

/**
 * Depth-first subtree from a contact: [{node, depth}] in visit order.
 * Cycle-safe (visited set) and hard-capped at MAX_DEPTH.
 */
function treeOf(graph, contactId, maxDepth = MAX_DEPTH) {
  const out = [];
  const seen = new Set([contactId]);
  const walk = (id, depth) => {
    if (depth >= maxDepth) return;
    for (const sub of graph.down.get(id) || []) {
      if (seen.has(sub.contact_id)) continue; // cycle in sheet data — skip, never loop
      seen.add(sub.contact_id);
      out.push({ node: sub, depth: depth + 1 });
      walk(sub.contact_id, depth + 1);
    }
  };
  walk(contactId, 0);
  return out;
}

/**
 * The person's best current phone: the live Customers row wins when the
 * node backlinks a customer (CRM edits propagate); Contacts row otherwise.
 */
async function livePhoneOf(node) {
  if (node && node.customer_id) {
    try {
      const cust = await customersRepository.findById(node.customer_id);
      if (cust && (cust.phone || '').trim()) return cust.phone.trim();
    } catch (e) { logger.warn(`contactGraph livePhone: ${e.message}`); }
  }
  return (node && (node.phone || node.whatsapp)) || '';
}

/**
 * Buyers of a DCAT-1 category, most recent buyer first.
 * One Inventory snapshot answers both sides of the join: rows carry the
 * design's category (col W, first non-empty per design) AND soldTo/soldDate.
 */
async function buyersOfCategory(category) {
  const want = designCategoriesRepo.canonicalizeCategory
    ? designCategoriesRepo.canonicalizeCategory(category)
    : String(category || '').trim();
  const rows = await inventoryRepository.getAll();
  // First non-empty category per design (mirror designCategoriesRepository).
  const catByDesign = new Map();
  for (const r of rows) {
    const d = String(r.design || '').toUpperCase();
    if (!d || catByDesign.get(d)) continue;
    if ((r.designCategory || '').trim()) catByDesign.set(d, r.designCategory.trim());
  }
  const matches = (d) => {
    const c = catByDesign.get(String(d || '').toUpperCase()) || '';
    return c.toLowerCase() === String(want).toLowerCase();
  };
  const byBuyer = new Map(); // name → { name, lastDate, designs:Set, warehouses:Set }
  for (const r of rows) {
    if (r.status !== 'sold' || !(r.soldTo || '').trim() || !matches(r.design)) continue;
    const key = r.soldTo.trim();
    if (!byBuyer.has(key)) byBuyer.set(key, { name: key, lastDate: '', designs: new Set(), warehouses: new Set() });
    const b = byBuyer.get(key);
    b.designs.add(String(r.design));
    if ((r.warehouse || '').trim()) b.warehouses.add(r.warehouse.trim());
    if ((r.soldDate || '') > b.lastDate) b.lastDate = r.soldDate || '';
  }
  return [...byBuyer.values()]
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate))
    .map((b) => ({ name: b.name, lastDate: b.lastDate, designs: [...b.designs], warehouses: [...b.warehouses] }));
}

/**
 * Node for a customer NAME, creating the shadow Contacts row lazily the
 * first time the network needs it (spec §2). Returns the Contacts node.
 */
async function ensureNodeForCustomer(customerName, createdBy) {
  const cust = await customersRepository.findByName(customerName);
  if (cust) {
    const existing = await contactsRepository.findByCustomerId(cust.customer_id);
    if (existing) return existing;
    return contactsRepository.append({
      name: cust.name, phone: cust.phone || '', type: 'customer',
      address: cust.address || '', notes: 'CNET shadow node (auto)',
      customer_id: cust.customer_id, updated_by: createdBy || '',
    });
  }
  // Buyer name exists only in sales history (no Customers row) — still a node.
  const byName = (await contactsRepository.searchByName(customerName))
    .find((c) => c.name.toLowerCase() === String(customerName || '').toLowerCase());
  if (byName) return byName;
  return contactsRepository.append({
    name: customerName, type: 'customer', notes: 'CNET shadow node (auto, no CRM row)',
    updated_by: createdBy || '',
  });
}

module.exports = { loadGraph, subordinatesOf, superiorsOf, treeOf, livePhoneOf, buyersOfCategory, ensureNodeForCustomer, MAX_DEPTH };
