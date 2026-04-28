/**
 * Data access for the DesignAssets sheet — product photos for design+shade pickers.
 *
 * Sheet columns (A–O):
 *   A  Design               (e.g. "9006")             — primary lookup key (uppercase normalized)
 *   B  ProductType          (e.g. "fabric")           — auto-detected from inventory at upload time
 *   C  ShadeCount           (integer)                 — number of shades in the photo
 *   D  ShadeNamesJSON       (JSON)                    — preferred shape: array of {n, t}
 *                                                         (number + text). Legacy rows may still
 *                                                         contain a plain string array — parser
 *                                                         normalizes both into [{number, name}].
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
 *
 * Internal canonical shape (returned by getAll/findActive/etc.):
 *   {
 *     ...
 *     shades: [{number: <int>, name: <string>}, ...],   // ordered by number
 *     shadeNames: [<string>, ...],                       // legacy mirror of names only
 *   }
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

/**
 * Parse the ShadeNamesJSON column into the canonical [{number, name}] shape.
 *
 * Accepts three persisted forms:
 *   1. Modern  : [{n:3, t:"White"}, {n:4, t:"Beige"}]      (compact)
 *   2. Modern  : [{number:3, name:"White"}, ...]           (verbose, also accepted on read)
 *   3. Legacy  : ["White","Beige","Brown"]                  (sequential 1..N)
 *
 * Always returns objects sorted by number.
 */
function parseShades(jsonStr) {
  let v;
  try { v = JSON.parse(jsonStr || '[]'); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const out = [];
  v.forEach((entry, i) => {
    if (entry && typeof entry === 'object') {
      const n = parseInt(entry.n ?? entry.number, 10);
      const t = String(entry.t ?? entry.name ?? '').trim();
      if (!Number.isNaN(n) && n > 0) out.push({ number: n, name: t });
    } else {
      // Legacy plain string → assign sequential number i+1
      const t = String(entry ?? '').trim();
      if (t) out.push({ number: i + 1, name: t });
    }
  });
  out.sort((a, b) => a.number - b.number);
  return out;
}

/** Serialize canonical [{number,name}] back to compact JSON for the sheet. */
function serializeShades(shades) {
  if (!Array.isArray(shades)) return '[]';
  const compact = shades
    .filter((s) => s && Number.isFinite(s.number))
    .map((s) => ({ n: parseInt(s.number, 10), t: String(s.name || '').slice(0, 50) }));
  return JSON.stringify(compact);
}

function parseRow(r, rowIndex) {
  const shades = parseShades(r[3]);
  return {
    rowIndex,
    design: str(r[0]),
    productType: str(r[1]) || 'fabric',
    shadeCount: num(r[2]),
    shades,
    // Mirror of names only — kept for callers that still read `shadeNames`.
    shadeNames: shades.map((s) => s.name),
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

/**
 * Build a row tuple from a record. Accepts either:
 *   - { shades: [{number, name}, ...] }   (preferred — preserves numbers)
 *   - { shadeNames: ["A","B",...] }       (legacy — auto-assigns 1..N)
 */
function toRow(o) {
  let shades = Array.isArray(o.shades) ? o.shades : null;
  if (!shades && Array.isArray(o.shadeNames)) {
    shades = o.shadeNames.map((n, i) => ({ number: i + 1, name: String(n) }));
  }
  return [
    o.design ?? '',
    o.productType ?? 'fabric',
    o.shadeCount ?? (shades ? shades.length : 0),
    serializeShades(shades || []),
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

/**
 * Update shade list for an existing asset (admin edit).
 *
 * @param {number} rowIndex
 * @param {Array<{number:number,name:string}> | string[]} shadesOrNames
 *        Preferred: array of {number, name}. Legacy: array of strings (auto-assigned 1..N).
 */
async function setShades(rowIndex, shadesOrNames) {
  if (!rowIndex) return;
  let shades;
  if (Array.isArray(shadesOrNames) && shadesOrNames.length && typeof shadesOrNames[0] === 'object') {
    shades = shadesOrNames;
  } else if (Array.isArray(shadesOrNames)) {
    shades = shadesOrNames.map((n, i) => ({ number: i + 1, name: String(n) }));
  } else {
    shades = [];
  }
  await sheets.updateRange(SHEET, `D${rowIndex}`, [[serializeShades(shades)]]);
  // Also bump ShadeCount (column C) to stay consistent.
  await sheets.updateRange(SHEET, `C${rowIndex}`, [[shades.length]]);
  invalidateCache();
}

// Legacy alias — kept so any old callers still work.
const setShadeNames = setShades;

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
  setShades,
  setShadeNames,
  parseShades,
  serializeShades,
  invalidateCache,
};
