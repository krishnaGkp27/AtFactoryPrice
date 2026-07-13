'use strict';

/**
 * BATCH-1 — convert a supplier "DETAIL PACKING LIST" workbook (1 row = 1 bale,
 * THAN 1..7 yardage columns) into strict Add Stock CSVs (1 row = 1 than),
 * split on bale boundaries to respect the bulk validator's max-rows cap.
 *
 * The container/arrival-batch label (e.g. "July26") is NOT written into the
 * CSV — the operator types it in the flow's required Container step, which
 * stamps arrival_batch on every appended Inventory row (ARRIVAL-BATCH C1).
 * The Warehouse column is also omitted on purpose: the strict Add Stock flow
 * injects the warehouse picked in Telegram, so the CSV can never contradict it.
 *
 * Trusts the per-than yardage CELLS over the "No of THAN" declaration when
 * they disagree (yard sums always reconcile; the declaration is clerical) —
 * every such bale is listed in the report.
 *
 * Usage:
 *   node scripts/convert-packing-list.js --file "<packing list.xlsx>" \
 *     [--sheet "PACKING LIST"] [--out-dir data/uploads] [--prefix CONTAINER] \
 *     [--supplier "NAME"] [--max-rows 500] [--verify]
 *
 * --verify runs every generated CSV through the bot's real csvParser +
 * bulkRowValidator (offline, zero credentials) and fails loudly on any error.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.includes(`--${name}`);

const FILE = arg('file', '');
const SHEET = arg('sheet', 'PACKING LIST');
const OUT_DIR = arg('out-dir', 'data/uploads');
const PREFIX = arg('prefix', 'CONTAINER');
const SUPPLIER = arg('supplier', '');
const MAX_ROWS = parseInt(arg('max-rows', '500'), 10);

// Column indexes in the supplier layout (two-row header found by scan).
const COL = { sno: 0, carton: 1, bale: 2, indent: 3, cs: 4, design: 5, quality: 6, shade: 7, cols: 8, thans: 9, thanStart: 10, thanEnd: 16, yards: 17, mtrs: 18 };

function str(v) { return (v == null ? '' : String(v)).trim(); }

function main() {
  if (!FILE) { console.error('Missing --file <packing-list.xlsx>'); process.exit(1); }
  const wb = XLSX.readFile(FILE);
  if (!wb.Sheets[SHEET]) { console.error(`Sheet "${SHEET}" not found. Sheets: ${wb.SheetNames.join(', ')}`); process.exit(1); }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, defval: null });

  // Locate the data header: the row whose col 2 is "BALE" and col 0 is "S.".
  let hdr = -1;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const r = rows[i] || [];
    if (str(r[0]).startsWith('S.') && str(r[COL.bale]).toUpperCase() === 'BALE') { hdr = i; break; }
  }
  if (hdr === -1) { console.error('Could not locate the S./Carton/BALE header row.'); process.exit(1); }

  const data = rows.slice(hdr + 2).filter((r) => r && r[COL.sno] != null && r[COL.carton] != null);
  const excluded = [];
  const thanRows = [];
  const perBale = [];
  const seen = new Map();
  const problems = { dupCartons: [], thanCountFix: [], noYardCells: [], yardMismatch: [] };

  for (const r of data) {
    const carton = str(r[COL.carton]);
    const indent = str(r[COL.indent]);
    const design = str(r[COL.design]);
    if (indent.toUpperCase() === 'ZSHIPMENT' || design.toUpperCase().includes('NOT FOR SALE')) {
      excluded.push({ carton, indent, design, yards: Number(r[COL.yards]) || 0 });
      continue;
    }
    if (seen.has(carton)) { problems.dupCartons.push(carton); continue; }
    seen.set(carton, true);

    const declared = Number(r[COL.thans]) || 0;
    const yardCells = [];
    for (let c = COL.thanStart; c <= COL.thanEnd; c++) {
      const v = Number(r[c]);
      if (r[c] != null && Number.isFinite(v) && v > 0) yardCells.push(v);
    }
    const netYards = Number(r[COL.yards]) || 0;
    const cellSum = yardCells.reduce((s, v) => s + v, 0);
    if (!yardCells.length) { problems.noYardCells.push(carton); continue; }
    if (Math.abs(cellSum - netYards) > 0.05) problems.yardMismatch.push({ carton, netYards, cellSum });
    if (yardCells.length !== declared) problems.thanCountFix.push({ carton, declared, actual: yardCells.length });

    const shade = str(r[COL.shade]);
    const csNo = str(r[COL.cs]);
    yardCells.forEach((yards, i) => {
      thanRows.push({ packageNo: carton, thanNo: i + 1, design, shade, yards, indent, csNo });
    });
    perBale.push({ carton, indent, cs: csNo, design, shade, thans: yardCells.length, yards: cellSum });
  }

  // Split into files on bale boundaries: group thans per bale, then pack
  // whole bales so no file ever exceeds MAX_ROWS (validator hard cap).
  const byBale = [];
  for (const t of thanRows) {
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
  const supplierCol = SUPPLIER ? ',Supplier' : '';
  const written = [];
  files.forEach((f, i) => {
    const name = `${PREFIX}-part${i + 1}of${files.length}.csv`;
    const out = path.join(OUT_DIR, name);
    const lines = [`PackageNo,ThanNo,Design,Shade,Yards,Indent,CSNo${supplierCol}`];
    for (const t of f) {
      lines.push(`${t.packageNo},${t.thanNo},${t.design},${t.shade},${t.yards},${t.indent},${t.csNo}${SUPPLIER ? ',' + SUPPLIER : ''}`);
    }
    fs.writeFileSync(out, lines.join('\n') + '\n');
    written.push({ name, out, rows: f.length, bales: new Set(f.map((t) => t.packageNo)).size });
  });

  // Report.
  const totYards = thanRows.reduce((s, t) => s + t.yards, 0);
  const report = [
    `# Conversion report — ${path.basename(FILE)}`,
    `Generated ${new Date().toISOString()}`,
    '',
    `Sellable bales: ${perBale.length} · thans: ${thanRows.length} · yards: ${totYards.toFixed(2)}`,
    `Excluded rows (${excluded.length}): ${excluded.map((e) => `${e.carton} (${e.indent}, ${e.yards} yds)`).join('; ') || 'none'}`,
    `Duplicate cartons IN FILE (skipped after first): ${problems.dupCartons.join(', ') || 'none'}`,
    `Bales with no yardage cells (SKIPPED — must be entered manually): ${problems.noYardCells.join(', ') || 'none'}`,
    `Yard-sum mismatches vs Net Yards (kept, cell sum used): ${problems.yardMismatch.length ? JSON.stringify(problems.yardMismatch) : 'none'}`,
    '',
    `Than-count corrections (declared "No of THAN" vs actual yardage cells — cells trusted): ${problems.thanCountFix.length}`,
    ...problems.thanCountFix.map((p) => `  - carton ${p.carton}: declared ${p.declared}, actual ${p.actual}`),
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
