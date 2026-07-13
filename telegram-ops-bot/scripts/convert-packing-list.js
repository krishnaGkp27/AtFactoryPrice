'use strict';

/**
 * BATCH-1 / PL-1 — offline CLI over src/services/packingListImportService.
 *
 * Converts a supplier DETAIL PACKING LIST workbook into strict Add Stock
 * CSVs (1 row = 1 than), split on bale boundaries under the 500-row cap.
 * Since PL-1 the bot also accepts the .xlsx DIRECTLY in Telegram (strict
 * Add Stock auto-detects the layout); this CLI remains for offline checks
 * and for generating chunked CSVs when preferred.
 *
 * Usage:
 *   node scripts/convert-packing-list.js --file "<packing list.xlsx>" \
 *     [--out-dir data/uploads] [--prefix CONTAINER] [--supplier "NAME"] \
 *     [--max-rows 500] [--verify] [--warehouse "NAME"]
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const plImport = require('../src/services/packingListImportService');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes(`--${name}`);

const FILE = arg('file', '');
const OUT_DIR = arg('out-dir', 'data/uploads');
const PREFIX = arg('prefix', 'CONTAINER');
const SUPPLIER = arg('supplier', '');
const MAX_ROWS = parseInt(arg('max-rows', '500'), 10);

function main() {
  if (!FILE) { console.error('Missing --file <packing-list.xlsx>'); process.exit(1); }
  const detected = plImport.detect(XLSX.readFile(FILE));
  if (!detected) { console.error('No recognizable packing-list sheet (S./Carton/BALE header) found.'); process.exit(1); }
  const { thans, summary, supplier } = plImport.transform(detected);
  const supplierName = SUPPLIER || supplier || '';

  // Pack whole bales into files so none exceeds MAX_ROWS (validator cap).
  const byBale = [];
  for (const t of thans) {
    const last = byBale[byBale.length - 1];
    if (last && last[0].packageNo === t.packageNo) last.push(t);
    else byBale.push([t]);
  }
  const files = [];
  let current = [];
  for (const bale of byBale) {
    if (current.length && current.length + bale.length > MAX_ROWS) { files.push(current); current = []; }
    current = current.concat(bale);
  }
  if (current.length) files.push(current);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const supplierCol = supplierName ? ',Supplier' : '';
  const written = [];
  files.forEach((f, i) => {
    const name = `${PREFIX}-part${i + 1}of${files.length}.csv`;
    const out = path.join(OUT_DIR, name);
    const lines = [`PackageNo,ThanNo,Design,Shade,Yards,Indent,CSNo${supplierCol}`];
    for (const t of f) {
      lines.push(`${t.packageNo},${t.thanNo},${t.design},${t.shade},${t.yards},${t.indent},${t.csNo}${supplierName ? ',' + supplierName : ''}`);
    }
    fs.writeFileSync(out, lines.join('\n') + '\n');
    written.push({ name, out, rows: f.length, bales: new Set(f.map((t) => t.packageNo)).size });
  });

  const report = [
    `# Conversion report — ${path.basename(FILE)}`,
    `Generated ${new Date().toISOString()}`,
    '',
    `Sellable bales: ${summary.bales} · thans: ${summary.thans} · yards: ${summary.yards}`,
    `Supplier: ${supplierName || '(none)'} · Indents: ${summary.indents.join(', ')}`,
    `Designs (${summary.designs.length}): ${summary.designs.join(', ')}`,
    `Excluded rows (${summary.excluded.length}): ${summary.excluded.map((e) => `${e.carton} (${e.indent}, ${e.yards} yds)`).join('; ') || 'none'}`,
    `Duplicate cartons IN FILE (skipped after first): ${summary.dupCartons.join(', ') || 'none'}`,
    `Bales with no yardage cells (SKIPPED): ${summary.noYardCells.join(', ') || 'none'}`,
    `Yard-sum mismatches (cell sums used): ${summary.yardMismatch.length ? JSON.stringify(summary.yardMismatch) : 'none'}`,
    '',
    `Than-count corrections (yardage cells trusted): ${summary.thanCountFix.length}`,
    ...summary.thanCountFix.map((p) => `  - carton ${p.carton}: declared ${p.declared}, actual ${p.actual}`),
    '',
    'Files:',
    ...written.map((w) => `  - ${w.name}: ${w.rows} than-rows, ${w.bales} bales`),
    '',
    'NOT carried into Inventory by the bulk format (kept in this packing list archive only):',
    '  - bale-level Net MTRS / weights · "No of COL" (Indent + CSNo ARE carried since BULK-INDENT)',
  ].join('\n');
  const reportPath = path.join(OUT_DIR, `${PREFIX}-conversion-report.md`);
  fs.writeFileSync(reportPath, report + '\n');
  console.log(report);
  console.log(`\nreport: ${reportPath}`);

  if (has('verify')) {
    const { parseCsv } = require('../src/utils/csvParser');
    const validator = require('../src/utils/bulkRowValidator');
    // Mirror addStockFlow._enforceWarehouseColumn: the flow injects the
    // picked warehouse into a CSV that omits the column.
    const verifyWh = arg('warehouse', 'IDUMOTA store');
    let allOk = true;
    for (const w of written) {
      const parsed = parseCsv(fs.readFileSync(w.out, 'utf8'));
      if (parsed.ok !== false && !parsed.headers.includes('warehouse')) {
        parsed.headers.push('warehouse');
        for (const row of parsed.rows) row.warehouse = verifyWh;
      }
      const verdict = validator.validate(parsed, { maxRows: MAX_ROWS });
      const ok = verdict.ok && verdict.errors.length === 0;
      console.log(`verify ${w.name}: ${ok ? 'OK' : 'FAILED'} (${verdict.summary.totalBales} bales, ${verdict.summary.totalThans} thans)`);
      if (!ok) { allOk = false; verdict.errors.slice(0, 10).forEach((e) => console.log('   ', JSON.stringify(e))); }
    }
    if (!allOk) process.exit(1);
    const vTot = written.reduce((s, w) => s + w.rows, 0);
    console.log(`verify TOTAL: ${vTot} than-rows across ${written.length} files — all pass the bot's own validator.`);
  }
}

main();
