/**
 * Data access for Stock_Ledger sheet (append-only movement log).
 */

const sheets = require('./sheetsClient');

const SHEET = 'Stock_Ledger';

function parse(r) {
  return {
    entry_id: (r[0] || '').toString().trim(),
    date: (r[1] || '').toString().trim(),
    item_id: (r[2] || '').toString().trim(),
    package_no: (r[3] || '').toString().trim(),
    branch: (r[4] || '').toString().trim(),
    type: (r[5] || '').toString().trim(),
    qty_in: parseFloat(r[6]) || 0,
    qty_out: parseFloat(r[7]) || 0,
    reference_id: (r[8] || '').toString().trim(),
    created_at: (r[9] || '').toString().trim(),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:J');
  return rows.map(parse).filter((r) => r.entry_id);
}

async function append(entry) {
  await sheets.appendRows(SHEET, [[
    entry.entry_id, entry.date, entry.item_id, entry.package_no || '',
    entry.branch || '', entry.type || '', entry.qty_in || 0, entry.qty_out || 0,
    entry.reference_id || '', entry.created_at || new Date().toISOString(),
  ]]);
}

async function findByItem(itemId, branch) {
  const all = await getAll();
  return all.filter((r) => r.item_id === itemId && (!branch || r.branch === branch));
}

module.exports = { getAll, append, findByItem, SHEET };
