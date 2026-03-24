/**
 * Data access for Transactions sheet.
 * Columns A-O: ... SaleRefId
 * Columns P-Q: PricePerYard, AmountPaid (sale enrichment; unit foundation: yard for now)
 */

const sheets = require('./sheetsClient');

const SHEET = 'Transactions';
const HEADERS = ['Timestamp', 'User', 'Action', 'Design', 'Color', 'Qty', 'Before', 'After', 'Status',
  'SalesDate', 'Warehouse', 'CustomerName', 'SalesPerson', 'PaymentMode', 'SaleRefId', 'PricePerYard', 'AmountPaid'];

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:Q1');
  if (!rows.length || rows[0].length < 17) {
    await sheets.updateRange(SHEET, 'A1:Q1', [HEADERS]);
  }
}

async function append(record) {
  await ensureHeader();
  const row = [
    record.timestamp || new Date().toISOString(),
    record.user ?? '',
    record.action ?? '',
    record.design ?? '',
    record.color ?? '',
    record.qty ?? '',
    record.before ?? '',
    record.after ?? '',
    record.status ?? 'completed',
    record.salesDate ?? '',
    record.warehouse ?? '',
    record.customerName ?? '',
    record.salesPerson ?? '',
    record.paymentMode ?? '',
    record.saleRefId ?? '',
    record.pricePerYard ?? '',
    record.amountPaid ?? '',
  ];
  await sheets.appendRows(SHEET, [row]);
  return record;
}

/** Parse a Transactions row (A=0) to object. */
function parseRow(r) {
  return {
    timestamp: (r[0] || '').toString(),
    user: (r[1] || '').toString(),
    action: (r[2] || '').toString(),
    design: (r[3] || '').toString(),
    color: (r[4] || '').toString(),
    qty: parseFloat(r[5]) || 0,
    before: (r[6] || '').toString(),
    after: (r[7] || '').toString(),
    status: (r[8] || '').toString(),
    salesDate: (r[9] || '').toString(),
    warehouse: (r[10] || '').toString(),
    customerName: (r[11] || '').toString(),
    salesPerson: (r[12] || '').toString(),
    paymentMode: (r[13] || '').toString(),
    saleRefId: (r[14] || '').toString(),
    pricePerYard: parseFloat(r[15]) || 0,
    amountPaid: parseFloat(r[16]) || 0,
  };
}

/** Get last N transaction rows (oldest to newest of the last N). */
async function getLast(n) {
  await ensureHeader();
  const rows = await sheets.readRange(SHEET, 'A2:Q');
  if (!rows.length) return [];
  const lastRows = rows.slice(-Math.max(1, parseInt(n, 10) || 1));
  return lastRows.map((r) => parseRow(r));
}

/** Update status of a transaction row by matching timestamp + user + action (last matching row). */
async function setStatusReverted(timestamp, user, action) {
  const rows = await sheets.readRange(SHEET, 'A2:Q');
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]) === String(timestamp) && String(rows[i][1]) === String(user) && String(rows[i][2]) === String(action)) {
      const rowIndex = i + 2;
      await sheets.updateRange(SHEET, `I${rowIndex}`, [['reverted']]);
      return true;
    }
  }
  return false;
}

async function getCustomersByDesign(design) {
  await ensureHeader();
  const rows = await sheets.readRange(SHEET, 'A2:Q');
  const d = (design || '').toString().toUpperCase().trim();
  const customers = new Set();
  for (const r of rows) {
    const rowDesign = (r[3] || '').toString().toUpperCase().trim();
    const customer = (r[11] || '').toString().trim();
    if (rowDesign === d && customer) customers.add(customer);
  }
  return Array.from(customers);
}

module.exports = { append, ensureHeader, HEADERS, getLast, parseRow, setStatusReverted, getCustomersByDesign };
