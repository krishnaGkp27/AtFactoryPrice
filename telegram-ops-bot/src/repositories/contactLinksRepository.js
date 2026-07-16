'use strict';

/**
 * CNET-1a — ContactLinks: the EDGE table of the contact network.
 * One row = one typed relation between two Contacts rows, e.g.
 *   from=CON-musa  to=CON-alabi  relation=subordinate_of
 * (from is the subordinate, to is the boss). Multi-parent is expected —
 * one clearing boy serving three buyers is three rows. Rows are never
 * deleted: deactivate flips status so the trail stays (storage rule:
 * this sheet holds raw relational business facts, nothing else).
 */

const crypto = require('crypto');
const sheets = require('./sheetsClient');

const SHEET = 'ContactLinks';
const RELATIONS = ['subordinate_of'];

const CACHE_TTL_MS = 30 * 1000;
let _cache = null;
let _cacheTs = 0;
function invalidateCache() { _cache = null; _cacheTs = 0; }

function str(v) { return (v ?? '').toString().trim(); }

function parse(r, rowIndex) {
  return {
    rowIndex,
    link_id: str(r[0]),
    from_contact_id: str(r[1]),
    to_contact_id: str(r[2]),
    relation: str(r[3]) || 'subordinate_of',
    notes: str(r[4]),
    status: str(r[5]) || 'active',
    created_by: str(r[6]),
    created_at: str(r[7]),
  };
}

async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const rows = await sheets.readRange(SHEET, 'A2:H');
  _cache = rows.map((r, i) => parse(r, i + 2)).filter((l) => l.link_id);
  _cacheTs = Date.now();
  return _cache;
}

async function getActive() {
  return (await getAll()).filter((l) => l.status === 'active');
}

/**
 * Add an edge. Refuses self-links and exact active duplicates
 * (same from/to/relation) so re-submits are idempotent.
 */
async function append({ from_contact_id, to_contact_id, relation, notes, created_by }) {
  const from = str(from_contact_id); const to = str(to_contact_id);
  if (!from || !to) throw new Error('ContactLinks: both ends required');
  if (from === to) throw new Error('ContactLinks: a contact cannot link to itself');
  const rel = RELATIONS.includes(str(relation)) ? str(relation) : 'subordinate_of';
  const dupe = (await getActive()).find((l) => l.from_contact_id === from && l.to_contact_id === to && l.relation === rel);
  if (dupe) return { ...dupe, duplicate: true };
  const link = {
    link_id: `CL-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    from_contact_id: from, to_contact_id: to, relation: rel,
    notes: str(notes), status: 'active',
    created_by: str(created_by), created_at: new Date().toISOString(),
  };
  await sheets.appendRows(SHEET, [[
    link.link_id, link.from_contact_id, link.to_contact_id, link.relation,
    link.notes, link.status, link.created_by, link.created_at,
  ]]);
  invalidateCache();
  return link;
}

/** Soft-delete: status → inactive (audit trail preserved). */
async function deactivate(linkId) {
  const all = await getAll();
  const row = all.find((l) => l.link_id === str(linkId));
  if (!row) return false;
  await sheets.updateRange(SHEET, `F${row.rowIndex}`, [['inactive']]);
  invalidateCache();
  return true;
}

module.exports = { SHEET, RELATIONS, getAll, getActive, append, deactivate, invalidateCache };
