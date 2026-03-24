/**
 * Data access for CustomerNotes sheet — freeform notes per customer.
 * Columns A-E: note_id, customer, note, created_by, created_at
 */

const sheets = require('./sheetsClient');
const idGen = require('../utils/idGenerator');

const SHEET = 'CustomerNotes';
const HEADERS = ['note_id', 'customer', 'note', 'created_by', 'created_at'];

function parse(r) {
  return {
    note_id: (r[0] || '').toString().trim(),
    customer: (r[1] || '').toString().trim(),
    note: (r[2] || '').toString().trim(),
    created_by: (r[3] || '').toString().trim(),
    created_at: (r[4] || '').toString().trim(),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:E');
  return rows.map(parse).filter((r) => r.note_id);
}

async function append(data) {
  const id = data.note_id || idGen.generate('NOTE');
  const row = [
    id, data.customer || '', data.note || '', data.created_by || '',
    data.created_at || new Date().toISOString(),
  ];
  await sheets.appendRows(SHEET, [row]);
  return { ...data, note_id: id };
}

async function getByCustomer(customer) {
  const all = await getAll();
  const c = (customer || '').toLowerCase().trim();
  return all.filter((n) => n.customer.toLowerCase().trim() === c);
}

module.exports = { SHEET, HEADERS, append, getAll, getByCustomer };
