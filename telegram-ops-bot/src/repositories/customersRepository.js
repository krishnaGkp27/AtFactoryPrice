/**
 * Data access for Customers sheet (full CRM).
 */

const sheets = require('./sheetsClient');

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
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:L');
  return rows.map((r, i) => parse(r, i + 2)).filter((c) => c.customer_id || c.name);
}

async function findById(customerId) {
  const all = await getAll();
  return all.find((c) => c.customer_id === customerId) || null;
}

async function findByName(name) {
  const all = await getAll();
  const n = (name || '').toLowerCase();
  return all.find((c) => c.name.toLowerCase() === n) || null;
}

async function searchByName(query) {
  const all = await getAll();
  const q = (query || '').toLowerCase();
  return all.filter((c) => c.name.toLowerCase().includes(q));
}

async function append(customer) {
  const now = new Date().toISOString();
  await sheets.appendRows(SHEET, [[
    customer.customer_id, customer.name, customer.phone || '', customer.address || '',
    customer.category || 'Retail', customer.credit_limit || 0, customer.outstanding_balance || 0,
    customer.payment_terms || 'COD', customer.notes || '', customer.status || 'Active',
    now, now,
  ]]);
}

async function updateOutstanding(customerId, newBalance) {
  const c = await findById(customerId);
  if (!c) return false;
  const now = new Date().toISOString();
  await sheets.updateRange(SHEET, `G${c.rowIndex}`, [[newBalance]]);
  await sheets.updateRange(SHEET, `L${c.rowIndex}`, [[now]]);
  return true;
}

async function updateRow(customerId, fields) {
  const c = await findById(customerId);
  if (!c) return false;
  const now = new Date().toISOString();
  const updated = { ...c, ...fields, updated_at: now };
  await sheets.updateRange(SHEET, `A${c.rowIndex}:L${c.rowIndex}`, [[
    updated.customer_id, updated.name, updated.phone, updated.address,
    updated.category, updated.credit_limit, updated.outstanding_balance,
    updated.payment_terms, updated.notes, updated.status, updated.created_at, now,
  ]]);
  return true;
}

module.exports = { getAll, findById, findByName, searchByName, append, updateOutstanding, updateRow, SHEET };
