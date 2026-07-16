/**
 * Data access for Contacts sheet (phonebook: worker, agent, supplier, etc.).
 * Customers sheet remains for sales/CRM; Contacts is for any contact type.
 *
 * CNET-1a — the sheet is now the NODE registry of the contact network:
 * columns H-L appended (whatsapp, customer_id, status, updated_by,
 * updated_at; schemaMapper self-heals the header), update() added (the
 * repo was append-only — supplier phones could literally never be filled
 * in), and phones normalize to one canonical shape on every write.
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');
const phone = require('../utils/phone');

const SHEET = 'Contacts';
const TYPES = ['worker', 'customer', 'agent', 'supplier', 'other'];

const CACHE_TTL_MS = 30 * 1000;
let _cache = null;
let _cacheTs = 0;
function invalidateCache() { _cache = null; _cacheTs = 0; }

function str(v) { return (v ?? '').toString().trim(); }

function parse(r, rowIndex) {
  return {
    rowIndex,
    contact_id: str(r[0]),
    name: str(r[1]),
    phone: str(r[2]),
    type: str(r[3]) || 'other',
    address: str(r[4]),
    notes: str(r[5]),
    created_at: str(r[6]),
    whatsapp: str(r[7]),
    customer_id: str(r[8]),
    status: str(r[9]) || 'active',
    updated_by: str(r[10]),
    updated_at: str(r[11]),
  };
}

async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return [..._cache];
  const rows = await sheets.readRange(SHEET, 'A2:L');
  _cache = rows.map((r, i) => parse(r, i + 2)).filter((c) => c.contact_id || c.name);
  _cacheTs = Date.now();
  return [..._cache];
}

async function getByType(type) {
  const all = await getAll();
  return all.filter((c) => c.type.toLowerCase() === (type || '').toLowerCase());
}

async function searchByName(query) {
  const all = await getAll();
  const q = (query || '').toLowerCase();
  return all.filter((c) => c.name.toLowerCase().includes(q));
}

async function findById(contactId) {
  const all = await getAll();
  return all.find((c) => c.contact_id === str(contactId)) || null;
}

async function findByCustomerId(customerId) {
  const all = await getAll();
  return all.find((c) => c.customer_id === str(customerId)) || null;
}

/** First contact whose number matches (last-10-digit equality). */
async function findByPhone(rawPhone) {
  if (!str(rawPhone)) return null;
  const all = await getAll();
  return all.find((c) => phone.samePhone(c.phone, rawPhone) || phone.samePhone(c.whatsapp, rawPhone)) || null;
}

async function append(contact) {
  const contactId = contact.contact_id || idGenerator.generate('CON');
  const now = new Date().toISOString();
  const type = (contact.type || 'other').toLowerCase();
  const validType = TYPES.includes(type) ? type : 'other';
  await sheets.appendRows(SHEET, [[
    contactId, contact.name || '', phone.toStored(contact.phone),
    validType, contact.address || '', contact.notes || '', now,
    phone.toStored(contact.whatsapp), contact.customer_id || '',
    contact.status || 'active', contact.updated_by || '', now,
  ]]);
  invalidateCache();
  return { ...contact, contact_id: contactId };
}

/**
 * Patch an existing contact by contact_id. Only supplied fields change;
 * contact_id (A) and created_at (G) are never rewritten. Phones normalize.
 */
async function update(contactId, patch, updatedBy) {
  const row = await findById(contactId);
  if (!row) return null;
  const merged = { ...row, ...patch };
  if (patch.phone !== undefined) merged.phone = phone.toStored(patch.phone);
  if (patch.whatsapp !== undefined) merged.whatsapp = phone.toStored(patch.whatsapp);
  const type = (merged.type || 'other').toLowerCase();
  merged.type = TYPES.includes(type) ? type : 'other';
  const now = new Date().toISOString();
  await sheets.batchUpdateRanges(SHEET, [
    { range: `B${row.rowIndex}:F${row.rowIndex}`, values: [[merged.name, merged.phone, merged.type, merged.address, merged.notes]] },
    { range: `H${row.rowIndex}:L${row.rowIndex}`, values: [[merged.whatsapp, merged.customer_id, merged.status || 'active', str(updatedBy), now]] },
  ]);
  invalidateCache();
  return { ...merged, updated_by: str(updatedBy), updated_at: now };
}

module.exports = { getAll, getByType, searchByName, findById, findByCustomerId, findByPhone, append, update, invalidateCache, SHEET, TYPES };
