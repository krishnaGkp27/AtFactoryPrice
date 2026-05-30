'use strict';

/**
 * stockValueReport — pure helpers for the Stock Value report (Reports hub).
 *
 * Selling price = Inventory.PricePerYard (quoted price to customer).
 * Value = sum(yards × pricePerYard) per available row.
 *
 * No I/O; callers pass inventory rows from inventoryRepository.getAll().
 */

const pricingService = require('./pricingService');

/**
 * @param {Array<{design:string, shade?:string, packageNo:string, yards:number, pricePerYard:number, status:string}>} invRows
 * @returns {Array<{design:string, availPkgs:number, availYards:number, dominantSelling:number, varies:boolean, value:number, priceSet:boolean}>}
 */
function computeDesignSummaries(invRows) {
  const avail = invRows.filter((r) => r.status === 'available');
  const byDesign = new Map();

  for (const r of avail) {
    const design = String(r.design || 'Unknown').trim();
    if (!byDesign.has(design)) {
      byDesign.set(design, {
        design,
        pkgs: new Set(),
        yards: 0,
        value: 0,
      });
    }
    const g = byDesign.get(design);
    g.pkgs.add(r.packageNo);
    g.yards += Number(r.yards) || 0;
    const p = Number(r.pricePerYard) || 0;
    g.value += (Number(r.yards) || 0) * p;
  }

  const out = [];
  for (const g of byDesign.values()) {
    const sp = pricingService.resolveSalePrice(avail, g.design);
    out.push({
      design: g.design,
      availPkgs: g.pkgs.size,
      availYards: g.yards,
      dominantSelling: sp.price,
      varies: sp.mixed,
      value: g.value,
      priceSet: sp.price > 0,
    });
  }

  out.sort((a, b) => {
    if (a.priceSet !== b.priceSet) return a.priceSet ? -1 : 1;
    return b.value - a.value;
  });
  return out;
}

/**
 * @param {Array} invRows
 * @param {string} design
 * @returns {{
 *   design: string,
 *   designTotal: number,
 *   availPkgs: number,
 *   availYards: number,
 *   dominantSelling: number,
 *   varies: boolean,
 *   rows: Array<{shade:string, pkgs:number, yards:number, sellingPrice:number, differsFromDominant:boolean, value:number}>
 * }}
 */
function computeShadeBreakdown(invRows, design) {
  const designUC = String(design || '').trim().toUpperCase();
  const avail = invRows.filter(
    (r) => r.status === 'available'
      && String(r.design || '').trim().toUpperCase() === designUC,
  );

  const dominant = pricingService.resolveSalePrice(avail, design);
  const byShade = new Map();

  for (const r of avail) {
    const shade = String(r.shade || '-').trim();
    if (!byShade.has(shade)) {
      byShade.set(shade, { shade, pkgs: new Set(), yards: 0, value: 0 });
    }
    const s = byShade.get(shade);
    s.pkgs.add(r.packageNo);
    s.yards += Number(r.yards) || 0;
    const p = Number(r.pricePerYard) || 0;
    s.value += (Number(r.yards) || 0) * p;
  }

  const rows = [];
  let designTotal = 0;
  const balPkgs = new Set();

  for (const s of byShade.values()) {
    const sp = pricingService.resolveSalePrice(avail, design, s.shade);
    const sellingPrice = sp.price;
    const differs = sellingPrice > 0 && dominant.price > 0 && sellingPrice !== dominant.price;
    rows.push({
      shade: s.shade,
      pkgs: s.pkgs.size,
      yards: s.yards,
      sellingPrice,
      differsFromDominant: differs || (dominant.price > 0 && !sellingPrice),
      value: s.value,
    });
    designTotal += s.value;
    for (const p of s.pkgs) balPkgs.add(p);
  }

  rows.sort((a, b) => b.value - a.value);

  return {
    design: String(design).trim(),
    designTotal,
    availPkgs: balPkgs.size,
    availYards: avail.reduce((sum, r) => sum + (Number(r.yards) || 0), 0),
    dominantSelling: dominant.price,
    varies: dominant.mixed,
    rows,
  };
}

/**
 * Grand totals across all available stock.
 * @param {ReturnType<typeof computeDesignSummaries>} summaries
 */
function computeGrandTotals(summaries) {
  let grandValue = 0;
  let grandYards = 0;
  let designCount = 0;
  for (const s of summaries) {
    grandValue += s.value;
    grandYards += s.availYards;
    designCount += 1;
  }
  return { grandValue, grandYards, designCount };
}

module.exports = {
  computeDesignSummaries,
  computeShadeBreakdown,
  computeGrandTotals,
};
