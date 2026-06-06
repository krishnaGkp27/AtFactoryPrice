/**
 * Inventory-level conflict detection for the strict Add-stock flow (TCSI-2).
 *
 * Lives ON TOP of upstream's Bulk Receive Goods (P2.5) — does NOT modify it.
 * Upstream's bulkRowValidator already enforces file-level invariants
 * (PackageNo+ThanNo uniqueness, per-bale design/shade uniformity, header
 * validation, file size, etc). This module adds two STRICT cross-file rules
 * that upstream intentionally does NOT enforce:
 *
 *   R1. Same bale # already exists in target warehouse        → BLOCK
 *   R2. Same design # already exists in target warehouse      → BLOCK
 *       (even when all existing thans are sold out — strict)
 *
 * Same bale # in a DIFFERENT warehouse stays legitimate (different physical
 * bale, P1 composite-key model). Surfaced as an informational note.
 *
 * Block-and-report only — no automatic resolution. Operator fixes the CSV
 * (or existing data) offline and re-uploads.
 *
 * Future enhancements (NOT here):
 *   - Per-row resolution prompts (skip / replace / add-alongside)
 *   - Batch-aware identity (DateReceived clustering, suffix rendering)
 *   - Runtime sell-flow disambiguator picker
 *   - Toggle to relax R2 to "warn only" via settings
 */

'use strict';

const inventoryRepository = require('../repositories/inventoryRepository');

function _norm(v) { return (v ?? '').toString().trim(); }
function _eq(a, b) { return _norm(a).toLowerCase() === _norm(b).toLowerCase(); }

/**
 * Detect R1 + R2 conflicts for a parsed batch about to land in `warehouse`.
 *
 * @param {string} warehouse
 * @param {Array} thans   output of bulkRowValidator.validate(...).bales
 *                        each shape: { packageNo, thanNo, design, shade, warehouse, yards, _rowNum }
 * @param {Array} existingInventory  output of inventoryRepository.getAll()
 * @returns {{
 *   ok: boolean,
 *   r1: Array<{csvLine, packageNo, existing: {design, shade, dateReceived, availableThans, totalThans}}>,
 *   r2: Array<{csvLine, design, existing: {baleCount, totalThans, availableThans, dateRange}}>,
 *   crossWarehouseBaleNotes: Array<{packageNo, existingWarehouses: string[]}>,
 * }}
 */
function detectInventoryConflicts(warehouse, thans, existingInventory) {
  const r1 = [];
  const r2 = [];
  const crossWarehouseBaleNotes = [];

  // Pre-index existing inventory for O(1) lookups.
  const existingByPkg = new Map();        // packageNo  -> [rows]
  const existingByDesignWh = new Map();   // `${design}|${wh}` -> [rows]
  for (const r of existingInventory) {
    const pkg = _norm(r.packageNo);
    if (!existingByPkg.has(pkg)) existingByPkg.set(pkg, []);
    existingByPkg.get(pkg).push(r);

    const dkey = `${_norm(r.design).toLowerCase()}|${_norm(r.warehouse).toLowerCase()}`;
    if (!existingByDesignWh.has(dkey)) existingByDesignWh.set(dkey, []);
    existingByDesignWh.get(dkey).push(r);
  }

  // Collapse incoming thans to unique-bale level for R1 reporting
  // (multiple thans of the same incoming bale = ONE conflict, not N).
  const incomingByPkg = new Map();
  for (const t of thans) {
    const pkg = _norm(t.packageNo);
    if (!pkg) continue;
    if (!incomingByPkg.has(pkg)) {
      incomingByPkg.set(pkg, { firstLine: t._rowNum, design: t.design, shade: t.shade });
    } else {
      const cur = incomingByPkg.get(pkg);
      if (t._rowNum && (!cur.firstLine || t._rowNum < cur.firstLine)) cur.firstLine = t._rowNum;
    }
  }

  // R1 + cross-warehouse notes per incoming bale.
  for (const [pkg, info] of incomingByPkg.entries()) {
    const pkgRows = existingByPkg.get(pkg) || [];
    if (!pkgRows.length) continue;

    const sameWh = pkgRows.filter((r) => _eq(r.warehouse, warehouse));
    if (sameWh.length) {
      const first = sameWh[0];
      const available = sameWh.filter((r) => r.status === 'available').length;
      r1.push({
        csvLine: info.firstLine,
        packageNo: pkg,
        existing: {
          design: first.design,
          shade: first.shade,
          dateReceived: first.dateReceived,
          availableThans: available,
          totalThans: sameWh.length,
        },
      });
    } else {
      const otherWhs = [...new Set(pkgRows.map((r) => r.warehouse).filter(Boolean))];
      if (otherWhs.length) {
        crossWarehouseBaleNotes.push({
          packageNo: pkg,
          existingWarehouses: otherWhs,
        });
      }
    }
  }

  // R2 — group incoming by design, check each against same-warehouse existing.
  const csvDesigns = new Map();
  for (const t of thans) {
    const d = _norm(t.design).toLowerCase();
    if (!d) continue;
    if (!csvDesigns.has(d)) csvDesigns.set(d, []);
    csvDesigns.get(d).push(t);
  }
  for (const [d, csvThans] of csvDesigns.entries()) {
    const dkey = `${d}|${_norm(warehouse).toLowerCase()}`;
    const existing = existingByDesignWh.get(dkey) || [];
    if (!existing.length) continue;

    const bales = new Set(existing.map((r) => _norm(r.packageNo)));
    const dates = [...new Set(existing.map((r) => r.dateReceived).filter(Boolean))].sort();
    const dateRange = dates.length === 0 ? '—'
      : dates.length === 1 ? dates[0]
      : `${dates[0]} … ${dates[dates.length - 1]}`;

    const firstLine = csvThans.reduce((min, t) => (t._rowNum && (!min || t._rowNum < min)) ? t._rowNum : min, null);

    r2.push({
      csvLine: firstLine,
      design: csvThans[0].design,
      existing: {
        baleCount: bales.size,
        totalThans: existing.length,
        availableThans: existing.filter((r) => r.status === 'available').length,
        dateRange,
      },
    });
  }

  const ok = r1.length === 0 && r2.length === 0;
  return { ok, r1, r2, crossWarehouseBaleNotes };
}

/**
 * Thin wrapper around inventoryRepository.getAll so tests can stub easily.
 */
async function getInventorySnapshot() {
  return inventoryRepository.getAll();
}

module.exports = {
  detectInventoryConflicts,
  getInventorySnapshot,
};
