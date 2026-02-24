/**
 * Bulk-import inventory from CSV into Google Sheet (Inventory tab).
 * Reads the CSV format: S.No., Package No., INDENT, CS No., LOT/DGN., SHADE,
 *   No of COL, No of THAN, THAN 1..THAN 7, Net Yards, Net MTRS, Net Weight, Gross Weight
 * Splits each package into individual than rows.
 *
 * Usage:
 *   node scripts/import-inventory.js <csv-file> [warehouse] [pricePerYard]
 *
 * Example:
 *   node scripts/import-inventory.js "C:\Users\John\Downloads\Inventory - Sheet68.csv" Lagos 1200
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sheetsClient = require('../src/repositories/sheetsClient');
const inventoryRepo = require('../src/repositories/inventoryRepository');

const csvFile = process.argv[2];
const warehouse = process.argv[3] || '';
const pricePerYard = parseFloat(process.argv[4]) || 0;

if (!csvFile) {
  console.error('Usage: node scripts/import-inventory.js <csv-file> [warehouse] [pricePerYard]');
  process.exit(1);
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const headerLine = lines[0];
  const headers = headerLine.split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cols[idx] || ''; });
    rows.push(obj);
  }
  return rows;
}

async function main() {
  const raw = fs.readFileSync(csvFile, 'utf8');
  const packages = parseCSV(raw);
  console.log(`Parsed ${packages.length} packages from CSV.`);

  const thanRows = [];
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  for (const pkg of packages) {
    const packageNo = pkg['Package No.'] || '';
    const indent = pkg['INDENT'] || '';
    const csNo = pkg['CS No.'] || '';
    const design = pkg['LOT/DGN.'] || '';
    const shade = pkg['SHADE'] || '';
    const numThan = parseInt(pkg['No of THAN']) || 0;
    const netMtrs = parseFloat(pkg['Net MTRS']) || 0;
    const netWeight = parseFloat(pkg['Net Weight']) || 0;

    const thanYards = [];
    for (let t = 1; t <= 7; t++) {
      const key = `THAN ${t}`;
      const val = parseFloat(pkg[key]);
      if (!isNaN(val) && val > 0) thanYards.push(val);
    }

    const mtrPerThan = numThan > 0 ? netMtrs / numThan : 0;
    const weightPerThan = numThan > 0 ? netWeight / numThan : 0;

    thanYards.forEach((yards, idx) => {
      thanRows.push({
        packageNo,
        indent,
        csNo,
        design,
        shade,
        thanNo: idx + 1,
        yards,
        status: 'available',
        warehouse,
        pricePerYard,
        dateReceived: today,
        soldTo: '',
        soldDate: '',
        netMtrs: Math.round(mtrPerThan * 100) / 100,
        netWeight: Math.round(weightPerThan * 100) / 100,
        updatedAt: now,
      });
    });
  }

  console.log(`Generated ${thanRows.length} than rows. Uploading to Google Sheet...`);

  await inventoryRepo.ensureHeader();
  const count = await inventoryRepo.appendThans(thanRows);
  console.log(`Done. ${count} thans imported into Inventory sheet.`);
}

main().catch((e) => {
  console.error('Import failed:', e.message);
  process.exit(1);
});
