'use strict';

/**
 * INV-1a — Invoices sheet: one row per issued customer invoice.
 *
 * The row is the durable record BEHIND the customer-facing surfaces (PDF,
 * /i/<token> web view): line items frozen as JSON at issue time, totals,
 * the issue-time paid/balance snapshot, and the access token. Live status
 * shown to customers is recomputed from the ledger at read time — never
 * from this snapshot.
 *
 * invoice_no is minted by invoiceService under a mutex from MAX(existing)+1
 * for the current year — NEVER from idGenerator (its in-memory daily counter
 * resets on restart; invoice numbers must not collide or reset).
 */

const sheets = require('./sheetsClient');

const SHEET = 'Invoices';
const HEADERS = [
  'invoice_no', 'token', 'request_id', 'customer_id', 'customer_name',
  'issue_date', 'sale_date', 'lines_json', 'subtotal', 'vat_rate',
  'vat_amount', 'total', 'amount_paid_at_issue', 'balance_after_issue',
  'payment_mode', 'bank', 'salesperson', 'warehouse', 'status',
  'pdf_drive_id', 'created_by', 'created_at',
];

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function fromRow(r, rowIndex) {
  let lines = [];
  try { lines = JSON.parse(r[7] || '[]'); } catch { lines = []; }
  return {
    rowIndex,
    invoiceNo: str(r[0]), token: str(r[1]), requestId: str(r[2]),
    customerId: str(r[3]), customerName: str(r[4]),
    issueDate: str(r[5]), saleDate: str(r[6]),
    lines,
    subtotal: num(r[8]), vatRate: num(r[9]), vatAmount: num(r[10]), total: num(r[11]),
    amountPaidAtIssue: num(r[12]), balanceAfterIssue: r[13] === '' ? null : num(r[13]),
    paymentMode: str(r[14]), bank: str(r[15]), salesperson: str(r[16]), warehouse: str(r[17]),
    status: str(r[18]) || 'issued', pdfDriveId: str(r[19]),
    createdBy: str(r[20]), createdAt: str(r[21]),
  };
}

function toRow(o) {
  return [
    o.invoiceNo, o.token, o.requestId, o.customerId || '', o.customerName,
    o.issueDate, o.saleDate || '', JSON.stringify(o.lines || []),
    o.subtotal, o.vatRate || 0, o.vatAmount || 0, o.total,
    o.amountPaidAtIssue || 0, o.balanceAfterIssue ?? '',
    o.paymentMode || '', o.bank || '', o.salesperson || '', o.warehouse || '',
    o.status || 'issued', o.pdfDriveId || '', o.createdBy || '', o.createdAt,
  ];
}

let _headerReady = false;
async function ensureHeader() {
  if (_headerReady) return;
  const rows = await sheets.readRange(SHEET, 'A1:V1');
  if (!rows.length || !str(rows[0][0])) {
    await sheets.updateRange(SHEET, 'A1', [HEADERS]);
  }
  _headerReady = true;
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:V');
  return rows.filter((r) => str(r[0])).map((r, i) => fromRow(r, i + 2));
}

async function append(record) {
  await ensureHeader();
  await sheets.appendRows(SHEET, [toRow(record)]);
  return record;
}

async function getByToken(token) {
  if (!token) return null;
  const all = await getAll();
  return all.find((r) => r.token === token) || null;
}

async function getByRequestId(requestId) {
  if (!requestId) return null;
  const all = await getAll();
  return all.find((r) => r.requestId === requestId) || null;
}

/** Highest sequence already used for `year` (0 when none). */
async function maxSeqForYear(year) {
  const all = await getAll();
  const re = new RegExp(`^INV-${year}-(\\d+)$`);
  return all.reduce((max, r) => {
    const m = re.exec(r.invoiceNo);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
}

async function updateStatus(rowIndex, status) {
  await sheets.updateRange(SHEET, `S${rowIndex}`, [[status]]);
}

async function setPdfDriveId(rowIndex, driveId) {
  await sheets.updateRange(SHEET, `T${rowIndex}`, [[driveId]]);
}

module.exports = { SHEET, HEADERS, ensureHeader, getAll, append, getByToken, getByRequestId, maxSeqForYear, updateStatus, setPdfDriveId };
