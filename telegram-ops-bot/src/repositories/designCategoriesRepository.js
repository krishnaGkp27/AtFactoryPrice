/**
 * Design → product-category read/write model — DCAT-1.
 *
 * Maps design numbers to a category label (Cashmere, Chinos, Gaberdine,
 * Senator, TR, …) so every screen can show "80045 · Senator" instead of a
 * bare number. Categories are assigned via the dual-admin "Set Design
 * Category" flow (designCategoryFlow.js).
 *
 * Storage (owner decision, Jul 2026): NO separate sheet — the label lives in
 * the Inventory sheet's `design_category` column (W, appended at the end).
 * Category is a per-DESIGN fact: setCategory() stamps every row of the
 * design via inventoryRepository.updateDesignCategory, and reads take the
 * FIRST non-empty cell per design, so unstamped rows (e.g. bales received
 * after the stamp) still inherit the label on screens.
 *
 * Read model:
 *   - getMap()/categoryOf(): async, derived from inventoryRepository.getAll()
 *     (which has its own short TTL cache) behind a 60 s snapshot here.
 *   - categoryOfSync(): SYNC snapshot read for hot string-building paths
 *     (cart lines, transfer blocks) that cannot await. When the snapshot is
 *     stale it kicks off a background refresh and serves the current one;
 *     before the first refresh lands it returns '' (bare design number).
 *     Display-only, so eventual consistency is acceptable. setCategory()
 *     force-refreshes so an approved change is visible immediately.
 */

const inventoryRepository = require('./inventoryRepository');

// Owner's category vocabulary (Jul 2026). The picker offers these plus any
// distinct categories already present in Inventory, so new labels can be
// introduced through the flow without a code change.
const DEFAULT_CATEGORIES = ['Cashmere', 'Chinos', 'Gaberdine', 'Senator', 'TR'];

let _map = new Map();
let _mapTs = 0;
let _refreshing = null;
const CACHE_TTL_MS = 60000;

/**
 * Canonical design key: trimmed, uppercased. Matches how designs are
 * compared elsewhere (inventoryRepository dedups with upper()).
 * @param {string|number} design Design number.
 * @returns {string} Normalized lookup key.
 */
function normalizeDesign(design) {
  return String(design == null ? '' : design).trim().toUpperCase();
}

/**
 * Canonicalize a category label: collapse whitespace, then snap to the
 * casing of a known category (defaults ∪ sheet) when it matches
 * case-insensitively, else Title-Case each token. Keeps "TR" as TR while
 * "senator" becomes Senator.
 * @param {string} input Raw category text.
 * @param {string[]} [known] Known category labels to snap to.
 * @returns {string} Canonical label ('' when input is empty).
 */
function canonicalizeCategory(input, known = DEFAULT_CATEGORIES) {
  const s = String(input == null ? '' : input).normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const hit = (known || []).find((k) => k.toLowerCase() === s.toLowerCase());
  if (hit) return hit;
  return s
    .split(' ')
    .map((tok) => (tok.length ? tok[0].toLocaleUpperCase() + tok.slice(1).toLocaleLowerCase() : tok))
    .join(' ');
}

/** Rebuild the design→category snapshot from Inventory rows. */
async function refresh() {
  const rows = await inventoryRepository.getAll();
  const m = new Map();
  for (const r of rows) {
    if (!r.design || !r.designCategory) continue;
    const key = normalizeDesign(r.design);
    if (!m.has(key)) m.set(key, r.designCategory); // first non-empty per design wins
  }
  _map = m;
  _mapTs = Date.now();
  return _map;
}

/**
 * Lookup map: normalized design → category label (cached, 60 s TTL).
 * @returns {Promise<Map<string, string>>} Map keyed by normalizeDesign(design).
 */
async function getMap() {
  const now = Date.now();
  if (_mapTs && (now - _mapTs) < CACHE_TTL_MS) return _map;
  try {
    return await refresh();
  } catch {
    return _map;
  }
}

/**
 * Category for one design (async, cached).
 * @param {string|number} design Design number.
 * @returns {Promise<string>} Category label or '' when unmapped.
 */
async function categoryOf(design) {
  const m = await getMap();
  return m.get(normalizeDesign(design)) || '';
}

/**
 * SYNC snapshot lookup for hot paths that cannot await. Serves the current
 * in-process snapshot and triggers a background refresh when stale.
 * @param {string|number} design Design number.
 * @returns {string} Category label or '' when unmapped / not yet loaded.
 */
function categoryOfSync(design) {
  const now = Date.now();
  if ((!_mapTs || (now - _mapTs) >= CACHE_TTL_MS) && !_refreshing) {
    _refreshing = refresh()
      .catch(() => {})
      .finally(() => { _refreshing = null; });
  }
  return _map.get(normalizeDesign(design)) || '';
}

/**
 * Picker vocabulary: DEFAULT_CATEGORIES ∪ distinct categories in Inventory,
 * defaults first (owner's canonical order), extras appended sorted.
 * @returns {Promise<string[]>} Category labels.
 */
async function listCategories() {
  const m = await getMap();
  const seen = new Set(DEFAULT_CATEGORIES.map((c) => c.toLowerCase()));
  const extras = [];
  for (const c of m.values()) {
    if (c && !seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase());
      extras.push(c);
    }
  }
  extras.sort((a, b) => a.localeCompare(b));
  return [...DEFAULT_CATEGORIES, ...extras];
}

/**
 * Stamp a design's category onto every Inventory row of that design
 * (column W), then force-refresh the snapshot so the new label is visible
 * immediately (categoryOfSync included).
 * @param {object} p Params.
 * @param {string} p.design Design number.
 * @param {string} p.category Category label (canonicalized here).
 * @param {string} [p.updatedBy] Requesting user id (audit trail lives in AuditLog).
 * @param {string} [p.requestId] Approval request id (audit trail lives in AuditLog).
 * @returns {Promise<{design: string, category: string, rows: number}>}
 */
async function setCategory({ design, category }) {
  const d = String(design || '').trim();
  const cat = canonicalizeCategory(category, await listCategories());
  if (!d) throw new Error('designCategoriesRepository: design required');
  if (!cat) throw new Error('designCategoriesRepository: category required');
  const rows = await inventoryRepository.updateDesignCategory(d, cat);
  if (!rows) throw new Error(`designCategoriesRepository: no Inventory rows found for design "${d}"`);
  invalidateCache();
  await getMap();
  return { design: d, category: cat, rows };
}

/** Drop the snapshot (kept serving stale until the next refresh lands). */
function invalidateCache() {
  _mapTs = 0;
}

/**
 * Display icon for a category. Cashmere keeps its legacy 🧣; everything
 * else (including unmapped) uses the generic 🧵 fabric icon.
 * @param {string} category Category label.
 * @returns {string} Emoji icon.
 */
function iconFor(category) {
  return /cashmere/i.test(String(category || '')) ? '🧣' : '🧵';
}

module.exports = {
  getMap,
  categoryOf,
  categoryOfSync,
  listCategories,
  setCategory,
  invalidateCache,
  iconFor,
  normalizeDesign,
  canonicalizeCategory,
  DEFAULT_CATEGORIES,
};
