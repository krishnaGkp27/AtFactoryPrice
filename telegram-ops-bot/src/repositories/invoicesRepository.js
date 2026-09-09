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
// CUR-2 — `rate_multiplier` (column W) is the LAST entry and must stay last:
// the factor the customer copy of this invoice multiplies the booked rate
// by, frozen at issue. Blank = no multiplier (never `1`); old rows read
// blank → unconverted. Every other cell on the row (lines_json, subtotal,
// total, amount_paid_at_issue, balance_after_issue) is the BOOKED variable-1
// figure — never multiplied on the sheet. Rule 4: trailing column, nothing
// renamed or reordered.
const HEADERS = [
  'invoice_no', 'token', 'request_id', 'customer_id', 'customer_name',
  'issue_date', 'sale_date', 'lines_json', 'subtotal', 'vat_rate',
  'vat_amount', 'total', 'amount_paid_at_issue', 'balance_after_issue',
  'payment_mode', 'bank', 'salesperson', 'warehouse', 'status',
  'pdf_drive_id', 'created_by', 'created_at',
  'rate_multiplier',
];
const RATE_MULTIPLIER_COL = HEADERS.indexOf('rate_multiplier'); // 22 → W

/** Column letter (A-based) for a zero-based index within the 26-column range. */
function colLetter(i) { return String.fromCharCode('A'.charCodeAt(0) + i); }
const LAST_COL = colLetter(HEADERS.length - 1);

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/**
 * CUR-2 §8 rule 11 — the ONE range check for a rate multiplier, shared by
 * the sheet (both directions) and the issue path: a finite number, > 0,
 * ≤ 1,000,000 and ≠ 1 is a multiplier; anything else (blank, `1`, 0,
 * negative, text, absurd) means NONE and returns null. `1` is "no
 * multiplier" by definition, so it is never stored — a blank cell is.
 */
function normaliseRateMultiplier(v) {
  if (v === '' || v === null || v === undefined) return null;
  // Sheets are read as FORMATTED_VALUE: a cell the owner typed as `1,250`
  // (the way every CUR-2 drawing spells the factor) comes back with its
  // grouping comma. Commas are ignored — the same rule the wizard applies
  // to a typed factor (§3b rule 2) — so a display format can never turn a
  // frozen factor into "none". Anything else non-numeric still means none.
  const m = Number(typeof v === 'string' ? v.replace(/,/g, '').trim() : v);
  if (!Number.isFinite(m) || m <= 0 || m > 1_000_000 || m === 1) return null;
  return m;
}

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
    // CUR-2 — null on old / blank rows: render unconverted, never consult
    // Settings at read time (the freeze rule, D3).
    rateMultiplier: normaliseRateMultiplier(r[RATE_MULTIPLIER_COL]),
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
    // CUR-2 — blank when none; the figures before it are booked (variable 1).
    normaliseRateMultiplier(o.rateMultiplier) ?? '',
  ];
}

let _headerReady = false;
async function ensureHeader() {
  if (_headerReady) return;
  // Both bounds derive from HEADERS (the APR-1 lesson): a live sheet that
  // already carries the 22 INV-1a columns must be WIDENED to name column W,
  // not judged complete. Only the header row (row 1) is ever written here,
  // and only the cells that are missing — existing header cells and every
  // data row are untouched.
  const rows = await sheets.readRange(SHEET, `A1:${LAST_COL}1`);
  const head = rows.length ? rows[0] : [];
  // Width = position of the last NAMED header cell + 1 (the API trims
  // trailing blanks; a blank cell inside the range still counts as width).
  let have = 0;
  head.forEach((c, i) => { if (str(c)) have = i + 1; });
  if (!have) {
    await sheets.updateRange(SHEET, `A1:${LAST_COL}1`, [HEADERS]);
  } else if (have < HEADERS.length) {
    await sheets.updateRange(SHEET, `${colLetter(have)}1:${LAST_COL}1`, [HEADERS.slice(have)]);
  }
  _headerReady = true;
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, `A2:${LAST_COL}`);
  // Map BEFORE filtering so `i` indexes the SHEET, not the filtered array —
  // otherwise every rowIndex is short by the number of blank rows above it,
  // and a write aimed at that rowIndex would land on the wrong invoice. This
  // is the order every other rowIndex-tracking repo uses (customers,
  // receipts, attendance, stockTakes). fromRow normalises invoiceNo with
  // str(), so filtering on the parsed field matches the old predicate.
  return rows.map((r, i) => fromRow(r, i + 2)).filter((x) => x.invoiceNo);
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

module.exports = {
  SHEET, HEADERS, ensureHeader, getAll, append, getByToken, getByRequestId,
  maxSeqForYear, updateStatus, setPdfDriveId, normaliseRateMultiplier,
  /** @internal test seam — the header guard is per-process. */
  _resetHeaderGuard: () => { _headerReady = false; },
};
