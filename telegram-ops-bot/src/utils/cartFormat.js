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

/**
 * CART-PEEK (owner, 16-Sep-2026: "I am not able to see what I have selected
 * in the cart already … keep on selecting the quantity, looking at what I
 * already have in my basket").
 *
 * The basket as it rides the PICKER cards — design list, shade picker,
 * quantity card — so the person choosing the next line can see the ones
 * already chosen without leaving for the cart. Same lines as the cart card
 * (formatCartBlock, no category), so the peek and the cart can never say
 * two different things; the tally rides the header so the total survives
 * even when the lines are capped.
 *
 *   🛒 In cart · Σ 3B
 *   202/201
 *     • 3 - Navy Blue · 2B
 *   9037
 *     • 3 · 1B
 *
 * Capped because two of the three cards are PHOTO captions (Telegram: 1024
 * characters), and the shade picker's caption already carries overflow
 * lines. A cap is never silent: the cut line says where the rest is.
 *
 * @param {Array<object>} rows cart rows in formatCartBlock's shape
 * @param {{maxLines?: number}} [opts] block lines kept (default 8)
 * @returns {string} '' for an empty cart; otherwise the block, no leading newline
 */
function formatCartPeek(rows, opts = {}) {
  const max = Math.max(1, Number(opts.maxLines) || 8);
  const lines = formatCartBlock(rows, { showCategory: false });
  if (!lines.length) return '';
  const head = `🛒 In cart · ${formatCartTally(rows)}`;
  if (lines.length <= max) return [head, ...lines].join('\n');
  return [head, ...lines.slice(0, max), `${BULLET}…more in 🛒 Back to cart`].join('\n');
}

module.exports = { formatCartBlock, formatCartTally, formatCart, formatCartPeek };
