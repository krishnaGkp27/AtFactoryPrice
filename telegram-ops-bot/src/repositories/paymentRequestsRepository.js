'use strict';

/**
 * PAY-1 — sole owner of the `PaymentRequests` sheet: the ledger of money
 * leaving the business.
 *
 * One row per request, carrying the whole life of it: who asked, who
 * approved (both names), who actually made the transfer at the bank, and
 * when. The bot never moves money — this sheet is the record that it was
 * moved, and by whom.
 *
 * Account details are SNAPSHOT at raise time (D–F) rather than looked up
 * later through account_id. A payee who corrects their account number
 * next month must not silently rewrite what the business paid last
 * month; history has to keep saying where the money actually went.
 *
 * Columns
 *   A payment_id           PAY-…
 *   B payee_name           C payee_type ('employee' | 'contractor')
 *   D account_id           E account_number (TEXT)      F bank
 *   G amount_ngn           H above_threshold ('1' | '')
 *   I raised_by            J raised_at (ISO)
 *   K approval_request_id  L approved_by ("A ‖ B")
 *   M status               'pending_approval' | 'approved' | 'done'
 *                          | 'declined' | 'rejected'
 *   N bill_file_id         optional evidence attached when raising
 *   O proof_file_id        optional transfer proof attached at Mark Done
 *   P done_by              Q done_at (Lagos wall-clock)
 *   R decline_reason       required text when finance declines
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const SHEET = 'PaymentRequests';
const HEADERS = [
  'payment_id', 'payee_name', 'payee_type',
  'account_id', 'account_number', 'bank',
  'amount_ngn', 'above_threshold',
  'raised_by', 'raised_at',
  'approval_request_id', 'approved_by', 'status',
  'bill_file_id', 'proof_file_id',
  'done_by', 'done_at', 'decline_reason',
];

const STATUSES = ['pending_approval', 'approved', 'done', 'declined', 'rejected'];

const CACHE_TTL_MS = 10 * 1000;
let _cache = null;
let _cacheTs = 0;
function invalidateCache() { _cache = null; _cacheTs = 0; }

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0; }

function parse(r, rowIndex) {
  const status = str(r[12]).toLowerCase();
  return {
    rowIndex,
    payment_id: str(r[0]),
    payee_name: str(r[1]),
    payee_type: str(r[2]) || 'employee',
    account_id: str(r[3]),
    account_number: str(r[4]),
    bank: str(r[5]),
    amount_ngn: num(r[6]),
    above_threshold: str(r[7]) === '1',
    raised_by: str(r[8]),
    raised_at: str(r[9]),
    approval_request_id: str(r[10]),
    approved_by: str(r[11]),
    // An unreadable status reads as still-awaiting-approval — the state
    // in which nothing has been authorised and nothing can be paid.
    status: STATUSES.includes(status) ? status : 'pending_approval',
    bill_file_id: str(r[13]),
    proof_file_id: str(r[14]),
    done_by: str(r[15]),
    done_at: str(r[16]),
    decline_reason: str(r[17]),
  };
}

let _headerReady = false;
async function ensureHeader() {
  if (_headerReady) return;
  const rows = await sheets.readRange(SHEET, 'A1:R1');
  if (!rows.length || (rows[0] || []).length < HEADERS.length) {
    await sheets.updateRange(SHEET, 'A1:R1', [HEADERS]);
  }
  _headerReady = true;
}

async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return [..._cache];
  let rows;
  try {
    rows = await sheets.readRange(SHEET, 'A2:R');
  } catch (_) {
    return [];
  }
  _cache = (rows || []).map((r, i) => parse(r, i + 2)).filter((p) => p.payment_id);
  _cacheTs = now;
  return [..._cache];
}

async function findById(paymentId) {
  if (!paymentId) return null;
  return (await getAll()).find((p) => p.payment_id === String(paymentId)) || null;
}

async function findByApprovalRequestId(requestId) {
  if (!requestId) return null;
  return (await getAll()).find((p) => p.approval_request_id === String(requestId)) || null;
}

/** One person's requests, newest first — the "My requests" screen. */
async function forRaiser(telegramId) {
  const id = str(telegramId);
  if (!id) return [];
  return (await getAll())
    .filter((p) => p.raised_by === id)
    .sort((a, b) => String(b.raised_at).localeCompare(String(a.raised_at)));
}

/** Approved but not yet paid — the finance head's queue. */
async function awaitingPayment() {
  return (await getAll())
    .filter((p) => p.status === 'approved')
    .sort((a, b) => String(a.raised_at).localeCompare(String(b.raised_at)));
}

async function append(entry) {
  await ensureHeader();
  const paymentId = entry.payment_id || idGenerator.generate('PAY');
  const now = entry.raised_at || new Date().toISOString();
  await sheets.appendRows(SHEET, [[
    paymentId,
    str(entry.payee_name),
    str(entry.payee_type) || 'employee',
    str(entry.account_id),
    // TEXT, for the same reason as the register: leading zeros are real.
    entry.account_number ? `'${String(entry.account_number).replace(/\D/g, '')}` : '',
    str(entry.bank),
    Number(entry.amount_ngn) || 0,
    entry.above_threshold ? '1' : '',
    str(entry.raised_by),
    now,
    str(entry.approval_request_id),
    str(entry.approved_by),
    entry.status || 'pending_approval',
    str(entry.bill_file_id),
    str(entry.proof_file_id),
    str(entry.done_by),
    str(entry.done_at),
    str(entry.decline_reason),
  ]]);
  invalidateCache();
  return { ...entry, payment_id: paymentId, raised_at: now };
}

/**
 * Patch a request's lifecycle fields. Only the columns a caller names are
 * written; the raise-time snapshot (A–J) is never touched here, so no
 * later step can rewrite what was asked for or who asked.
 *
 * @param {object} patch {status, approved_by, proof_file_id, done_by, done_at, decline_reason}
 */
async function update(paymentId, patch = {}) {
  const row = await findById(paymentId);
  if (!row) return null;
  const merged = { ...row, ...patch };
  if (patch.status !== undefined) {
    const s = String(patch.status).toLowerCase();
    merged.status = STATUSES.includes(s) ? s : row.status;
  }
  await sheets.batchUpdateRanges(SHEET, [
    { range: `L${row.rowIndex}:M${row.rowIndex}`, values: [[str(merged.approved_by), merged.status]] },
    {
      range: `O${row.rowIndex}:R${row.rowIndex}`,
      values: [[
        str(merged.proof_file_id), str(merged.done_by),
        str(merged.done_at), str(merged.decline_reason),
      ]],
    },
  ]);
  invalidateCache();
  return merged;
}

module.exports = {
  SHEET,
  HEADERS,
  STATUSES,
  getAll,
  findById,
  findByApprovalRequestId,
  forRaiser,
  awaitingPayment,
  append,
  update,
  ensureHeader,
  invalidateCache,
};
