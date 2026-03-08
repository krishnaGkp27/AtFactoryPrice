/**
 * Data access for Contacts sheet (phonebook: worker, agent, supplier, etc.).
 * Customers sheet remains for sales/CRM; Contacts is for any contact type.
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const SHEET = 'Contacts';
const TYPES = ['worker', 'customer', 'agent', 'supplier', 'other'];

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
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  return rows.map((r, i) => parse(r, i + 2)).filter((c) => c.contact_id || c.name);
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

async function append(contact) {
  const contactId = contact.contact_id || idGenerator.generate('CON');
  const now = new Date().toISOString();
  const type = (contact.type || 'other').toLowerCase();
  const validType = TYPES.includes(type) ? type : 'other';
  await sheets.appendRows(SHEET, [[
    contactId, contact.name || '', contact.phone || '',
    validType, contact.address || '', contact.notes || '', now,
  ]]);
  return { ...contact, contact_id: contactId };
}

module.exports = { getAll, getByType, searchByName, append, SHEET, TYPES };
