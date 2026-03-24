/**
 * Data access for Orders sheet — supply order lifecycle.
 * Columns A-O: order_id, design, shade, customer, quantity, salesperson_id, salesperson_name,
 *              payment_status, scheduled_date, status, created_by, created_at, accepted_at, delivered_at, reminder_sent
 */

const sheets = require('./sheetsClient');
const idGen = require('../utils/idGenerator');

const SHEET = 'Orders';
const HEADERS = [
  'order_id', 'design', 'shade', 'customer', 'quantity',
  'salesperson_id', 'salesperson_name', 'payment_status', 'scheduled_date',
  'status', 'created_by', 'created_at', 'accepted_at', 'delivered_at', 'reminder_sent',
];

function parse(r) {
  return {
    order_id: (r[0] || '').toString().trim(),
    design: (r[1] || '').toString().trim(),
    shade: (r[2] || '').toString().trim(),
    customer: (r[3] || '').toString().trim(),
    quantity: (r[4] || '').toString().trim(),
    salesperson_id: (r[5] || '').toString().trim(),
    salesperson_name: (r[6] || '').toString().trim(),
    payment_status: (r[7] || '').toString().trim(),
    scheduled_date: (r[8] || '').toString().trim(),
    status: (r[9] || '').toString().trim(),
    created_by: (r[10] || '').toString().trim(),
    created_at: (r[11] || '').toString().trim(),
    accepted_at: (r[12] || '').toString().trim(),
    delivered_at: (r[13] || '').toString().trim(),
    reminder_sent: (r[14] || '').toString().trim(),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:O');
  return rows.map(parse).filter((r) => r.order_id);
}

async function append(data) {
  const orderId = data.order_id || idGen.generate('ORD');
  const row = [
    orderId,
    data.design || '',
    data.shade || '',
    data.customer || '',
    data.quantity || '',
    data.salesperson_id || '',
    data.salesperson_name || '',
    data.payment_status || '',
    data.scheduled_date || '',
    data.status || 'pending_accept',
    data.created_by || '',
    data.created_at || new Date().toISOString(),
    '', '', '',
  ];
  await sheets.appendRows(SHEET, [row]);
  return { ...data, order_id: orderId };
}

async function getById(orderId) {
  const all = await getAll();
  return all.find((o) => o.order_id === orderId) || null;
}

async function getByAssignee(salespersonId) {
  const all = await getAll();
  return all.filter((o) => o.salesperson_id === String(salespersonId) && ['pending_accept', 'accepted'].includes(o.status));
}

async function updateStatus(orderId, status, extraFields = {}) {
  const rows = await sheets.readRange(SHEET, 'A2:O');
  const idx = rows.findIndex((r) => String(r[0]).trim() === orderId);
  if (idx === -1) return false;
  const rowIndex = idx + 2;
  const updates = [[status]];
  await sheets.updateRange(SHEET, `J${rowIndex}`, updates);
  if (extraFields.accepted_at) {
    await sheets.updateRange(SHEET, `M${rowIndex}`, [[extraFields.accepted_at]]);
  }
  if (extraFields.delivered_at) {
    await sheets.updateRange(SHEET, `N${rowIndex}`, [[extraFields.delivered_at]]);
  }
  if (extraFields.reminder_sent) {
    await sheets.updateRange(SHEET, `O${rowIndex}`, [[extraFields.reminder_sent]]);
  }
  return true;
}

async function getPendingReminders() {
  const all = await getAll();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  return all.filter((o) =>
    o.status === 'accepted' &&
    o.scheduled_date === tomorrowStr &&
    o.reminder_sent !== 'true'
  );
}

module.exports = { SHEET, HEADERS, append, getAll, getById, getByAssignee, updateStatus, getPendingReminders };
