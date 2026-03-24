/**
 * Data access for Samples sheet — sample tracking lifecycle.
 * Columns A-N: sample_id, design, shade, sample_type, customer, quantity,
 *              date_given, followup_date, status, updated_by, created_at, updated_at, notes, reminder_sent
 */

const sheets = require('./sheetsClient');
const idGen = require('../utils/idGenerator');

const SHEET = 'Samples';
const HEADERS = [
  'sample_id', 'design', 'shade', 'sample_type', 'customer', 'quantity',
  'date_given', 'followup_date', 'status', 'updated_by',
  'created_at', 'updated_at', 'notes', 'reminder_sent',
];

function parse(r) {
  return {
    sample_id: (r[0] || '').toString().trim(),
    design: (r[1] || '').toString().trim(),
    shade: (r[2] || '').toString().trim(),
    sample_type: (r[3] || '').toString().trim(),
    customer: (r[4] || '').toString().trim(),
    quantity: (r[5] || '').toString().trim(),
    date_given: (r[6] || '').toString().trim(),
    followup_date: (r[7] || '').toString().trim(),
    status: (r[8] || '').toString().trim(),
    updated_by: (r[9] || '').toString().trim(),
    created_at: (r[10] || '').toString().trim(),
    updated_at: (r[11] || '').toString().trim(),
    notes: (r[12] || '').toString().trim(),
    reminder_sent: (r[13] || '').toString().trim(),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:N');
  return rows.map(parse).filter((r) => r.sample_id);
}

async function append(data) {
  const sampleId = data.sample_id || idGen.generate('SMP');
  const now = new Date().toISOString();
  const row = [
    sampleId,
    data.design || '',
    data.shade || '',
    data.sample_type || '',
    data.customer || '',
    data.quantity || '1',
    data.date_given || now.split('T')[0],
    data.followup_date || '',
    data.status || 'with_customer',
    data.updated_by || '',
    now, now,
    data.notes || '',
    '',
  ];
  await sheets.appendRows(SHEET, [row]);
  return { ...data, sample_id: sampleId };
}

async function getById(sampleId) {
  const all = await getAll();
  return all.find((s) => s.sample_id === sampleId) || null;
}

async function getActive() {
  const all = await getAll();
  return all.filter((s) => s.status === 'with_customer');
}

async function getByDesign(design) {
  const all = await getAll();
  const d = (design || '').toUpperCase().trim();
  return all.filter((s) => s.design.toUpperCase().trim() === d);
}

async function getByCustomer(customer) {
  const all = await getAll();
  const c = (customer || '').toLowerCase().trim();
  return all.filter((s) => s.customer.toLowerCase().trim() === c && s.status === 'with_customer');
}

async function updateStatus(sampleId, status, updatedBy, notes) {
  const rows = await sheets.readRange(SHEET, 'A2:N');
  const idx = rows.findIndex((r) => String(r[0]).trim() === sampleId);
  if (idx === -1) return false;
  const rowIndex = idx + 2;
  const now = new Date().toISOString();
  await sheets.updateRange(SHEET, `I${rowIndex}:N${rowIndex}`, [[
    status, updatedBy || '', rows[idx][10] || '', now, notes || rows[idx][12] || '', status !== 'with_customer' ? 'true' : '',
  ]]);
  return true;
}

async function getPendingFollowups() {
  const all = await getAll();
  const today = new Date().toISOString().split('T')[0];
  return all.filter((s) =>
    s.status === 'with_customer' &&
    s.followup_date === today &&
    s.reminder_sent !== 'true'
  );
}

async function markReminderSent(sampleId) {
  const rows = await sheets.readRange(SHEET, 'A2:N');
  const idx = rows.findIndex((r) => String(r[0]).trim() === sampleId);
  if (idx === -1) return false;
  const rowIndex = idx + 2;
  await sheets.updateRange(SHEET, `N${rowIndex}`, [['true']]);
  return true;
}

module.exports = { SHEET, HEADERS, append, getAll, getById, getActive, getByDesign, getByCustomer, updateStatus, getPendingFollowups, markReminderSent };
