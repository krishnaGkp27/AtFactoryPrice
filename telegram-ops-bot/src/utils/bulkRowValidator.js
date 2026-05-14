/**
 * Row validator for Bulk Receive Goods (P2.5).
 *
 * Domain model:
 *   - A **bale** (PackageNo) contains 1..N **thans** (rolls cut from it).
 *   - Each row in the upload represents ONE THAN — same as one Inventory row.
 *   - All thans within the same PackageNo share Design + Shade + Warehouse
 *     + Supplier (they came off the same bale, in the same delivery, to
 *     the same place).
 *
 * Takes the parsed output of csvParser or xlsxParser and produces a
 * verdict plus normalised than rows ready for `inventoryRepository.appendBale`.
 *
 * Per the locked spec (reject_file mode), any row-level error means the
 * whole file is rejected at submit time — but we still build the full
 * error list here so Abdul can fix everything in one pass.
 *
 * Required headers:  PackageNo | ThanNo | Design | Yards | Warehouse
 * Optional headers:  Shade | Supplier | NetMtrs | NetWeight | Notes | Color
 *
 * Headers are case-insensitive (csvParser lowercases them already).
 *
 * File-level invariants enforced AFTER per-row checks:
 *   1. (PackageNo, ThanNo) is unique across the file.
 *   2. For any PackageNo with ≥2 thans, Design + Shade are identical
 *      across all of its rows.
 *   3. Single warehouse + single supplier across the whole file
 *      (enforced by the flow, not here — see bulkReceiveFlow.handleDocument).
 */

'use strict';

const REQUIRED = ['packageno', 'thanno', 'design', 'yards', 'warehouse'];
const OPTIONAL = ['shade', 'supplier', 'netmtrs', 'netweight', 'notes', 'color'];
const ALL_KNOWN = new Set([...REQUIRED, ...OPTIONAL]);

const MAX_ROWS_DEFAULT = 500;
const PACKAGE_NO_MAX = 32;
const THAN_NO_MAX = 999;
const NAME_MAX = 80;
const NOTES_MAX = 200;

/**
 * @param {{ ok: boolean, headers?: string[], rows?: any[], error?: string }} parsed
 * @param {{ maxRows?: number, allowedWarehouses?: string[]|null }} [opts]
 */
function validate(parsed, opts = {}) {
  const errors = [];

  if (!parsed || parsed.ok === false) {
    return {
      ok: false, valid: 0, errors: [{ row: 0, column: '', message: parsed && parsed.error ? parsed.error : 'Parser failed.' }],
      summary: emptySummary(), bales: [],
    };
  }

  const headers = parsed.headers || [];
  const rows = parsed.rows || [];

  for (const need of REQUIRED) {
    if (!headers.includes(need)) {
      errors.push({ row: 1, column: need, message: `Missing required header "${need}".` });
    }
  }
  const unknown = headers.filter((h) => h && !ALL_KNOWN.has(h));
  for (const h of unknown) {
    errors.push({ row: 1, column: h, message: `Unknown header "${h}" — allowed: ${[...REQUIRED, ...OPTIONAL].join(', ')}.` });
  }

  const maxRows = Number(opts.maxRows) || MAX_ROWS_DEFAULT;
  if (rows.length > maxRows) {
    errors.push({ row: 0, column: '', message: `File has ${rows.length} rows; max is ${maxRows}. Split it up.` });
  }
  if (rows.length === 0) {
    errors.push({ row: 0, column: '', message: 'File has no data rows.' });
  }

  const allowedWarehouses = Array.isArray(opts.allowedWarehouses)
    ? new Set(opts.allowedWarehouses.map((w) => String(w).trim().toLowerCase()).filter(Boolean))
    : null;

  const thans = [];
  const designs = new Set();
  const warehouses = new Set();
  const suppliers = new Set();
  const distinctBales = new Set();
  let totalYards = 0;
  let totalNetMtrs = 0;
  let totalNetWeight = 0;

  for (const row of rows) {
    const rn = row._rowNum;
    const packageNo = String(row.packageno || '').trim();
    const thanNoRaw = row.thanno;
    const thanNo = parseInt(thanNoRaw, 10);
    const design = String(row.design || '').trim();
    const yardsRaw = row.yards;
    const yards = parseFloat(yardsRaw);
    const warehouse = String(row.warehouse || '').trim();
    const shade = String(row.shade || '').trim();
    const supplier = String(row.supplier || '').trim();
    const notes = String(row.notes || '').trim();
    const color = String(row.color || '').trim();
    const netMtrsRaw = row.netmtrs;
    const netWeightRaw = row.netweight;
    const netMtrs = netMtrsRaw === '' || netMtrsRaw == null ? 0 : parseFloat(netMtrsRaw);
    const netWeight = netWeightRaw === '' || netWeightRaw == null ? 0 : parseFloat(netWeightRaw);

    if (!packageNo) {
      errors.push({ row: rn, column: 'packageno', message: 'PackageNo is required.' });
    } else if (packageNo.length > PACKAGE_NO_MAX) {
      errors.push({ row: rn, column: 'packageno', message: `PackageNo too long (max ${PACKAGE_NO_MAX} chars).` });
    }
    if (thanNoRaw === '' || thanNoRaw == null) {
      errors.push({ row: rn, column: 'thanno', message: 'ThanNo is required (positive integer, e.g. 1, 2, 3…).' });
    } else if (!Number.isInteger(thanNo) || thanNo <= 0 || thanNo > THAN_NO_MAX) {
      errors.push({ row: rn, column: 'thanno', message: `ThanNo must be a positive integer 1–${THAN_NO_MAX} (got "${thanNoRaw}").` });
    }
    if (!design) {
      errors.push({ row: rn, column: 'design', message: 'Design is required.' });
    } else if (design.length > NAME_MAX) {
      errors.push({ row: rn, column: 'design', message: `Design too long (max ${NAME_MAX} chars).` });
    }
    if (!warehouse) {
      errors.push({ row: rn, column: 'warehouse', message: 'Warehouse is required.' });
    } else if (allowedWarehouses && !allowedWarehouses.has(warehouse.toLowerCase())) {
      const allowedList = Array.from(allowedWarehouses).join(', ') || '(none registered)';
      errors.push({
        row: rn, column: 'warehouse',
        message: `Warehouse "${warehouse}" is not registered. Allowed: ${allowedList}.`,
      });
    }
    if (yardsRaw === '' || yardsRaw == null) {
      errors.push({ row: rn, column: 'yards', message: 'Yards is required.' });
    } else if (!isFinite(yards) || yards <= 0) {
      errors.push({ row: rn, column: 'yards', message: `Yards must be a positive number (got "${yardsRaw}").` });
    } else {
      totalYards += yards;
    }
    if (netMtrsRaw && (!isFinite(netMtrs) || netMtrs < 0)) {
      errors.push({ row: rn, column: 'netmtrs', message: `NetMtrs must be non-negative (got "${netMtrsRaw}").` });
    } else if (isFinite(netMtrs) && netMtrs > 0) {
      totalNetMtrs += netMtrs;
    }
    if (netWeightRaw && (!isFinite(netWeight) || netWeight < 0)) {
      errors.push({ row: rn, column: 'netweight', message: `NetWeight must be non-negative (got "${netWeightRaw}").` });
    } else if (isFinite(netWeight) && netWeight > 0) {
      totalNetWeight += netWeight;
    }
    if (shade.length > NAME_MAX) {
      errors.push({ row: rn, column: 'shade', message: `Shade too long (max ${NAME_MAX} chars).` });
    }
    if (supplier.length > NAME_MAX) {
      errors.push({ row: rn, column: 'supplier', message: `Supplier too long (max ${NAME_MAX} chars).` });
    }
    if (notes.length > NOTES_MAX) {
      errors.push({ row: rn, column: 'notes', message: `Notes too long (max ${NOTES_MAX} chars).` });
    }

    thans.push({
      packageNo,
      thanNo: Number.isInteger(thanNo) && thanNo > 0 ? thanNo : 0,
      design, shade, color,
      yards: isFinite(yards) && yards > 0 ? yards : 0,
      netMtrs: isFinite(netMtrs) && netMtrs > 0 ? netMtrs : 0,
      netWeight: isFinite(netWeight) && netWeight > 0 ? netWeight : 0,
      warehouse, supplier, notes,
      _rowNum: rn,
    });
    if (packageNo) distinctBales.add(packageNo);
    if (design) designs.add(design);
    if (warehouse) warehouses.add(warehouse);
    if (supplier) suppliers.add(supplier);
  }

  // File-level invariant 1: (PackageNo, ThanNo) unique.
  const seenKeys = new Map();
  for (const t of thans) {
    if (!t.packageNo || !t.thanNo) continue;
    const key = `${t.packageNo}|${t.thanNo}`;
    if (seenKeys.has(key)) {
      errors.push({
        row: t._rowNum, column: 'thanno',
        message: `Duplicate (PackageNo=${t.packageNo}, ThanNo=${t.thanNo}) — already at row ${seenKeys.get(key)}. Each than must appear once.`,
      });
    } else {
      seenKeys.set(key, t._rowNum);
    }
  }

  // File-level invariant 2: per-bale uniformity of Design + Shade.
  const byPkg = new Map();
  for (const t of thans) {
    if (!t.packageNo) continue;
    if (!byPkg.has(t.packageNo)) byPkg.set(t.packageNo, []);
    byPkg.get(t.packageNo).push(t);
  }
  for (const [pkg, group] of byPkg) {
    if (group.length < 2) continue;
    const first = group[0];
    for (let i = 1; i < group.length; i += 1) {
      const t = group[i];
      if (t.design && first.design && t.design.toLowerCase() !== first.design.toLowerCase()) {
        errors.push({
          row: t._rowNum, column: 'design',
          message: `Bale ${pkg} has inconsistent design: "${first.design}" at row ${first._rowNum}, "${t.design}" at row ${t._rowNum}. A bale = one design.`,
        });
      }
      if ((t.shade || '').toLowerCase() !== (first.shade || '').toLowerCase()) {
        errors.push({
          row: t._rowNum, column: 'shade',
          message: `Bale ${pkg} has inconsistent shade: "${first.shade || '(none)'}" at row ${first._rowNum}, "${t.shade || '(none)'}" at row ${t._rowNum}. A bale = one shade.`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    valid: errors.length === 0 ? thans.length : 0,
    errors,
    bales: thans, // historical name kept for downstream compatibility
    thans,
    summary: {
      totalBales: distinctBales.size,
      totalThans: thans.length,
      totalYards,
      totalNetMtrs,
      totalNetWeight,
      designs: Array.from(designs).sort(),
      warehouses: Array.from(warehouses).sort(),
      suppliers: Array.from(suppliers).sort(),
    },
  };
}

function emptySummary() {
  return {
    totalBales: 0, totalThans: 0, totalYards: 0, totalNetMtrs: 0, totalNetWeight: 0,
    designs: [], warehouses: [], suppliers: [],
  };
}

/**
 * Compute a short, stable hash of a file's bytes for idempotency dedup.
 * SHA-256 first 16 hex chars is plenty for the expected import volume
 * (collision probability ≈ 1 in 2^64 over millions of imports).
 *
 * Accepts either a Buffer (XLSX) or a string (CSV).
 */
function fileHash(input) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  if (Buffer.isBuffer(input)) {
    h.update(input);
  } else {
    h.update(String(input || ''), 'utf8');
  }
  return h.digest('hex').slice(0, 16);
}

module.exports = {
  validate,
  fileHash,
  REQUIRED, OPTIONAL,
  MAX_ROWS_DEFAULT, PACKAGE_NO_MAX, THAN_NO_MAX, NAME_MAX, NOTES_MAX,
};
