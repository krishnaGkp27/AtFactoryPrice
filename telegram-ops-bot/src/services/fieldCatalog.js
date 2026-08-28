'use strict';

/**
 * fieldCatalog — the warehouse-scoped "My Products" view for marketers and
 * salesmen.
 *
 * Builds a read-only catalog of AVAILABLE stock, grouped design → shade with
 * Bales · thans · yds, restricted to the warehouse(s) assigned to the user.
 * When `showPrice` is set (salesman), each shade line also carries today's
 * selling price (the existing `PricePerYard`, resolved via pricingService).
 *
 * Pure: it only reads the passed-in inventory rows plus the pure formatters /
 * price resolver. No Sheets, no Telegram, no credentials — unit-testable.
 */

const { fmtMoneyShort } = require('../utils/format');
const pricing = require('./pricingService');

/** @param {string} w */
function normWh(w) {
  return String(w || '').trim().toLowerCase();
}

/**
 * @param {Array<object>} items        all inventory rows (any status/warehouse)
 * @param {string[]} warehouses        warehouse names assigned to the user
 * @param {{ showPrice?: boolean }} [opts]
 * @returns {{ text: string, empty: boolean }}
 */
function buildCatalog(items, warehouses, opts = {}) {
  const showPrice = !!opts.showPrice;
  const whList = (warehouses || []).map((w) => String(w).trim()).filter(Boolean);
  const whSet = new Set(whList.map(normWh));
  const whLabel = whList.join(', ') || '—';

  let header = `🧵 *My Collection — ${whLabel}*\n`; // MYP-3 — staff view keeps its warehouse label
  // STK-PRIV (owner, 23-Aug-2026): stock counts are admin-only everywhere.
  header += showPrice ? '_Designs · shades · price_\n' : '_Designs · shades_\n';

  if (!whSet.size) {
    return { text: `${header}\n⚠️ No warehouse assigned to you yet. Ask your admin.`, empty: true };
  }

  const avail = (items || []).filter(
    (r) => r && r.status === 'available' && whSet.has(normWh(r.warehouse)),
  );
  if (!avail.length) {
    return { text: `${header}\n🛈 No products available in your warehouse(s) right now.`, empty: true };
  }

  // Group design → shade.
  const designs = new Map();
  for (const r of avail) {
    const d = r.design || 'Unknown';
    if (!designs.has(d)) designs.set(d, { shades: new Map(), pkgs: new Set(), thans: 0, yards: 0 });
    const dg = designs.get(d);
    const sh = r.shade || '-';
    if (!dg.shades.has(sh)) dg.shades.set(sh, { pkgs: new Set(), thans: 0, yards: 0 });
    const s = dg.shades.get(sh);
    s.pkgs.add(r.packageNo); s.thans += 1; s.yards += r.yards || 0;
    dg.pkgs.add(r.packageNo); dg.thans += 1; dg.yards += r.yards || 0;
  }

  const sorted = [...designs.entries()].sort((a, b) => b[1].yards - a[1].yards);
  let text = `${header}\n`;
  for (const [design, dg] of sorted) {
    text += `📦 *${design}*\n`;
    const shadesSorted = [...dg.shades.entries()].sort((a, b) => b[1].yards - a[1].yards);
    for (const [shade] of shadesSorted) {
      let line = `   Shade ${shade}: ✅ in stock`;
      if (showPrice) {
        const sp = pricing.resolveSalePrice(items, design, shade);
        if (sp.price > 0) line += ` · ${fmtMoneyShort(sp.price)}/yd${sp.mixed ? ' (varies)' : ''}`;
      }
      text += `${line}\n`;
    }
    text += '\n';
  }
  return { text: text.trimEnd(), empty: false };
}

module.exports = { buildCatalog };
