/**
 * Data access for Customers sheet (full CRM).
 */

const sheets = require('./sheetsClient');
const { ttlCache } = require('../utils/ttlCache');

const SHEET = 'Customers';

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function parse(r, rowIndex) {
  return {
    rowIndex,
    customer_id: str(r[0]),
    name: str(r[1]),
    phone: str(r[2]),
    address: str(r[3]),
    category: str(r[4]),
    credit_limit: num(r[5]),
    outstanding_balance: num(r[6]),
    payment_terms: str(r[7]),
    notes: str(r[8]),
    status: str(r[9]) || 'Active',
    created_at: str(r[10]),
    updated_at: str(r[11]),
    // CUS-1 — alternate spellings that resolve to this customer (merge
    // targets write here). Stored as a JSON array string; parsed defensively
    // because the column is hand-editable like every sheet cell.
    aliases: parseAliases(r[12]),
  };
}

function parseAliases(raw) {
  const s2 = str(raw);
  if (!s2) return [];
  try {
    const arr = JSON.parse(s2);
    return Array.isArray(arr) ? arr.map((a) => String(a).trim()).filter(Boolean) : [];
  } catch (_) {
    // Tolerate a hand-typed single name or pipe list.
    return s2.split('|').map((a) => a.trim()).filter(Boolean);
  }
}

// P6 — Customers is read constantly (every picker, every findByName during
// an approval — one sale approval hit findByName 21 times, i.e. 21 full-sheet
// reads) yet only changes when someone adds or edits a customer. 30s TTL,
// mirroring the Users/Settings caches; every write below invalidates so an
// in-bot change is visible immediately, and a manual sheet edit within 30s.
const CACHE_TTL_MS = 30 * 1000;
const _cache = ttlCache(CACHE_TTL_MS, async () => {
  const rows = await sheets.readRange(SHEET, 'A2:M');
  return rows.map((r, i) => parse(r, i + 2)).filter((c) => c.customer_id || c.name);
});

/** Drop the cached Customers snapshot (called by every write here). */
function invalidateCache() {
  _cache.invalidate();
}

async function getAll() {
  // Copy the array so a caller's sort/splice can't mutate the cached value.
  return (await _cache.get()).slice();
}

async function findById(customerId) {
  const all = await getAll();
  return all.find((c) => c.customer_id === customerId) || null;
}

// CUS-2 — statuses that are dead husks for lookup purposes: a Merged row's
// history belongs to its canonical customer (via the alias it left there),
// and a Rejected registration must never match as an existing customer.
const HUSK_STATUSES = new Set(['merged', 'rejected']);
const isHusk = (c) => HUSK_STATUSES.has(String(c.status || '').trim().toLowerCase());

/**
 * CUS-2 — entity-semantic name lookup (mirrors customerEntity.resolve):
 * husk rows never match; the canonical name wins over an alias hit, so a
 * post-merge spelling still lands on the REAL customer. Every caller that
 * used to be alias-blind (invoices, outstanding, sale validation) inherits
 * the fix from here.
 */
async function findByName(name) {
  const all = await getAll();
  const n = (name || '').toString().trim().toLowerCase();
  if (!n) return null;
  const live = all.filter((c) => !isHusk(c));
  const byName = live.find((c) => c.name.toLowerCase() === n);
  if (byName) return byName;
  return live.find((c) => (c.aliases || []).some((a) => String(a).toLowerCase() === n)) || null;
}

async function searchByName(query) {
  const all = await getAll();
  const q = (query || '').toLowerCase();
  // CUS-2 — alias hits included, husks excluded (this feeds pickers).
  return all.filter((c) => !isHusk(c) && (c.name.toLowerCase().includes(q)
    || (c.aliases || []).some((a) => String(a).toLowerCase().includes(q))));
}

async function append(customer) {
  const now = new Date().toISOString();
  // CNET-1a — phones normalize to one canonical shape on every write.
  const phone = require('../utils/phone');
  await sheets.appendRows(SHEET, [[
    customer.customer_id, customer.name, phone.toStored(customer.phone), customer.address || '',
    customer.category || 'Retail', customer.credit_limit || 0, customer.outstanding_balance || 0,
    customer.payment_terms || 'COD', customer.notes || '', customer.status || 'Active',
    now, now, JSON.stringify(customer.aliases || []),
  ]]);
  invalidateCache();
}

async function updateOutstanding(customerId, newBalance) {
  const c = await findById(customerId);
  if (!c) return false;
  const now = new Date().toISOString();
  await sheets.updateRange(SHEET, `G${c.rowIndex}`, [[newBalance]]);
  await sheets.updateRange(SHEET, `L${c.rowIndex}`, [[now]]);
  invalidateCache();
  return true;
}

async function updateRow(customerId, fields) {
  const c = await findById(customerId);
  if (!c) return false;
  const now = new Date().toISOString();
  const updated = { ...c, ...fields, updated_at: now };
  await sheets.updateRange(SHEET, `A${c.rowIndex}:M${c.rowIndex}`, [[
    updated.customer_id, updated.name, updated.phone, updated.address,
    updated.category, updated.credit_limit, updated.outstanding_balance,
    updated.payment_terms, updated.notes, updated.status, updated.created_at, now,
    JSON.stringify(updated.aliases || []),
  ]]);
  invalidateCache();
  return true;
}

module.exports = {
  getAll, findById, findByName, searchByName,
  append, updateOutstanding, updateRow, invalidateCache, SHEET,
};
