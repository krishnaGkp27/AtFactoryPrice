/**
 * Data access for Transactions sheet.
 * Columns A-O: ... SaleRefId
 * Columns P-Q: PricePerYard, AmountPaid (sale enrichment; unit foundation: yard for now)
 */

const sheets = require('./sheetsClient');
const { normalizeSalesDate } = require('../utils/dates');

const SHEET = 'Transactions';
const HEADERS = ['Timestamp', 'User', 'Action', 'Design', 'Color', 'Qty', 'Before', 'After', 'Status',
  'SalesDate', 'Warehouse', 'CustomerName', 'SalesPerson', 'PaymentMode', 'SaleRefId', 'PricePerYard', 'AmountPaid',
  // SELL-T2 (owner 21-Jul): backdated stamp, e.g. 'BACKDATED-10d' — end
  // column per sheet rules. '' for normal sales.
  'Backdated'];

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:R1');
  if (!rows.length || rows[0].length < 18) {
    await sheets.updateRange(SHEET, 'A1:R1', [HEADERS]);
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
    // SDN-1: normalise any incoming shape (typed natural-language, ISO,
    // DMY numeric, monthname) to ISO YYYY-MM-DD so the Transactions
    // sheet stays consistent and downstream sales reports keep working.
    (record.salesDate != null && record.salesDate !== '') ? (normalizeSalesDate(record.salesDate) || record.salesDate) : '',
    record.warehouse ?? '',
    record.customerName ?? '',
    record.salesPerson ?? '',
    record.paymentMode ?? '',
    record.saleRefId ?? '',
    record.pricePerYard ?? '',
    record.amountPaid ?? '',
    backdatedStamp(record),
  ];
  await sheets.appendRows(SHEET, [row]);
  // SELL-T2 — a stamped backdated sale also leaves an AuditLog trail
  // (who recorded it, sale date vs recording date). Best-effort.
  const stamp = row[17];
  if (stamp) {
    try {
      await require('./auditLogRepository').append('backdated_sale_recorded',
        { stamp, salesDate: row[9], action: record.action, customer: record.customerName || '', saleRefId: record.saleRefId || '' },
        record.user || '');
    } catch (_) { /* audit is best-effort */ }
  }
  return record;
}

/**
 * SELL-T2 (owner rule 21-Jul): a SALE recorded with a sales date BEYOND
 * yesterday is stamped BACKDATED-<n>d in the permanent record. Central
 * here so every sale path (typed, tap flow, snap, PDF batch) gets the
 * stamp without per-caller plumbing. Non-sale rows are never stamped.
 */
function backdatedStamp(record) {
  if (record.backdated !== undefined && record.backdated !== null && record.backdated !== '') {
    return String(record.backdated);
  }
  if (!/^(sell|sale)/i.test(String(record.action || ''))) return '';
  const iso = normalizeSalesDate(record.salesDate);
  if (!iso) return '';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
  const days = Math.round((Date.parse(today) - Date.parse(iso)) / 86400000);
  return days >= 2 ? `BACKDATED-${days}d` : '';
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
    backdated: (r[17] || '').toString(),
  };
}

/** Get last N transaction rows (oldest to newest of the last N). */
async function getLast(n) {
  await ensureHeader();
  const rows = await sheets.readRange(SHEET, 'A2:R');
  if (!rows.length) return [];
  const lastRows = rows.slice(-Math.max(1, parseInt(n, 10) || 1));
  return lastRows.map((r) => parseRow(r));
}

/** Update status of a transaction row by matching timestamp + user + action (last matching row). */
async function setStatusReverted(timestamp, user, action) {
  const rows = await sheets.readRange(SHEET, 'A2:R');
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
  const d = (design || '').toString().toUpperCase().trim();
  const customers = new Set();

  // Source 1: Inventory sheet — SoldTo column for sold items with matching design
  try {
    const invRows = await sheets.readRange('Inventory', 'A2:P');
    for (const r of invRows) {
      const rowDesign = (r[3] || '').toString().toUpperCase().trim();
      const soldTo = (r[11] || '').toString().trim();
      const status = (r[7] || '').toString().toLowerCase().trim();
      if (rowDesign === d && status === 'sold' && soldTo) customers.add(soldTo);
    }
  } catch (_) {}

  // Source 2: Transactions sheet — CustomerName column for matching design
  try {
    await ensureHeader();
    const txnRows = await sheets.readRange(SHEET, 'A2:R');
    for (const r of txnRows) {
      const rowDesign = (r[3] || '').toString().toUpperCase().trim();
      const customer = (r[11] || '').toString().trim();
      if (rowDesign === d && customer) customers.add(customer);
    }
  } catch (_) {}

  return Array.from(customers);
}

module.exports = { append, ensureHeader, HEADERS, getLast, parseRow, setStatusReverted, getCustomersByDesign };
