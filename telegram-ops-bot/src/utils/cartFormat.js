'use strict';

/**
 * SRF-UX — shared cart line rendering for supply-request cards.
 *
 * A cart holding many shades of ONE design used to render one full line per
 * shade ("🧵 77019 │ Shade: 1 │ ×1 bls" seven times), so every card in the
 * chain (cart, confirm, submitted, dispatch, admin, assignment) repeated the
 * same design over and over. Group by design instead — one line, shades
 * folded:
 *
 *   single shade      🧵 77019 [Chinos] │ Shade: 3 - White │ ×2 bls
 *   uniform ×1        🧵 77019 [Chinos] │ Shades: 1, 2, 3, 4 │ ×4 bls
 *   mixed quantities  🧵 77019 │ Shades: 1×2, 3×1, 4×3 │ ×6 bls
 *
 * Callers map their cart rows to {icon, design, name, shadeRef, quantity}
 * first (shadeRef is the display form, possibly "3 - White"; icon/name come
 * from the design's category meta so they are identical within a design) and
 * get back grouped display lines in order of first appearance.
 */

function formatCartLines(rows, containerShort) {
  const byDesign = new Map();
  for (const r of rows || []) {
    if (!byDesign.has(r.design)) byDesign.set(r.design, { meta: r, group: [] });
    byDesign.get(r.design).group.push(r);
  }

  const lines = [];
  for (const { meta, group } of byDesign.values()) {
    const label = `${meta.icon} ${meta.design}${meta.name ? ` [${meta.name}]` : ''}`;
    const total = group.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
    if (group.length === 1) {
      lines.push(`${label} │ Shade: ${group[0].shadeRef} │ ×${group[0].quantity} ${containerShort}`);
      continue;
    }
    const uniformSingles = group.every((r) => Number(r.quantity) === 1);
    const shades = group
      .map((r) => (uniformSingles ? String(r.shadeRef) : `${r.shadeRef}×${r.quantity}`))
      .join(', ');
    lines.push(`${label} │ Shades: ${shades} │ ×${total} ${containerShort}`);
  }
  return lines;
}

module.exports = { formatCartLines };
