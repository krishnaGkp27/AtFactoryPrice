'use strict';

/**
 * Data access for the DesignShadeAssets sheet — SHP-1 (owner, 02-Sep-2026):
 * one GARMENT photo per (design, shade tab number[, arrival batch]), shown
 * when a salesperson / marketer / customer selects that shade.
 *
 * Its own sheet, not a column on DesignAssets: DesignAssets is one row per
 * catalogue PAGE and every reader (pickActive, deactivatePriorActive, the
 * album picker, both web proxies) assumes that. Shade photos must be
 * replaceable one at a time and must survive a page being replaced.
 * A raw business master (rule 5b) — registered in schemaMapper.
 *
 * Quality rule (owner: "no compromise with the quality at all, at any
 * place"): column E is the owner's ORIGINAL bytes, untouched; column F is a
 * stamped copy at NATIVE resolution (no downscale). Columns G/H cache the
 * two Telegram file_ids — the photo form (Telegram-compressed view) and the
 * document form (the full-quality bytes).
 *
 * Columns (A..S). Never reorder; new columns go at the END (rule 4).
 *   A Design             uppercase-normalised design number
 *   B ShadeNo            printed tab number on the swatch page (string — the chips key on it)
 *   C ShadeName          name at upload time (display only; DesignAssets ShadeNamesJSON is the master)
 *   D ArrivalBatch       container this photo belongs to ('' = generic; CAT-C1 pattern)
 *   E RawDriveFileId     original bytes, untouched
 *   F LabeledDriveFileId native-resolution stamped copy ("202/201 · #2")
 *   G TelegramFileId     cached PHOTO file_id of the stamped copy
 *   H TelegramDocFileId  cached DOCUMENT file_id of the stamped copy (full quality)
 *   I SourceFileId       the Telegram file_id the uploader sent
 *   J SourceKind         'document' (original bytes) | 'photo' (compressed by Telegram at source)
 *   K Status             pending | active | replaced | inactive
 *   L UploadedBy
 *   M UploadedAt
 *   N ApprovalRequestId
 *   O ApprovedBy
 *   P Width              pixels
 *   Q Height             pixels
 *   R Bytes              size of the original
 *   S Notes
 */

const sheets = require('./sheetsClient');

const SHEET = 'DesignShadeAssets';
const HEADERS = [
  'Design', 'ShadeNo', 'ShadeName', 'ArrivalBatch',
  'RawDriveFileId', 'LabeledDriveFileId', 'TelegramFileId', 'TelegramDocFileId',
  'SourceFileId', 'SourceKind', 'Status',
  'UploadedBy', 'UploadedAt', 'ApprovalRequestId', 'ApprovedBy',
  'Width', 'Height', 'Bytes', 'Notes',
];
const READ_RANGE = 'A2:S';
const STATUSES = Object.freeze({ PENDING: 'pending', ACTIVE: 'active', REPLACED: 'replaced', INACTIVE: 'inactive' });

function str(v) { return (v ?? '').toString().trim(); }
function upper(v) { return str(v).toUpperCase(); }
function num(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
/** Shade tab numbers are keyed as the chips key them: trimmed strings ("1", "03" → "3"). */
function shadeKey(v) {
  const s = str(v);
  const n = parseInt(s, 10);
  return Number.isFinite(n) && String(n) === s.replace(/^0+(?=\d)/, '') ? String(n) : s;
}

function parseRow(r, rowIndex) {
  return {
    rowIndex,
    design: str(r[0]),
    shadeNo: shadeKey(r[1]),
    shadeName: str(r[2]),
    arrivalBatch: str(r[3]),
    rawDriveFileId: str(r[4]),
    labeledDriveFileId: str(r[5]),
    telegramFileId: str(r[6]),
    telegramDocFileId: str(r[7]),
    sourceFileId: str(r[8]),
    sourceKind: str(r[9]).toLowerCase() || 'photo',
    status: str(r[10]).toLowerCase() || STATUSES.PENDING,
    uploadedBy: str(r[11]),
    uploadedAt: str(r[12]),
    approvalRequestId: str(r[13]),
    approvedBy: str(r[14]),
    width: num(r[15]),
    height: num(r[16]),
    bytes: num(r[17]),
    notes: str(r[18]),
  };
}

function toRow(o) {
  return [
    upper(o.design),
    shadeKey(o.shadeNo),
    str(o.shadeName),
    // Plain text, never a date — sheet trap F3 (docs/SHEET_AUDIT_2026-08-14.md).
    str(o.arrivalBatch),
    str(o.rawDriveFileId),
    str(o.labeledDriveFileId),
    str(o.telegramFileId),
    str(o.telegramDocFileId),
    str(o.sourceFileId),
    str(o.sourceKind || 'photo').toLowerCase(),
    str(o.status || STATUSES.PENDING).toLowerCase(),
    str(o.uploadedBy),
    str(o.uploadedAt || new Date().toISOString()),
    str(o.approvalRequestId),
    str(o.approvedBy),
    num(o.width),
    num(o.height),
    num(o.bytes),
    str(o.notes),
  ];
}

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 10000;

function invalidateCache() { _cache = null; _cacheTs = 0; }

async function getAll() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const rows = await sheets.readRange(SHEET, READ_RANGE).catch(() => []);
  _cache = rows.map((r, i) => parseRow(r, i + 2)).filter((x) => x.design && x.shadeNo);
  _cacheTs = now;
  return _cache;
}

async function list(status) {
  const all = await getAll();
  return status ? all.filter((r) => r.status === status) : all;
}

/** Newest active row for (design, shadeNo) — batch-specific first, then generic. */
async function findActive(design, shadeNo, arrivalBatch) {
  const map = await activeMapForDesign(design, arrivalBatch);
  return map.get(shadeKey(shadeNo)) || null;
}

/**
 * Every active shade photo for a design as Map<shadeNo, row>. A row for the
 * named container overrides the generic ('' batch) row for the same shade;
 * a container with no photo of its own falls back to the generic one. When
 * no batch is named, the generic rows win and container rows only fill gaps.
 */
async function activeMapForDesign(design, arrivalBatch) {
  const d = upper(design);
  const b = upper(arrivalBatch || '');
  const rows = (await getAll()).filter((r) => upper(r.design) === d && r.status === STATUSES.ACTIVE);
  const byNewest = (x, y) => String(y.uploadedAt).localeCompare(String(x.uploadedAt));
  const out = new Map();
  const rank = (r) => {
    const rb = upper(r.arrivalBatch || '');
    if (b) return rb === b ? 2 : (rb === '' ? 1 : 0);
    return rb === '' ? 2 : 1;
  };
  for (const r of [...rows].sort(byNewest)) {
    const k = r.shadeNo;
    const cur = out.get(k);
    const rr = rank(r);
    if (rr === 0) continue;
    if (!cur || rr > cur._rank) out.set(k, Object.assign({}, r, { _rank: rr }));
  }
  for (const [k, v] of out) { delete v._rank; out.set(k, v); }
  return out;
}

async function findByApprovalRequestId(requestId) {
  const id = str(requestId);
  if (!id) return [];
  return (await getAll()).filter((r) => r.approvalRequestId === id);
}

/** Append one or more records in a single write. */
async function appendMany(records) {
  const list_ = (Array.isArray(records) ? records : [records]).filter(Boolean);
  if (!list_.length) return 0;
  await sheets.appendRows(SHEET, list_.map(toRow));
  invalidateCache();
  return list_.length;
}

/** Touch only K (Status) and O (ApprovedBy). */
async function updateStatus(rowIndexes, newStatus, approvedBy) {
  const idx = (Array.isArray(rowIndexes) ? rowIndexes : [rowIndexes]).filter(Boolean);
  if (!idx.length) return 0;
  const updates = [];
  for (const i of idx) {
    updates.push({ range: `K${i}`, values: [[str(newStatus).toLowerCase()]] });
    updates.push({ range: `O${i}`, values: [[str(approvedBy)]] });
  }
  await sheets.batchUpdateRanges(SHEET, updates);
  invalidateCache();
  return idx.length;
}

/** Retire the active photo(s) for exactly this (design, shadeNo, batch). Idempotent. */
async function deactivatePriorActive(design, shadeNo, arrivalBatch) {
  const d = upper(design);
  const s = shadeKey(shadeNo);
  const b = upper(arrivalBatch || '');
  const active = (await getAll()).filter((r) => upper(r.design) === d && r.shadeNo === s
    && r.status === STATUSES.ACTIVE && upper(r.arrivalBatch || '') === b);
  if (!active.length) return 0;
  await sheets.batchUpdateRanges(SHEET, active.map((r) => ({ range: `K${r.rowIndex}`, values: [[STATUSES.REPLACED]] })));
  invalidateCache();
  return active.length;
}

async function setTelegramFileId(rowIndex, fileId) {
  if (!rowIndex || !fileId) return;
  await sheets.updateRange(SHEET, `G${rowIndex}`, [[str(fileId)]]);
  invalidateCache();
}

async function setTelegramDocFileId(rowIndex, fileId) {
  if (!rowIndex || !fileId) return;
  await sheets.updateRange(SHEET, `H${rowIndex}`, [[str(fileId)]]);
  invalidateCache();
}

module.exports = {
  SHEET, HEADERS, STATUSES,
  getAll, list, findActive, activeMapForDesign, findByApprovalRequestId,
  appendMany, updateStatus, deactivatePriorActive,
  setTelegramFileId, setTelegramDocFileId,
  invalidateCache,
  _internals: { parseRow, toRow, shadeKey },
};
