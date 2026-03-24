/**
 * Data access for CustomerFollowups sheet — scheduled follow-up reminders.
 * Columns A-H: followup_id, customer, reason, followup_date, status, created_by, created_at, reminder_sent
 */

const sheets = require('./sheetsClient');
const idGen = require('../utils/idGenerator');

const SHEET = 'CustomerFollowups';
const HEADERS = ['followup_id', 'customer', 'reason', 'followup_date', 'status', 'created_by', 'created_at', 'reminder_sent'];

function parse(r) {
  return {
    followup_id: (r[0] || '').toString().trim(),
    customer: (r[1] || '').toString().trim(),
    reason: (r[2] || '').toString().trim(),
    followup_date: (r[3] || '').toString().trim(),
    status: (r[4] || '').toString().trim(),
    created_by: (r[5] || '').toString().trim(),
    created_at: (r[6] || '').toString().trim(),
    reminder_sent: (r[7] || '').toString().trim(),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:H');
  return rows.map(parse).filter((r) => r.followup_id);
}

async function append(data) {
  const id = data.followup_id || idGen.generate('FUP');
  const row = [
    id, data.customer || '', data.reason || '', data.followup_date || '',
    data.status || 'pending', data.created_by || '', data.created_at || new Date().toISOString(), '',
  ];
  await sheets.appendRows(SHEET, [row]);
  return { ...data, followup_id: id };
}

async function getPendingReminders() {
  const all = await getAll();
  const today = new Date().toISOString().split('T')[0];
  return all.filter((f) => f.status === 'pending' && f.followup_date === today && f.reminder_sent !== 'true');
}

async function markDone(followupId) {
  const rows = await sheets.readRange(SHEET, 'A2:H');
  const idx = rows.findIndex((r) => String(r[0]).trim() === followupId);
  if (idx === -1) return false;
  await sheets.updateRange(SHEET, `E${idx + 2}:F${idx + 2}`, [['done', '']]);
  return true;
}

async function markReminderSent(followupId) {
  const rows = await sheets.readRange(SHEET, 'A2:H');
  const idx = rows.findIndex((r) => String(r[0]).trim() === followupId);
  if (idx === -1) return false;
  await sheets.updateRange(SHEET, `H${idx + 2}`, [['true']]);
  return true;
}

async function getByCustomer(customer) {
  const all = await getAll();
  const c = (customer || '').toLowerCase().trim();
  return all.filter((f) => f.customer.toLowerCase().trim() === c);
}

module.exports = { SHEET, HEADERS, append, getAll, getPendingReminders, markDone, markReminderSent, getByCustomer };
