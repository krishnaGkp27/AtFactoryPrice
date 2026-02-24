/**
 * Stock ledger service: records movements and computes dynamic stock levels.
 */

const stockLedgerRepo = require('../repositories/stockLedgerRepository');
const idGen = require('../utils/idGenerator');
const stockCalc = require('../utils/stockCalculator');

function itemId(design, shade) {
  return `${(design || '').toString().trim()}-${(shade || '').toString().trim()}`.toUpperCase();
}

async function recordSaleOut({ packageNo, design, shade, warehouse, yards, thanNo, txnId }) {
  await stockLedgerRepo.append({
    entry_id: idGen.stockLedger(),
    date: new Date().toISOString().split('T')[0],
    item_id: itemId(design, shade),
    package_no: packageNo || '',
    branch: warehouse || '',
    type: 'sale_out',
    qty_in: 0,
    qty_out: yards || 0,
    reference_id: txnId || `${packageNo}-T${thanNo || 'all'}`,
    created_at: new Date().toISOString(),
  });
}

async function recordReturnIn({ packageNo, design, shade, warehouse, yards, thanNo, txnId }) {
  await stockLedgerRepo.append({
    entry_id: idGen.stockLedger(),
    date: new Date().toISOString().split('T')[0],
    item_id: itemId(design, shade),
    package_no: packageNo || '',
    branch: warehouse || '',
    type: 'return_in',
    qty_in: yards || 0,
    qty_out: 0,
    reference_id: txnId || `${packageNo}-T${thanNo || 'all'}`,
    created_at: new Date().toISOString(),
  });
}

async function recordPurchaseIn({ packageNo, design, shade, warehouse, yards, txnId }) {
  await stockLedgerRepo.append({
    entry_id: idGen.stockLedger(),
    date: new Date().toISOString().split('T')[0],
    item_id: itemId(design, shade),
    package_no: packageNo || '',
    branch: warehouse || '',
    type: 'purchase_in',
    qty_in: yards || 0,
    qty_out: 0,
    reference_id: txnId || packageNo || '',
    created_at: new Date().toISOString(),
  });
}

async function computeStock(design, shade, branch) {
  const id = itemId(design, shade);
  const rows = await stockLedgerRepo.findByItem(id, branch);
  return stockCalc.getAvailable(rows, id, branch);
}

async function computeAllStock() {
  const all = await stockLedgerRepo.getAll();
  return stockCalc.computeStock(all);
}

module.exports = { recordSaleOut, recordReturnIn, recordPurchaseIn, computeStock, computeAllStock, itemId };
