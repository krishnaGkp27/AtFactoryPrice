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
 *  - Responsive row layout: pick column count from the longest label on
 *    the page so we never produce buttons that wrap on narrow phones.
 *      ≤ 10 chars → 3 columns (e.g. "1 (10 bales)" — short)
 *      ≤ 18 chars → 2 columns (e.g. "1 - White (10 bales)" — medium)
 *      else       → 1 column  (e.g. "11 - Off White (10 bales)" — long)
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
 * label. Tuned for typical mobile Telegram width (~36–40 chars per row
 * including padding) so buttons rarely wrap.
 *
 * @param {string[]} labels
 * @returns {1|2|3}
 */
function pickColumns(labels) {
  let max = 0;
  for (const l of labels) {
    if (l && l.length > max) max = l.length;
  }
  if (max <= 10) return 3;
  if (max <= 18) return 2;
  return 1;
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

module.exports = {
  buildShadeNameMap,
  buildShadeLabel,
  pickColumns,
  layoutShadeRows,
};
