/**
 * Data access for Inventory sheet.
 * Sheet columns: Design | Color | Bale | Qty | Price | Warehouse | UpdatedAt
 */

const sheets = require('./sheetsClient');

const SHEET = 'Inventory';
const HEADERS = ['Design', 'Color', 'Bale', 'Qty', 'Price', 'Warehouse', 'UpdatedAt'];

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  return rows.map((r) => ({
    design: (r[0] || '').toString().trim(),
    color: (r[1] || '').toString().trim(),
    bale: (r[2] || '').toString().trim(),
    qty: parseFloat(r[3]) || 0,
    price: parseFloat(r[4]) || 0,
    warehouse: (r[5] || '').toString().trim(),
    updatedAt: (r[6] || '').toString().trim(),
  })).filter((r) => r.design || r.warehouse);
}

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:G1');
  if (!rows.length || rows[0].length < 7) {
    await sheets.updateRange(SHEET, 'A1:G1', [HEADERS]);
  }
}

async function findRow(design, color, warehouse) {
  const rows = await sheets.readRange(SHEET, 'A2:G');
  const d = (design || '').toString().trim().toUpperCase();
  const c = (color || '').toString().trim().toUpperCase();
  const w = (warehouse || '').toString().trim();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowDesign = (row[0] || '').toString().trim().toUpperCase();
    const rowColor = (row[1] || '').toString().trim().toUpperCase();
    const rowWarehouse = (row[5] || '').toString().trim();
    if (rowDesign === d && rowColor === c && rowWarehouse === w) {
      return { rowIndex: i + 2, row }; // 1-based + header
    }
  }
  return null;
}

async function updateQty(design, color, warehouse, newQty) {
  const found = await findRow(design, color, warehouse);
  const updatedAt = new Date().toISOString();
  if (found) {
    const { rowIndex } = found;
    const row = found.row;
    const qty = parseFloat(newQty);
    const price = parseFloat(row[4]) || 0;
    await sheets.updateRange(SHEET, `D${rowIndex}:G${rowIndex}`, [[qty, price, warehouse, updatedAt]]);
    return { design, color, warehouse, qty, price, updatedAt };
  }
  // Append new row
  await ensureHeader();
  await sheets.appendRows(SHEET, [[design, color, '', newQty, 0, warehouse, updatedAt]]);
  return { design, color, warehouse, qty: parseFloat(newQty), price: 0, updatedAt };
}

/** Get distinct warehouse names from sheet (dynamic). */
async function getWarehouses() {
  const rows = await sheets.readRange(SHEET, 'F2:F');
  const set = new Set();
  rows.forEach((r) => {
    const w = (r[0] || '').toString().trim();
    if (w) set.add(w);
  });
  return Array.from(set).sort();
}

module.exports = {
  getAll,
  findRow,
  updateQty,
  getWarehouses,
  ensureHeader,
};
