/**
 * Repository: EMB_Vendors sheet. Admin-managed list of embroidery vendor codes.
 */

const gs = require('./googleSheetsRepository');

const SHEET = 'EMB_Vendors';
const HEADERS = ['vendor_code', 'vendor_name', 'contact', 'status', 'created_at'];

function str(v) { return (v ?? '').toString().trim(); }

function parseRow(row) {
  return { vendor_code: str(row[0]), vendor_name: str(row[1]), contact: str(row[2]), status: str(row[3]) || 'Active', created_at: str(row[4]) };
}

async function ensureHeader() {
  const rows = await gs.readSheet(SHEET, 'A1:E1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await gs.updateRow(SHEET, 'A1:E1', [HEADERS]);
  }
}

async function getAll() {
  const rows = await gs.readSheet(SHEET, 'A2:E');
  return rows.map(parseRow).filter((v) => v.vendor_code);
}

async function getActive() {
  return (await getAll()).filter((v) => v.status === 'Active');
}

async function findByCode(code) {
  return (await getAll()).find((v) => v.vendor_code === String(code).trim()) || null;
}

async function append(vendor) {
  await ensureHeader();
  await gs.appendRow(SHEET, [vendor.vendor_code, vendor.vendor_name || '', vendor.contact || '', 'Active', new Date().toISOString()]);
}

async function deactivate(code) {
  const rows = await gs.readSheet(SHEET, 'A2:E');
  for (let i = 0; i < rows.length; i++) {
    if (str(rows[i][0]) === String(code).trim()) {
      await gs.updateRow(SHEET, `D${i + 2}`, [['Inactive']]);
      return true;
    }
  }
  return false;
}

module.exports = { SHEET, HEADERS, ensureHeader, getAll, getActive, findByCode, append, deactivate };
