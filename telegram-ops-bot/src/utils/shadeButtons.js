/**
 * Shade-button rendering helpers shared across all "pick a shade" pickers
 * (Supply Request, Sample, Update Price, etc.).
 *
 * Goals:
 *  - Single source of truth for the visible label format:
 *      "<#> - <name> (<qty> bales)"   when both name and qty are known
 *      "<#> (<qty> bales)"             when name is unavailable
 *      "<#> - <name>"                  when qty is unavailable
 *      "<#>"                           when neither
 *
 *    The literal " - " separator + " bales" suffix matches what the
 *    user explicitly asked for. The unit "bales" is consistent with the
 *    package→Bale rename done earlier.
 *
 *  - Layout: 2 buttons side-by-side by default. We drop to 1-per-row
 *    only when the longest label would clearly wrap on a typical phone
 *    (>28 chars — e.g. unusually long color names). 3-column packing
 *    used to be applied for very short labels, but 2-column is the
 *    visually consistent default the user prefers, so we hold there.
 *
 *  - Build a quick `Map<shadeNumberAsString, name>` from a DesignAssets
 *    asset record so the picker can look up names by the inventory's
 *    shade value (which is normally numeric for catalog-aware designs).
 */

/**
 * @param {{shades?: Array<{number:number,name:string}>, shadeNames?: string[]}} asset
 * @returns {Map<string,string>}  shadeKey (string form of number) → name
 */
function buildShadeNameMap(asset) {
  const m = new Map();
  if (!asset) return m;
  if (Array.isArray(asset.shades) && asset.shades.length) {
    for (const s of asset.shades) {
      if (s && s.number != null && s.name) m.set(String(s.number), String(s.name));
    }
    return m;
  }
  // Legacy fallback: array of plain names → numbered 1..N.
  if (Array.isArray(asset.shadeNames) && asset.shadeNames.length) {
    asset.shadeNames.forEach((name, i) => {
      if (name) m.set(String(i + 1), String(name));
    });
  }
  return m;
}

/**
 * Format a single shade button label.
 *
 * @param {string|number} shadeKey  the shade identifier as it appears in
 *                                  inventory (e.g. "1", "11", "BLACK").
 *                                  Numeric strings are matched against
 *                                  `nameMap`; non-numeric strings are
 *                                  passed through as-is.
 * @param {Map<string,string>} [nameMap]  optional name lookup
 * @param {number} [qty]                  optional container count
 * @param {{singular?:string, plural?:string}} [unit]
 *        Container unit override. Defaults to {singular:'bale', plural:'bales'}.
 *        Pass the product-type-aware container label here when it
 *        might not be "bale" (e.g. "box" for garments).
 * @returns {string}
 */
function buildShadeLabel(shadeKey, nameMap, qty, unit) {
  const key = String(shadeKey == null ? '' : shadeKey).trim();
  const name = nameMap && nameMap.get(key);

  let head;
  if (name) {
    // Use the inventory key (typically the printed tab number) + " - " +
    // catalog name. For non-numeric keys (e.g. "BLACK") this branch is
    // rare in practice — non-numeric shades usually aren't in nameMap.
    head = `${key} - ${name}`;
  } else {
    head = key || '—';
  }

  if (Number.isFinite(qty) && qty > 0) {
    const singular = (unit && unit.singular) || 'bale';
    const plural = (unit && unit.plural) || 'bales';
    return `${head} (${qty} ${qty === 1 ? singular : plural})`;
  }
  return head;
}

/**
 * Pick a column count for an inline-keyboard page based on the longest
 * label. Default is 2 columns side-by-side. Falls to 1-per-row only
 * when a label would clearly overflow on a typical phone width.
 *
 * @param {string[]} labels
 * @returns {1|2}
 */
function pickColumns(labels) {
  let max = 0;
  for (const l of labels) {
    if (l && l.length > max) max = l.length;
  }
  // 28 chars per button × 2 buttons + padding still fits 360 px phones.
  // Beyond that, drop to single-column rather than risk text wrapping
  // mid-button which looks cluttered.
  if (max > 28) return 1;
  return 2;
}

/**
 * Lay out an array of {text, callback_data} buttons into a 2-D rows
 * array using a responsive column count derived from the longest label.
 *
 * @param {Array<{text:string,callback_data:string}>} buttons
 * @returns {Array<Array<{text:string,callback_data:string}>>}
 */
function layoutShadeRows(buttons) {
  if (!buttons || !buttons.length) return [];
  const cols = pickColumns(buttons.map((b) => b.text));
  const rows = [];
  for (let i = 0; i < buttons.length; i += cols) {
    rows.push(buttons.slice(i, i + cols));
  }
  return rows;
}

/**
 * Format a "shade reference" for headers and inline text — the form
 * "<#> - <name>" when a name is known, plain "<#>" otherwise. Used in
 * picker headers, cart summaries, and admin notifications so the user
 * can still tell what color they picked once the photo is gone.
 *
 * @param {string|number} shade
 * @param {string} [name]
 * @returns {string}
 */
function formatShadeRef(shade, name) {
  const s = String(shade == null ? '' : shade).trim();
  if (!s) return '';
  const n = String(name == null ? '' : name).trim();
  return n ? `${s} - ${n}` : s;
}

module.exports = {
  buildShadeNameMap,
  buildShadeLabel,
  pickColumns,
  layoutShadeRows,
  formatShadeRef,
};
