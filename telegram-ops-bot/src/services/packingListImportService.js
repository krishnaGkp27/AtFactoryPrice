'use strict';

/**
 * PL-1 — supplier DETAIL PACKING LIST → normalized than rows
 * (specs/PL-1_PACKING_LIST_UPLOAD.md).
 *
 * Shared by the strict Add Stock flow (direct .xlsx upload in Telegram) and
 * scripts/convert-packing-list.js (offline CLI). Layout: two-row header
 * `S. | Carton | BALE | INDENT | CS | LOT/DGN | QUALITY | SHADE | No of COL |
 * No of THAN | THAN 1..7 | Net Yards | …`; 1 row = 1 bale. PackageNo is the
 * CARTON number (the BALE column is unused by this supplier).
 *
 * Rules (owner-locked):
 *  - trust yardage CELLS over the "No of THAN" declaration (corrections
 *    reported); skip bales with no yardage cells at all (reported)
 *  - exclude ZSHIPMENT / NOT FOR SALE rows
 *  - carry Indent + CS No + Shade (BULK-INDENT columns)
 */

const COL = {
  sno: 0, carton: 1, bale: 2, indent: 3, cs: 4, design: 5, quality: 6,
  shade: 7, cols: 8, thans: 9, thanStart: 10, thanEnd: 16, yards: 17,
};

function str(v) { return (v == null ? '' : String(v)).trim(); }

/**
 * Find the packing-list sheet + header row in a parsed workbook.
 * @param {object} wb  XLSX workbook (from XLSX.read / readFile)
 * @returns {{ sheetName: string, headerRow: number, rows: Array }|null}
 */
function detect(wb) {
  const XLSX = require('xlsx');
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null });
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      const r = rows[i] || [];
      if (str(r[COL.sno]).startsWith('S.') && str(r[COL.bale]).toUpperCase() === 'BALE'
        && str(r[COL.carton]).toUpperCase().startsWith('CARTON')) {
        return { sheetName, headerRow: i, rows };
      }
    }
  }
  return null;
}

/** Best-effort supplier name from the letterhead (row after "Exporter…"). */
function extractSupplier(rows) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    if (str((rows[i] || [])[0]).toLowerCase().startsWith('exporter')) {
      return str((rows[i + 1] || [])[0]);
    }
  }
  return '';
}

/**
 * Transform detected packing-list rows into normalized than rows + summary.
 * @param {{ rows: Array, headerRow: number }} detected  from detect()
 * @returns {{ thans: Array<{packageNo,thanNo,design,shade,yards,indent,csNo}>,
 *   summary: object, supplier: string }}
 */
function transform(detected) {
  const { rows, headerRow } = detected;
  const data = rows.slice(headerRow + 2).filter((r) => r && r[COL.sno] != null && r[COL.carton] != null);

  const thans = [];
  const excluded = [];
  const seen = new Set();
  const designs = new Set();
  const indents = new Set();
  const problems = { dupCartons: [], thanCountFix: [], noYardCells: [], yardMismatch: [] };
  let baleCount = 0;
  let totalYards = 0;

  for (const r of data) {
    const carton = str(r[COL.carton]);
    const indent = str(r[COL.indent]);
    const design = str(r[COL.design]);
    if (indent.toUpperCase() === 'ZSHIPMENT' || design.toUpperCase().includes('NOT FOR SALE')) {
      excluded.push({ carton, indent, yards: Number(r[COL.yards]) || 0 });
      continue;
    }
    if (seen.has(carton)) { problems.dupCartons.push(carton); continue; }
    seen.add(carton);

    const declared = Number(r[COL.thans]) || 0;
    const yardCells = [];
    for (let c = COL.thanStart; c <= COL.thanEnd; c++) {
      const v = Number(r[c]);
      if (r[c] != null && Number.isFinite(v) && v > 0) yardCells.push(v);
    }
    if (!yardCells.length) { problems.noYardCells.push(carton); continue; }

    const netYards = Number(r[COL.yards]) || 0;
    const cellSum = yardCells.reduce((s, v) => s + v, 0);
    if (Math.abs(cellSum - netYards) > 0.05) problems.yardMismatch.push({ carton, netYards, cellSum });
    if (yardCells.length !== declared) problems.thanCountFix.push({ carton, declared, actual: yardCells.length });

    const shade = str(r[COL.shade]);
    const csNo = str(r[COL.cs]);
    yardCells.forEach((yards, i) => {
      thans.push({ packageNo: carton, thanNo: i + 1, design, shade, yards, indent, csNo });
    });
    baleCount += 1;
    totalYards += cellSum;
    designs.add(design);
    if (indent) indents.add(indent);
  }

  return {
    thans,
    supplier: extractSupplier(rows),
    summary: {
      bales: baleCount,
      thans: thans.length,
      yards: Math.round(totalYards * 100) / 100,
      designs: [...designs],
      indents: [...indents],
      excluded,
      dupCartons: problems.dupCartons,
      thanCountFix: problems.thanCountFix,
      noYardCells: problems.noYardCells,
      yardMismatch: problems.yardMismatch,
    },
  };
}

module.exports = { detect, transform, _internals: { COL, extractSupplier } };
