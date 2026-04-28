/**
 * Data access for the DesignAssets sheet — product photos for design+shade pickers.
 *
 * Sheet columns (A–O):
 *   A  Design               (e.g. "9006")             — primary lookup key (uppercase normalized)
 *   B  ProductType          (e.g. "fabric")           — auto-detected from inventory at upload time
 *   C  ShadeCount           (integer)                 — number of shades in the photo
 *   D  ShadeNamesJSON       (JSON string array)       — e.g. ["White","Beige","Brown",...]
 *   E  RawDriveFileId       (Drive file id)           — original photo
 *   F  RawDriveUrl          (https://drive...)        — convenience link
 *   G  LabeledDriveFileId   (Drive file id)           — Sharp-stamped photo (design # top-right)
 *   H  LabeledDriveUrl      (https://drive...)
 *   I  TelegramFileId       (cached after first send) — instant subsequent sends
 *   J  Status               ('pending' | 'active' | 'replaced' | 'inactive')
 *   K  UploadedBy           (Telegram user id)
 *   L  UploadedAt           (ISO timestamp)
 *   M  ApprovalRequestId    (links to ApprovalQueue)
 *   N  ApprovedBy           (admin user id, on activation)
 *   O  Notes
 */

const sheets = require('./sheetsClient');

const SHEET = 'DesignAssets';
const HEADERS = [
  'Design', 'ProductType', 'ShadeCount', 'ShadeNamesJSON',
  'RawDriveFileId', 'RawDriveUrl', 'LabeledDriveFileId', 'LabeledDriveUrl',
  'TelegramFileId', 'Status',
  'UploadedBy', 'UploadedAt', 'ApprovalRequestId', 'ApprovedBy', 'Notes',
];
const COL_COUNT = HEADERS.length;

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseInt(v, 10) || 0; }
function upper(v) { return str(v).toUpperCase(); }

function safeParseArr(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch { return []; }
}

function parseRow(r, rowIndex) {
  return {
    rowIndex,
    design: str(r[0]),
    productType: str(r[1]) || 'fabric',
    shadeCount: num(r[2]),
    shadeNames: safeParseArr(r[3]),
    rawDriveFileId: str(r[4]),
    rawDriveUrl: str(r[5]),
    labeledDriveFileId: str(r[6]),
    labeledDriveUrl: str(r[7]),
    telegramFileId: str(r[8]),
    status: str(r[9]).toLowerCase() || 'pending',
    uploadedBy: str(r[10]),
    uploadedAt: str(r[11]),
    approvalRequestId: str(r[12]),
    approvedBy: str(r[13]),
    notes: str(r[14]),
  };
}

function toRow(o) {
  return [
    o.design ?? '',
    o.productType ?? 'fabric',
    o.shadeCount ?? 0,
    JSON.stringify(o.shadeNames || []),
    o.rawDriveFileId ?? '',
    o.rawDriveUrl ?? '',
    o.labeledDriveFileId ?? '',
    o.labeledDriveUrl ?? '',
    o.telegramFileId ?? '',
    (o.status ?? 'pending').toLowerCase(),
    o.uploadedBy ?? '',
    o.uploadedAt ?? '',
    o.approvalRequestId ?? '',
    o.approvedBy ?? '',
    o.notes ?? '',
  ];
}

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 10000;

async function ensureHeader() {
  // Ensure the sheet itself exists (silent no-op if it does).
  try {
    const names = await sheets.getSheetNames();
    if (!names.includes(SHEET)) {
      try { await sheets.addSheet(SHEET); } catch (_) { /* may race or already exist */ }
    }
  } catch (_) { /* sheet listing failure: try header write anyway */ }

  const rows = await sheets.readRange(SHEET, `A1:${columnLetter(COL_COUNT)}1`).catch(() => []);
  if (!rows.length || rows[0].length < COL_COUNT) {
    await sheets.updateRange(SHEET, `A1:${columnLetter(COL_COUNT)}1`, [HEADERS]);
  }
}

function columnLetter(n) {
  // 1 -> A, 26 -> Z, 27 -> AA. n is 1-indexed.
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function invalidateCache() { _cache = null; _cacheTs = 0; }

async function getAll() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) return _cache;
  await ensureHeader();
  const rows = await sheets.readRange(SHEET, `A2:${columnLetter(COL_COUNT)}`).catch(() => []);
  _cache = rows.map((r, i) => parseRow(r, i + 2)).filter((r) => r.design);
  _cacheTs = Date.now();
  return _cache;
}

/** Find the *active* asset for a design, or null if none. */
async function findActive(design) {
  if (!design) return null;
  const all = await getAll();
  const d = upper(design);
  return all.find((r) => upper(r.design) === d && r.status === 'active') || null;
}

/** Find the most recent asset for a design regardless of status, or null. */
async function findLatest(design) {
  if (!design) return null;
  const all = await getAll();
  const d = upper(design);
  const matches = all.filter((r) => upper(r.design) === d);
  if (!matches.length) return null;
  return matches.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''))[0];
}

async function findByApprovalRequestId(requestId) {
  if (!requestId) return null;
  const all = await getAll();
  return all.find((r) => r.approvalRequestId === requestId) || null;
}

/** List assets, optionally filtered by status. */
async function list(status) {
  const all = await getAll();
  if (!status) return all;
  return all.filter((r) => r.status === status);
}

async function append(record) {
  await ensureHeader();
  await sheets.appendRows(SHEET, [toRow(record)]);
  invalidateCache();
}

async function updateStatus(rowIndex, newStatus, approvedBy) {
  // Touch only J (Status) and N (ApprovedBy) — never blank K/L/M.
  await sheets.batchUpdateRanges(SHEET, [
    { range: `J${rowIndex}`, values: [[newStatus]] },
    { range: `N${rowIndex}`, values: [[approvedBy ?? '']] },
  ]);
  invalidateCache();
}

/** Mark all currently-active assets for `design` as 'replaced' (idempotent). */
async function deactivatePriorActive(design) {
  const all = await getAll();
  const d = upper(design);
  const active = all.filter((r) => upper(r.design) === d && r.status === 'active');
  if (!active.length) return 0;
  const updates = active.map((r) => ({ range: `J${r.rowIndex}`, values: [['replaced']] }));
  await sheets.batchUpdateRanges(SHEET, updates);
  invalidateCache();
  return active.length;
}

/** Cache the Telegram file_id after the first successful send for instant subsequent sends. */
async function setTelegramFileId(rowIndex, telegramFileId) {
  if (!rowIndex || !telegramFileId) return;
  await sheets.updateRange(SHEET, `I${rowIndex}`, [[telegramFileId]]);
  invalidateCache();
}

/** Update shade names for an existing asset (admin edit). */
async function setShadeNames(rowIndex, shadeNames) {
  if (!rowIndex) return;
  const arr = Array.isArray(shadeNames) ? shadeNames.map((x) => String(x)) : [];
  await sheets.updateRange(SHEET, `D${rowIndex}`, [[JSON.stringify(arr)]]);
  invalidateCache();
}

module.exports = {
  SHEET,
  HEADERS,
  ensureHeader,
  getAll,
  findActive,
  findLatest,
  findByApprovalRequestId,
  list,
  append,
  updateStatus,
  deactivatePriorActive,
  setTelegramFileId,
  setShadeNames,
  invalidateCache,
};
