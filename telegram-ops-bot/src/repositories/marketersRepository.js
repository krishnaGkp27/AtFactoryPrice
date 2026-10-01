/**
 * Data access for Marketers sheet — marketer profiles (separate from Customers).
 *
 * Marketers borrow catalogs temporarily to show to potential buyers.
 * Registration requires name, phone, area, person photo, and catalog photo,
 * all approved by admin before the marketer can receive any catalogs.
 */

const sheets = require('./sheetsClient');
const { ttlCache } = require('../utils/ttlCache');
const idGenerator = require('../utils/idGenerator');
const { str } = require('../utils/text');

const SHEET = 'Marketers';
const HEADERS = [
  'MarketerId', 'Name', 'Phone', 'Area',
  'PersonPhotoFileId', 'PersonPhotoDriveId',
  'CatalogPhotoFileId', 'CatalogPhotoDriveId',
  'Status', 'ApprovedBy', 'ApprovalRequestId', 'Notes', 'CreatedAt',
];
const COL_COUNT = HEADERS.length;



function parseRow(r, rowIndex) {
  return {
    rowIndex,
    marketer_id: str(r[0]),
    name: str(r[1]),
    phone: str(r[2]),
    area: str(r[3]),
    person_photo_file_id: str(r[4]),
    person_photo_drive_id: str(r[5]),
    catalog_photo_file_id: str(r[6]),
    catalog_photo_drive_id: str(r[7]),
    status: str(r[8]).toLowerCase() || 'pending',
    approved_by: str(r[9]),
    approval_request_id: str(r[10]),
    notes: str(r[11]),
    created_at: str(r[12]),
  };
}

function toRow(o) {
  return [
    o.marketer_id ?? '',
    o.name ?? '',
    o.phone ?? '',
    o.area ?? '',
    o.person_photo_file_id ?? '',
    o.person_photo_drive_id ?? '',
    o.catalog_photo_file_id ?? '',
    o.catalog_photo_drive_id ?? '',
    (o.status ?? 'pending').toLowerCase(),
    o.approved_by ?? '',
    o.approval_request_id ?? '',
    o.notes ?? '',
    o.created_at ?? new Date().toISOString(),
  ];
}

const { columnLetter } = require('./sheetsClient');

let _headerReady = false;

async function ensureHeader() {
  // Bootstrapping the header only matters once per process — schemaMapper
  // already creates every sheet + header at startup. Without this guard each
  // append/write paid an extra read (and, where ensureHeader also calls
  // getSheetNames, a whole-spreadsheet metadata call) first.
  if (_headerReady) return;
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
  _headerReady = true;
}


const _cache = ttlCache(10000, async () => {
  await ensureHeader();
  const rows = await sheets.readRange(SHEET, `A2:${columnLetter(COL_COUNT)}`).catch(() => []);
  return rows.map((r, i) => parseRow(r, i + 2)).filter((r) => r.marketer_id || r.name);
});
function invalidateCache() { _cache.invalidate(); }

async function getAll() { return _cache.get(); }

async function findById(marketerId) {
  if (!marketerId) return null;
  const all = await getAll();
  return all.find((r) => r.marketer_id === marketerId) || null;
}

async function findByName(name) {
  const all = await getAll();
  const n = (name || '').toLowerCase();
  return all.find((r) => r.name.toLowerCase() === n) || null;
}

async function searchByName(query) {
  const all = await getAll();
  const q = (query || '').toLowerCase();
  return all.filter((r) => r.name.toLowerCase().includes(q));
}

async function findByApprovalRequestId(requestId) {
  if (!requestId) return null;
  const all = await getAll();
  return all.find((r) => r.approval_request_id === requestId) || null;
}

async function listActive() {
  const all = await getAll();
  return all.filter((r) => r.status === 'active');
}

async function listPending() {
  const all = await getAll();
  return all.filter((r) => r.status === 'pending');
}

async function append(marketer) {
  await ensureHeader();
  const marketerId = marketer.marketer_id || idGenerator.generate('MKT');
  const now = new Date().toISOString();
  const row = toRow({ ...marketer, marketer_id: marketerId, created_at: marketer.created_at || now });
  await sheets.appendRows(SHEET, [row]);
  invalidateCache();
  return { ...marketer, marketer_id: marketerId };
}

async function updateStatus(rowIndex, newStatus, approvedBy) {
  await sheets.batchUpdateRanges(SHEET, [
    { range: `I${rowIndex}`, values: [[(newStatus || '').toLowerCase()]] },
    { range: `J${rowIndex}`, values: [[approvedBy ?? '']] },
  ]);
  invalidateCache();
}

module.exports = {
  SHEET,
  HEADERS,
  getAll,
  findById,
  findByName,
  searchByName,
  findByApprovalRequestId,
  listActive,
  listPending,
  append,
  updateStatus,
  ensureHeader,
  invalidateCache,
};
