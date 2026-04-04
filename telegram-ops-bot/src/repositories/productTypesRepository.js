/**
 * Data access for ProductTypes sheet + label helpers.
 * Provides dynamic display labels per product type (container, subunit, measure unit).
 */

const sheets = require('./sheetsClient');

const SHEET = 'ProductTypes';
const HEADERS = ['type_id', 'type_name', 'container_label', 'container_short', 'subunit_label', 'measure_unit', 'has_subunits', 'status'];

const DEFAULT_LABELS = {
  type_id: 'fabric',
  type_name: 'Fabric Rolls',
  container_label: 'Bale',
  container_short: 'bls',
  subunit_label: 'Than',
  measure_unit: 'yards',
  has_subunits: true,
  status: 'active',
};

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 60000;

function parse(row) {
  return {
    type_id: (row[0] || '').toString().trim().toLowerCase(),
    type_name: (row[1] || '').toString().trim(),
    container_label: (row[2] || '').toString().trim(),
    container_short: (row[3] || '').toString().trim(),
    subunit_label: (row[4] || '').toString().trim(),
    measure_unit: (row[5] || '').toString().trim(),
    has_subunits: (row[6] || '').toString().trim().toLowerCase() === 'yes',
    status: (row[7] || 'active').toString().trim().toLowerCase(),
  };
}

async function getAll() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) return _cache;
  try {
    const rows = await sheets.readRange(SHEET, 'A2:H');
    _cache = (rows || []).map(parse).filter((r) => r.type_id);
    _cacheTs = Date.now();
    return _cache;
  } catch (_) {
    return _cache || [DEFAULT_LABELS];
  }
}

async function findById(typeId) {
  const all = await getAll();
  return all.find((r) => r.type_id === (typeId || '').toLowerCase()) || null;
}

async function getLabels(productType) {
  const pt = await findById(productType || 'fabric');
  return pt || DEFAULT_LABELS;
}

function getDefaultLabels() {
  return { ...DEFAULT_LABELS };
}

function pluralize(label, count) {
  if (count === 1) return label;
  const lower = label.toLowerCase();
  if (lower === 'box') return 'Boxes';
  if (lower === 'dozen') return 'Dozens';
  if (lower.endsWith('s')) return label;
  return label + 's';
}

function fmtQty(count, labels) {
  return `${count} ${pluralize(labels.container_label, count).toLowerCase()}`;
}

function fmtQtyShort(count, labels) {
  return `${count} ${labels.container_short}`;
}

module.exports = {
  getAll,
  findById,
  getLabels,
  getDefaultLabels,
  pluralize,
  fmtQty,
  fmtQtyShort,
  HEADERS,
};
