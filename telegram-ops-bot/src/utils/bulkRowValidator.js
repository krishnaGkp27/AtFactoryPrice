/**
 * Row validator for Bulk Receive Goods (P2.5).
 *
 * Takes the parsed output of csvParser or xlsxParser and produces a
 * verdict plus normalised bale rows ready for `inventoryRepository.appendBale`.
 *
 * Per the locked spec (reject_file mode), any row-level error means the
 * whole file is rejected at submit time — but we still build the full
 * error list here so Abdul can fix everything in one pass.
 *
 * Required headers:  PackageNo | Design | Yards | Warehouse
 * Optional headers:  Shade | Supplier | Notes | Color
 *
 * Headers are case-insensitive (csvParser lowercases them already).
 */

'use strict';

const REQUIRED = ['packageno', 'design', 'yards', 'warehouse'];
const OPTIONAL = ['shade', 'supplier', 'notes', 'color'];
const ALL_KNOWN = new Set([...REQUIRED, ...OPTIONAL]);

const MAX_ROWS_DEFAULT = 500;
const PACKAGE_NO_MAX = 32;
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

  const bales = [];
  const designs = new Set();
  const warehouses = new Set();
  const suppliers = new Set();
  let totalYards = 0;

  for (const row of rows) {
    const rn = row._rowNum;
    const packageNo = String(row.packageno || '').trim();
    const design = String(row.design || '').trim();
    const yardsRaw = row.yards;
    const yards = parseFloat(yardsRaw);
    const warehouse = String(row.warehouse || '').trim();
    const shade = String(row.shade || '').trim();
    const supplier = String(row.supplier || '').trim();
    const notes = String(row.notes || '').trim();
    const color = String(row.color || '').trim();

    if (!packageNo) {
      errors.push({ row: rn, column: 'packageno', message: 'PackageNo is required.' });
    } else if (packageNo.length > PACKAGE_NO_MAX) {
      errors.push({ row: rn, column: 'packageno', message: `PackageNo too long (max ${PACKAGE_NO_MAX} chars).` });
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
    if (shade.length > NAME_MAX) {
      errors.push({ row: rn, column: 'shade', message: `Shade too long (max ${NAME_MAX} chars).` });
    }
    if (supplier.length > NAME_MAX) {
      errors.push({ row: rn, column: 'supplier', message: `Supplier too long (max ${NAME_MAX} chars).` });
    }
    if (notes.length > NOTES_MAX) {
      errors.push({ row: rn, column: 'notes', message: `Notes too long (max ${NOTES_MAX} chars).` });
    }

    bales.push({
      packageNo, design, shade, color,
      yards: isFinite(yards) && yards > 0 ? yards : 0,
      warehouse, supplier, notes,
      _rowNum: rn,
    });
    if (design) designs.add(design);
    if (warehouse) warehouses.add(warehouse);
    if (supplier) suppliers.add(supplier);
  }

  return {
    ok: errors.length === 0,
    valid: errors.length === 0 ? bales.length : 0,
    errors,
    bales,
    summary: {
      totalBales: bales.length,
      totalYards,
      designs: Array.from(designs).sort(),
      warehouses: Array.from(warehouses).sort(),
      suppliers: Array.from(suppliers).sort(),
    },
  };
}

function emptySummary() {
  return { totalBales: 0, totalYards: 0, designs: [], warehouses: [], suppliers: [] };
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
  MAX_ROWS_DEFAULT, PACKAGE_NO_MAX, NAME_MAX, NOTES_MAX,
};
