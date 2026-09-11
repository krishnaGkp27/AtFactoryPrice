'use strict';

/**
 * UX-2 (owner, 11-Sep-2026) — the cart block every supply card shares.
 *
 * The old line put three "│" columns on one row ("🧵 77019 [Chinos] │
 * Shades: 1×2, 3×1 │ ×3 bls"). Telegram draws cards in a proportional font
 * about 32 characters wide, so the row wrapped at a random point and
 * nothing lined up, and "bls" beside "bales" named one unit two ways on
 * one card. Now the design is a header line, each shade a bullet with its
 * own rule-6c count (BUSINESS_RULES §6c), and one Σ tally closes the block:
 *
 *   🧵 202/201 · Cashmere
 *     • 1 - White · 1B
 *     • 3 - Navy Blue · 2B
 *   🧵 9037
 *     • 3 · 1B
 *
 *   Σ 4B
 *
 * Callers map their cart rows to {icon, design, name, shadeRef, quantity}
 * (shadeRef is the display form, e.g. "3 - Navy Blue"; icon/name come from
 * the design's category meta). `showCategory: false` drops the category on
 * the requester's own cards — the code is enough there; approver cards keep
 * it (owner's call). One implementation feeds the cart, the confirmation,
 * the submitted receipt, the Dispatch full card, the assignment cards and
 * the approval card, so they cannot drift apart again.
 */

const { formatCounts } = require('../services/unitDisplayService');

const BULLET = '  • ';

/** Supply carts count whole bales; the rule-6c letter, never a word. */
function qty(n) { return formatCounts({ bales: Number(n) || 0, empty: '0B' }); }

/**
 * Header + bullet lines per design, first-appearance order.
 * @param {Array<{icon?:string, design:string, name?:string, shadeRef:string, quantity:number}>} rows
 * @param {{showCategory?: boolean}} [opts] default true
 * @returns {string[]}
 */
function formatCartBlock(rows, opts = {}) {
  const showCategory = opts.showCategory !== false;
  const byDesign = new Map();
  for (const r of rows || []) {
    if (!byDesign.has(r.design)) byDesign.set(r.design, { meta: r, group: [] });
    byDesign.get(r.design).group.push(r);
  }
  const lines = [];
  for (const { meta, group } of byDesign.values()) {
    const cat = showCategory && meta.name ? ` · ${meta.name}` : '';
    lines.push(`${meta.icon ? `${meta.icon} ` : ''}${meta.design}${cat}`);
    for (const r of group) lines.push(`${BULLET}${r.shadeRef} · ${qty(r.quantity)}`);
  }
  return lines;
}

/** "Σ 4B" — the one tally under the block. */
function formatCartTally(rows) {
  const total = (rows || []).reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  return `Σ ${qty(total)}`;
}

/** The whole block most cards print: lines, a blank line, the tally. '' for an empty cart. */
function formatCart(rows, opts = {}) {
  const lines = formatCartBlock(rows, opts);
  if (!lines.length) return '';
  return `${lines.join('\n')}\n\n${formatCartTally(rows)}`;
}

module.exports = { formatCartBlock, formatCartTally, formatCart };
