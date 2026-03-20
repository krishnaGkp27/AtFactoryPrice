/**
 * Repository: Production sheet — single row per article (primary key: article_no).
 * 40 columns (A–AN) spanning 8 manufacturing stages. All business data in one sheet.
 * Uses googleSheetsRepository for all I/O. No business logic here.
 */

const gs = require('./mfgGoogleSheetsRepository');

const SHEET = 'Production';

const HEADERS = [
  'article_no', 'description', 'created_by', 'created_at', 'article_status', 'current_stage',
  'fabric_vendor', 'fabric_receive_date', 'fabric_weight_kg', 'cut_weight_kg', 'waste_weight_kg', 'cut_pieces', 'cut_start_date', 'cut_end_date', 'cut_hours',
  'emb_vendor', 'emb_qty_dispatched', 'emb_dispatch_date', 'emb_qty_received', 'emb_receive_date', 'emb_duration_days', 'emb_hours',
  'stitch_start_date', 'stitch_end_date', 'stitch_qty', 'stitch_hours',
  'threadcut_date', 'threadcut_qty', 'threadcut_hours',
  'iron_start_date', 'iron_end_date', 'iron_qty', 'iron_hours',
  'qc_qty_passed', 'qc_qty_rejected', 'qc_date',
  'pkg_dimension', 'size_breakdown', 'final_stock', 'pkg_date',
];

const COL_COUNT = HEADERS.length; // 40

/** Column ranges per stage (0-based indices) for targeted updates. */
const STAGE_COLUMNS = {
  article:      { start: 0, end: 5 },
  fabric:       { start: 6, end: 14 },
  emb_out:      { start: 15, end: 17 },
  emb_in:       { start: 18, end: 21 },
  stitch:       { start: 22, end: 25 },
  threadcut:    { start: 26, end: 28 },
  iron:         { start: 29, end: 32 },
  qc:           { start: 33, end: 35 },
  packaging:    { start: 36, end: 39 },
};

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

function colLetter(n) {
  let s = '';
  let c = n + 1;
  while (c > 0) { c--; s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26); }
  return s;
}

function parseRow(row, rowIndex) {
  const obj = { rowIndex };
  HEADERS.forEach((h, i) => {
    const v = row[i];
    if (h.endsWith('_kg') || h.endsWith('_hours') || h === 'cut_pieces' || h.startsWith('emb_qty') || h === 'stitch_qty' || h === 'threadcut_qty' || h === 'iron_qty' || h === 'qc_qty_passed' || h === 'qc_qty_rejected' || h === 'emb_duration_days' || h === 'final_stock') {
      obj[h] = num(v);
    } else {
      obj[h] = str(v);
    }
  });
  return obj;
}

async function ensureHeader() {
  const rows = await gs.readSheet(SHEET, `A1:${colLetter(COL_COUNT - 1)}1`);
  if (!rows.length || rows[0].length < COL_COUNT) {
    await gs.updateRow(SHEET, `A1:${colLetter(COL_COUNT - 1)}1`, [HEADERS]);
  }
}

async function getAll() {
  const rows = await gs.readSheet(SHEET, `A2:${colLetter(COL_COUNT - 1)}`);
  return rows.map((r, i) => parseRow(r, i + 2)).filter((a) => a.article_no);
}

async function findByArticleNo(articleNo) {
  const all = await getAll();
  return all.find((a) => a.article_no === String(articleNo)) || null;
}

async function findByStatus(status) {
  const all = await getAll();
  return all.filter((a) => a.article_status.toLowerCase() === status.toLowerCase());
}

/** Update specific columns for an article row. `fields` is an object of { header_name: value }. */
async function updateFields(articleNo, fields) {
  const article = await findByArticleNo(articleNo);
  if (!article) return false;
  const row = article.rowIndex;
  const updates = [];
  for (const [key, val] of Object.entries(fields)) {
    const colIdx = HEADERS.indexOf(key);
    if (colIdx === -1) continue;
    updates.push({ range: `${colLetter(colIdx)}${row}`, values: [[val]] });
  }
  if (!updates.length) return false;
  for (const u of updates) {
    await gs.updateRow(SHEET, u.range, u.values);
  }
  return true;
}

/** Update a stage's columns in bulk (more efficient than field-by-field). */
async function updateStageColumns(articleNo, stageName, values) {
  const article = await findByArticleNo(articleNo);
  if (!article) return false;
  const range = STAGE_COLUMNS[stageName];
  if (!range) return false;
  const startCol = colLetter(range.start);
  const endCol = colLetter(range.end);
  await gs.updateRow(SHEET, `${startCol}${article.rowIndex}:${endCol}${article.rowIndex}`, [values]);
  return true;
}

module.exports = {
  SHEET, HEADERS, COL_COUNT, STAGE_COLUMNS,
  ensureHeader, getAll, findByArticleNo, findByStatus,
  updateFields, updateStageColumns, colLetter,
};
