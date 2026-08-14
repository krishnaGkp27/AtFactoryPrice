'use strict';

/**
 * PAY-1 — sole owner of the `PaymentAccounts` sheet: the register of
 * WHERE the business is allowed to send money.
 *
 * The owner's first rule for this feature (14-Aug-2026): an account
 * number is never typed at payment time. It is registered once, approved
 * by two admins, and afterwards only ever PICKED. A transfer to a wrong
 * account cannot be undone by anything the bot does, so the register —
 * not the moment of payment — is where the care goes.
 *
 * Columns
 *   A account_id            PAC-…
 *   B owner_name            the person the account belongs to
 *   C owner_type            'employee' | 'contractor'
 *   D owner_telegram_id     employee's Telegram id; '' for a contractor
 *   E account_number        stored as TEXT — a leading zero is part of the
 *                           number, and Sheets eats it otherwise (SHEET-FIX-3)
 *   F bank                  from the Settings BANK_LIST picker
 *   G status                'pending' | 'active' | 'inactive'
 *   H registered_by         Telegram id of whoever raised it
 *   I approval_request_id   ties back to ApprovalQueue
 *   J approved_by           both approver names, "A ‖ B"
 *   K created_at            ISO
 *   L notes
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const SHEET = 'PaymentAccounts';
const HEADERS = [
  'account_id', 'owner_name', 'owner_type', 'owner_telegram_id',
  'account_number', 'bank', 'status', 'registered_by',
  'approval_request_id', 'approved_by', 'created_at', 'notes',
];

const OWNER_TYPES = ['employee', 'contractor'];
const STATUSES = ['pending', 'active', 'inactive'];

const CACHE_TTL_MS = 10 * 1000;
let _cache = null;
let _cacheTs = 0;
function invalidateCache() { _cache = null; _cacheTs = 0; }

function str(v) { return (v ?? '').toString().trim(); }

/** Digits only — how two account numbers are compared for sameness. */
function digits(v) { return str(v).replace(/\D/g, ''); }

function parse(r, rowIndex) {
  const ownerType = str(r[2]).toLowerCase();
  const status = str(r[6]).toLowerCase();
  return {
    rowIndex,
    account_id: str(r[0]),
    owner_name: str(r[1]),
    owner_type: OWNER_TYPES.includes(ownerType) ? ownerType : 'employee',
    owner_telegram_id: str(r[3]),
    account_number: str(r[4]),
    bank: str(r[5]),
    // An unreadable status is treated as PENDING, never as active: the
    // safe default for a register that authorises payments is "not yet".
    status: STATUSES.includes(status) ? status : 'pending',
    registered_by: str(r[7]),
    approval_request_id: str(r[8]),
    approved_by: str(r[9]),
    created_at: str(r[10]),
    notes: str(r[11]),
  };
}

let _headerReady = false;
async function ensureHeader() {
  if (_headerReady) return;
  const rows = await sheets.readRange(SHEET, 'A1:L1');
  if (!rows.length || (rows[0] || []).length < HEADERS.length) {
    await sheets.updateRange(SHEET, 'A1:L1', [HEADERS]);
  }
  _headerReady = true;
}

async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return [..._cache];
  let rows;
  try {
    rows = await sheets.readRange(SHEET, 'A2:L');
  } catch (_) {
    return []; // sheet not bootstrapped yet — an empty register, never a crash
  }
  _cache = (rows || []).map((r, i) => parse(r, i + 2)).filter((a) => a.account_id);
  _cacheTs = now;
  return [..._cache];
}

async function findById(accountId) {
  if (!accountId) return null;
  return (await getAll()).find((a) => a.account_id === String(accountId)) || null;
}

async function findByApprovalRequestId(requestId) {
  if (!requestId) return null;
  return (await getAll()).find((a) => a.approval_request_id === String(requestId)) || null;
}

/** Active accounts belonging to one Telegram user (an employee's own). */
async function activeForTelegramId(telegramId) {
  const id = str(telegramId);
  if (!id) return [];
  return (await getAll()).filter((a) => a.status === 'active' && a.owner_telegram_id === id);
}

/** Every active contractor account — the only payees an admin raises for. */
async function activeContractors() {
  return (await getAll()).filter((a) => a.status === 'active' && a.owner_type === 'contractor');
}

/**
 * A live (pending or active) registration of the same account NUMBER at
 * the same BANK. Registering one twice would put two rows in the picker
 * that mean the same destination — the reviewer could approve either and
 * the ledger would disagree with itself about which one was paid.
 */
async function findLive(accountNumber, bank) {
  const n = digits(accountNumber);
  const b = str(bank).toLowerCase();
  if (!n) return null;
  return (await getAll()).find((a) => a.status !== 'inactive'
    && digits(a.account_number) === n
    && str(a.bank).toLowerCase() === b) || null;
}

/** Register a payee account as PENDING; approval flips it to active. */
async function append(entry) {
  await ensureHeader();
  const accountId = entry.account_id || idGenerator.generate('PAC');
  const now = new Date().toISOString();
  const ownerType = str(entry.owner_type).toLowerCase();
  await sheets.appendRows(SHEET, [[
    accountId,
    str(entry.owner_name),
    OWNER_TYPES.includes(ownerType) ? ownerType : 'employee',
    str(entry.owner_telegram_id),
    // Leading apostrophe: the number is TEXT. Written bare, Sheets stores
    // 0123456789 as the number 123456789 and the account is wrong.
    entry.account_number ? `'${digits(entry.account_number)}` : '',
    str(entry.bank),
    entry.status || 'pending',
    str(entry.registered_by),
    str(entry.approval_request_id),
    str(entry.approved_by),
    now,
    str(entry.notes),
  ]]);
  invalidateCache();
  return { ...entry, account_id: accountId, created_at: now };
}

/** Flip status (and stamp who approved) — the approval executor's door. */
async function setStatus(accountId, status, approvedBy) {
  const row = await findById(accountId);
  if (!row) return null;
  const next = STATUSES.includes(String(status).toLowerCase()) ? String(status).toLowerCase() : row.status;
  const updates = [{ range: `G${row.rowIndex}`, values: [[next]] }];
  if (approvedBy !== undefined) updates.push({ range: `J${row.rowIndex}`, values: [[str(approvedBy)]] });
  await sheets.batchUpdateRanges(SHEET, updates);
  invalidateCache();
  return { ...row, status: next, approved_by: approvedBy === undefined ? row.approved_by : str(approvedBy) };
}

module.exports = {
  SHEET,
  HEADERS,
  OWNER_TYPES,
  STATUSES,
  getAll,
  findById,
  findByApprovalRequestId,
  findLive,
  activeForTelegramId,
  activeContractors,
  append,
  setStatus,
  ensureHeader,
  invalidateCache,
  digits,
};
