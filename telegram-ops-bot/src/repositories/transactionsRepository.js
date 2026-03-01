/**
 * Data access for Transactions sheet.
 * Columns A-I (original): Timestamp | User | Action | Design | Color | Qty | Before | After | Status
 * Columns J-O (extended): SalesDate | Warehouse | CustomerName | SalesPerson | PaymentMode | SaleRefId
 */

const sheets = require('./sheetsClient');

const SHEET = 'Transactions';
const HEADERS = ['Timestamp', 'User', 'Action', 'Design', 'Color', 'Qty', 'Before', 'After', 'Status',
  'SalesDate', 'Warehouse', 'CustomerName', 'SalesPerson', 'PaymentMode', 'SaleRefId'];

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:O1');
  if (!rows.length || rows[0].length < 15) {
    await sheets.updateRange(SHEET, 'A1:O1', [HEADERS]);
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
  ];
  await sheets.appendRows(SHEET, [row]);
  return record;
}

module.exports = { append, ensureHeader, HEADERS };
