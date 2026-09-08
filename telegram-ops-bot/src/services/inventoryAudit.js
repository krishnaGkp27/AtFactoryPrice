'use strict';

/**
 * inventoryAudit — ISC-1 Phase 1a (specs/ISC-1_INVENTORY_SHEET_CLEANUP.md
 * §2 findings, §4 plan step 1a/1b).
 *
 * PURE functions over PARSED Inventory rows — the object shape
 * inventoryRepository.parseRow produces (packageNo, indent, csNo, design,
 * shade, thanNo, yards, status, warehouse, pricePerYard, dateReceived,
 * soldTo, soldDate, netMtrs, netWeight, updatedAt, productType, baleUid,
 * addedAt, grnId, binLocation, arrivalBatch, designCategory, rowIndex,
 * _legacy). Nothing here reads a sheet, writes a cell or decides a repair:
 * every function returns a LIST for a human (or the sentinel) to look at,
 * and the Phase 2 one-offs consume those lists only after the owner's
 * rulings R1–R11.
 *
 * WHY. The owner's 04-Sep-2026 PDF census (§2) found, row by row: 105 sold
 * rows whose SoldDate is word-prefixed text the bot cannot date (§2a); one
 * bale_uid on two thans and 2,853 legacy rows keyed by row position (§2e);
 * `4-5` vs `4-5.` shade spellings inside one design and 188 blank shades
 * (§2c); three customer spelling clusters behind seven alias-blind SoldTo
 * readers (§2b); 46 thans of 40 yards or more (§2d); 374 SOLD rows at ₦0
 * (§2d). A PDF cannot show a cell's TYPE and a census cannot re-run itself,
 * so those questions are asked HERE, by code that the read-only audit
 * script (scripts/audit-inventory-sheet.js) and the daily sentinel
 * (consistencySentinel C9–C11) both call. One implementation, re-runnable
 * after every one-off to confirm zero remaining.
 *
 * Every finding carries the sheet rowIndex so a one-off can re-read the
 * exact cell before touching it (the CUS-ID1 guard pattern).
 *
 * customerSpellingClusters is CANDIDATES ONLY: it groups spellings that
 * LOOK like one person; it never merges, renames or decides. Which cluster
 * is one person is the owner's ruling (R1–R3) — BUSINESS_RULES §12, no
 * guessing.
 */

const { normalizeSalesDate } = require('../utils/dates');

/** Synthetic uid the parser injects on rows with a blank column R. */
const LEGACY_UID_PREFIX = 'BAL-LEGACY-';

/** Threshold from which a than is "two 30-yard thans booked as one" (§2d). */
const DEFAULT_OVERSIZE_YARDS = 40;

/** Keys shorter than this are too short for a one-edit match to mean anything. */
const MIN_FUZZY_KEY_LENGTH = 6;

/** Cluster reasons — wording is printed in the audit report. */
const REASON_SAME_LETTERS = 'same letters (case/punctuation only)';
const REASON_SAME_WORDS = 'same words, different order';
const REASON_ONE_EDIT = 'one letter apart';

/** The classes dateShapes sorts raw cells into, in report order. */
const DATE_SHAPES = [
  'iso', 'day-monthname-year', 'day-monthname-year-spaces', 'dmy-numeric',
  'timestamp', 'text-with-word-prefix', 'other', 'blank',
];

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const isSold = (r) => str(r && r.status).toLowerCase() === 'sold';
const byRowIndex = (a, b) => (a.rowIndex || 0) - (b.rowIndex || 0);
const designKey = (design) => str(design).toUpperCase();

/* ─────────────────────────── §2a dates ─────────────────────────── */

/**
 * Sold rows whose SoldDate is non-blank and does NOT normalise — the
 * `cashmere 12-February-2026` class the bot cannot date. parseRow's isoDay
 * leaves unparseable text UNCHANGED (a sold row must stay sold), so a
 * parsed soldDate that normalizeSalesDate cannot read is junk.
 *
 * A BLANK soldDate on a sold row is a different finding and is skipped here.
 *
 * @param {Array<object>} rows parsed Inventory rows
 * @returns {Array<{rowIndex:number, design:string, packageNo:string, thanNo:number, soldTo:string, soldDate:string}>}
 */
function unparseableSoldDates(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!isSold(r)) continue;
    const soldDate = str(r.soldDate);
    if (!soldDate) continue;
    if (normalizeSalesDate(soldDate)) continue;
    out.push({
      rowIndex: r.rowIndex, design: str(r.design), packageNo: str(r.packageNo),
      thanNo: r.thanNo, soldTo: str(r.soldTo), soldDate,
    });
  }
  return out.sort(byRowIndex);
}

/**
 * Classify ONE raw (formatted) date cell. Exposed for dateShapes and tests.
 *
 * `text-with-word-prefix` = one or more letter-only words, then something
 * normalizeSalesDate can read (`cashmere 12-February-2026`); a word prefix
 * with an unreadable tail is `other`.
 *
 * @param {*} raw the cell as the FORMATTED read returns it
 * @returns {string} one of DATE_SHAPES
 */
function dateShape(raw) {
  const s = str(raw);
  if (!s) return 'blank';
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return 'iso';
  if (/^\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}/.test(s)) return 'timestamp';
  if (/^\d{1,2}-\p{L}+-\d{4}$/u.test(s)) return 'day-monthname-year';
  if (/^\d{1,2} \p{L}+ \d{4}$/u.test(s)) return 'day-monthname-year-spaces';
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(s)) return 'dmy-numeric';
  const tokens = s.split(/\s+/);
  for (let k = 1; k < tokens.length; k += 1) {
    if (!/^\p{L}+$/u.test(tokens[k - 1])) break;
    if (normalizeSalesDate(tokens.slice(k).join(' '))) return 'text-with-word-prefix';
  }
  return 'other';
}

/**
 * Census of the SHAPES a date column holds. Takes RAW cells from a
 * formatted read — NOT parsed rows, which parseRow has already normalised
 * to ISO and so would all read as `iso`.
 *
 * @param {Array<*>} rawCells one entry per row, the cell as displayed
 * @returns {{counts: Record<string, number>, examples: Record<string, string[]>}}
 *   counts for every class (zero included); up to 3 DISTINCT examples per class
 */
function dateShapes(rawCells) {
  const counts = {};
  const examples = {};
  for (const shape of DATE_SHAPES) { counts[shape] = 0; examples[shape] = []; }
  for (const raw of rawCells || []) {
    const shape = dateShape(raw);
    counts[shape] += 1;
    const s = str(raw);
    if (shape !== 'blank' && examples[shape].length < 3 && !examples[shape].includes(s)) examples[shape].push(s);
  }
  return { counts, examples };
}

/**
 * The TYPE of a cell as an UNFORMATTED read returns it: a real date cell is
 * a serial NUMBER (days since 1899-12-30), a text cell a string. In a date
 * column any number is a date serial — that is the whole reason the audit
 * reads unformatted (spec §6: a PDF, or a formatted read, cannot show this).
 * A string of nothing but whitespace is BLANK, as parseRow (which trims)
 * and the display (which shows nothing) both already treat it.
 *
 * @param {*} unformatted the cell from readRangeUnformatted
 * @returns {'date'|'text'|'blank'}
 */
function cellType(unformatted) {
  if (typeof unformatted === 'number') return Number.isFinite(unformatted) ? 'date' : 'text';
  // A whitespace-only cell (a hand-typed space) is blank: parseRow trims it
  // to '' and the display shows nothing, so the type must agree with both.
  return str(unformatted) ? 'text' : 'blank';
}

/**
 * Google Sheets date serial → ISO calendar day (the fraction is the time of
 * day and is dropped). Null for anything that is not a finite number.
 *
 * @param {*} serial
 * @returns {string|null} YYYY-MM-DD
 */
function serialToIso(serial) {
  if (serial === null || serial === undefined || !str(serial)) return null;
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * One line per SOLD row: what column M holds, what TYPE the cell is, and
 * what the bot reads from it. This is the list the Phase 2a one-off
 * consumes (and re-runs against to confirm zero remaining).
 *
 * @param {Array<object>} rows parsed Inventory rows
 * @param {Map<number, *>} [formattedM] rowIndex → column M as displayed
 *   (falls back to the parsed soldDate when a row is missing)
 * @param {Map<number, *>} [unformattedM] rowIndex → column M unformatted
 * @returns {Array<{rowIndex:number, bale:string, design:string, thanNo:number,
 *   buyer:string, raw:string, cellType:string, normalised:string|null, serialIso:string|null}>}
 */
function soldDateCensus(rows, formattedM = new Map(), unformattedM = new Map()) {
  const out = [];
  for (const r of rows || []) {
    if (!isSold(r)) continue;
    const raw = formattedM.has(r.rowIndex) ? str(formattedM.get(r.rowIndex)) : str(r.soldDate);
    const unf = unformattedM.has(r.rowIndex) ? unformattedM.get(r.rowIndex) : undefined;
    const type = unformattedM.has(r.rowIndex) ? cellType(unf) : (raw ? 'text' : 'blank');
    out.push({
      rowIndex: r.rowIndex, bale: str(r.packageNo), design: str(r.design), thanNo: r.thanNo,
      buyer: str(r.soldTo), raw, cellType: type,
      normalised: raw ? (normalizeSalesDate(raw) || null) : null,
      serialIso: type === 'date' ? serialToIso(unf) : null,
    });
  }
  return out.sort(byRowIndex);
}

/* ─────────────────────────── §2e identity ─────────────────────────── */

/** A uid the sheet actually holds — not the parser's positional stand-in. */
function isRealUid(uid) {
  const u = str(uid);
  return !!u && !u.startsWith(LEGACY_UID_PREFIX);
}

/**
 * Real bale_uids present on more than one row. Synthetic `BAL-LEGACY-<row>`
 * ids are NEVER duplicates: they are minted per row at read time and mean
 * "column R is blank", which is legacyRows' finding, not this one.
 *
 * @param {Array<object>} rows parsed Inventory rows
 * @returns {Array<{baleUid:string, rows:number[]}>}
 */
function duplicateUids(rows) {
  const byUid = new Map();
  for (const r of rows || []) {
    const uid = str(r.baleUid);
    if (!isRealUid(uid)) continue;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(r.rowIndex);
  }
  const out = [];
  for (const [baleUid, rowIndexes] of byUid) {
    if (rowIndexes.length > 1) out.push({ baleUid, rows: rowIndexes.slice().sort((a, b) => a - b) });
  }
  return out.sort((a, b) => a.rows[0] - b.rows[0]);
}

/**
 * Rows the parser marked legacy (blank column R → positional uid). These
 * are re-keyed by any sort or row insert until the backfill (§4, 2c) runs.
 *
 * @param {Array<object>} rows parsed Inventory rows
 * @returns {{count:number, rowIndexes:number[]}}
 */
function legacyRows(rows) {
  const rowIndexes = (rows || [])
    .filter((r) => r._legacy === true || str(r.baleUid).startsWith(LEGACY_UID_PREFIX))
    .map((r) => r.rowIndex)
    .sort((a, b) => a - b);
  return { count: rowIndexes.length, rowIndexes };
}

/* ─────────────────────────── §2c spellings ─────────────────────────── */

/** Canonical shade: trim, uppercase, trailing dots stripped (`4-5.` → `4-5`). */
function canonicalShade(shade) {
  return str(shade).toUpperCase().replace(/\.+$/, '').trim();
}

/**
 * Per design (case-insensitive), shades whose canonical form is shared by
 * two or more DIFFERENT raw spellings — `4-5` and `4-5.` on 75142 show as
 * two chips for one shade. `4-5` vs `4-6` are two shades, not a variant.
 *
 * @param {Array<object>} rows parsed Inventory rows
 * @returns {Array<{design:string, canonical:string, variants:Array<{shade:string, rows:number[]}>}>}
 */
function shadeSpellingVariants(rows) {
  const designs = new Map(); // designKey → { design, byCanonical: Map<canonical, Map<rawShade, rowIndexes>> }
  for (const r of rows || []) {
    const shade = str(r.shade);
    if (!shade) continue;
    const dk = designKey(r.design);
    if (!designs.has(dk)) designs.set(dk, { design: str(r.design), byCanonical: new Map() });
    const d = designs.get(dk);
    const canonical = canonicalShade(shade);
    if (!d.byCanonical.has(canonical)) d.byCanonical.set(canonical, new Map());
    const spellings = d.byCanonical.get(canonical);
    if (!spellings.has(shade)) spellings.set(shade, []);
    spellings.get(shade).push(r.rowIndex);
  }
  const out = [];
  for (const d of designs.values()) {
    for (const [canonical, spellings] of d.byCanonical) {
      if (spellings.size < 2) continue;
      out.push({
        design: d.design,
        canonical,
        variants: [...spellings].map(([shade, rowIndexes]) => ({ shade, rows: rowIndexes })),
      });
    }
  }
  return out.sort((a, b) => a.design.localeCompare(b.design) || a.canonical.localeCompare(b.canonical));
}

/**
 * Rows with NO shade, grouped by design — the suffix-as-shade designs
 * (`9037-D`, `9059-C`, …) and the three shadeless `9043-A` rows (§2c, R6).
 *
 * @param {Array<object>} rows parsed Inventory rows
 * @returns {Array<{design:string, rows:number[]}>}
 */
function blankShadesByDesign(rows) {
  const byDesign = new Map();
  for (const r of rows || []) {
    if (str(r.shade)) continue;
    const dk = designKey(r.design);
    if (!byDesign.has(dk)) byDesign.set(dk, { design: str(r.design), rows: [] });
    byDesign.get(dk).rows.push(r.rowIndex);
  }
  return [...byDesign.values()].sort((a, b) => a.design.localeCompare(b.design));
}

/* ─────────────────────────── §2d quantities & money ─────────────────────────── */

/**
 * Thans of `minYards` or more — the 6061 pattern (two 30-yard thans booked
 * as one). Each is a physical audit and an EDB-1 Edit Bale job, never a
 * script write.
 *
 * @param {Array<object>} rows parsed Inventory rows
 * @param {{minYards?: number}} [opts] default 40
 * @returns {Array<{rowIndex:number, design:string, packageNo:string, indent:string,
 *   arrivalBatch:string, thanNo:number, yards:number, status:string, warehouse:string, soldTo:string}>}
 */
function oversizeThans(rows, { minYards = DEFAULT_OVERSIZE_YARDS } = {}) {
  return (rows || [])
    .filter((r) => Number(r.yards) >= minYards)
    .map((r) => ({
      rowIndex: r.rowIndex, design: str(r.design), packageNo: str(r.packageNo), indent: str(r.indent),
      arrivalBatch: str(r.arrivalBatch), thanNo: r.thanNo, yards: Number(r.yards),
      status: str(r.status), warehouse: str(r.warehouse), soldTo: str(r.soldTo),
    }))
    .sort(byRowIndex);
}

/**
 * SOLD rows with a zero PricePerYard, grouped by sale (design · bale ·
 * buyer · date) — the rows behind a ₦0/PAID invoice (§2d, R7: listed only;
 * the money side is deferred to the finance pass).
 *
 * @param {Array<object>} rows parsed Inventory rows
 * @returns {Array<{design:string, packageNo:string, soldTo:string, soldDate:string, rows:number[]}>}
 */
function zeroPriceSold(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    if (!isSold(r)) continue;
    if ((Number(r.pricePerYard) || 0) !== 0) continue;
    const g = { design: str(r.design), packageNo: str(r.packageNo), soldTo: str(r.soldTo), soldDate: str(r.soldDate) };
    const k = [g.design, g.packageNo, g.soldTo, g.soldDate].join('|');
    if (!groups.has(k)) groups.set(k, { ...g, rows: [] });
    groups.get(k).rows.push(r.rowIndex);
  }
  return [...groups.values()].sort((a, b) => a.rows[0] - b.rows[0]);
}

/* ─────────────────────────── §2b customers ─────────────────────────── */

/** lowercase · trim · collapse whitespace · a–z 0–9 only. */
function normKey(name) {
  return str(name).toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9]/g, '');
}

/** The same letters as normKey, but per word and order-independent. */
function tokenKey(name) {
  return str(name).toLowerCase().split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Damerau-Levenshtein distance (optimal string alignment: insert, delete,
 * substitute, or swap two ADJACENT characters, each costing 1).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function damerauLevenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) d[i][0] = i;
  for (let j = 0; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/**
 * CANDIDATE clusters of SoldTo spellings that look like one person.
 *
 * NOTHING HERE MERGES ANYTHING. The output is a list for the owner to rule
 * on (R1–R3); BUSINESS_RULES §12 forbids guessing which customer a name
 * means, and the Phase 2b one-off touches a cell only for a cluster the
 * owner has ruled on, spelling by spelling.
 *
 * Grouping, in order:
 *   1. same normalised key (lowercase, trim, collapse whitespace, strip
 *      non-alphanumerics) — `Awunawu` / `awunawu`;
 *   2. same word-token SET ignoring order — `madam oshodi` / `oshodi madam`;
 *   3. normalised keys within Damerau-Levenshtein distance 1 when BOTH are
 *      at least 6 characters — `awunawu` / `awurawu`. Shorter keys are too
 *      short for one edit to mean anything.
 * Groups merge transitively; only clusters with 2+ distinct spellings are
 * returned. `Ketu madam` / `ketu police Man` share a word but not the set
 * and are far apart as keys, so they do NOT cluster.
 *
 * @param {Array<object>} rows parsed Inventory rows (any status; only rows with a buyer count)
 * @returns {Array<{members:Array<{soldTo:string, rows:number[], warehouses:string[]}>, reason:string}>}
 */
function customerSpellingClusters(rows) {
  const bySpelling = new Map();
  for (const r of rows || []) {
    const name = str(r.soldTo);
    if (!name) continue;
    if (!bySpelling.has(name)) bySpelling.set(name, { soldTo: name, rows: [], warehouses: new Set() });
    const e = bySpelling.get(name);
    e.rows.push(r.rowIndex);
    if (str(r.warehouse)) e.warehouses.add(str(r.warehouse));
  }
  const entries = [...bySpelling.values()];
  const keys = entries.map((e) => normKey(e.soldTo));
  const toks = entries.map((e) => tokenKey(e.soldTo));

  const edges = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (keys[i] && keys[i] === keys[j]) edges.push({ i, j, reason: REASON_SAME_LETTERS });
      else if (toks[i] && toks[i] === toks[j]) edges.push({ i, j, reason: REASON_SAME_WORDS });
      else if (keys[i].length >= MIN_FUZZY_KEY_LENGTH && keys[j].length >= MIN_FUZZY_KEY_LENGTH
        && Math.abs(keys[i].length - keys[j].length) <= 1
        && damerauLevenshtein(keys[i], keys[j]) <= 1) edges.push({ i, j, reason: REASON_ONE_EDIT });
    }
  }

  const parent = entries.map((_, i) => i);
  const find = (i) => {
    let x = i;
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (const e of edges) {
    const a = find(e.i);
    const b = find(e.j);
    if (a !== b) parent[b] = a;
  }

  const clusters = new Map(); // root → { members: [], reasons: Set }
  for (let i = 0; i < entries.length; i += 1) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, { members: [], reasons: new Set() });
    clusters.get(root).members.push(entries[i]);
  }
  for (const e of edges) clusters.get(find(e.i)).reasons.add(e.reason);

  const reasonOrder = [REASON_SAME_LETTERS, REASON_SAME_WORDS, REASON_ONE_EDIT];
  const out = [];
  for (const c of clusters.values()) {
    if (c.members.length < 2) continue;
    const members = c.members
      .map((m) => ({ soldTo: m.soldTo, rows: m.rows.slice().sort((a, b) => a - b), warehouses: [...m.warehouses].sort() }))
      .sort((a, b) => b.rows.length - a.rows.length || a.soldTo.localeCompare(b.soldTo));
    out.push({ members, reason: reasonOrder.filter((r) => c.reasons.has(r)).join('; ') });
  }
  const size = (c) => c.members.reduce((n, m) => n + m.rows.length, 0);
  return out.sort((a, b) => size(b) - size(a) || a.members[0].soldTo.localeCompare(b.members[0].soldTo));
}

/* ─────────────────────────── blanks ─────────────────────────── */

/** Parsed fields whose blank is the empty string. */
const STRING_FIELDS = [
  'packageNo', 'indent', 'csNo', 'design', 'shade', 'status', 'warehouse', 'dateReceived',
  'soldTo', 'soldDate', 'updatedAt', 'productType', 'addedAt', 'grnId', 'binLocation',
  'arrivalBatch', 'designCategory',
];
/** Parsed fields the parser numbers — a blank cell and a 0 both read 0. */
const NUMBER_FIELDS = ['thanNo', 'yards', 'pricePerYard', 'netMtrs', 'netWeight'];

/**
 * Per parsed field: how many rows have nothing in it, out of how many.
 *
 * Read the numbers with the parser in mind: number fields count 0 as
 * blank (a blank cell parses to 0); `baleUid` counts the parser's
 * `_legacy` flag (column R blank) rather than the injected stand-in;
 * `status`, `productType` and `addedAt` are DEFAULTED by the parser
 * (`available`, `fabric`, column K), so their blank counts are after
 * those defaults.
 *
 * @param {Array<object>} rows parsed Inventory rows
 * @returns {Record<string, {blank:number, total:number}>}
 */
function blankRates(rows) {
  const list = rows || [];
  const total = list.length;
  const out = {};
  for (const f of STRING_FIELDS) out[f] = { blank: list.filter((r) => !str(r[f])).length, total };
  for (const f of NUMBER_FIELDS) out[f] = { blank: list.filter((r) => !(Number(r[f]) || 0)).length, total };
  out.baleUid = { blank: legacyRows(list).count, total };
  return out;
}

/* ─────────────────────────── all at once ─────────────────────────── */

/**
 * Every row-level finding list in one call — what the audit script prints
 * and files. dateShapes / cellType / soldDateCensus need the RAW cells and
 * are called separately by the script.
 *
 * @param {Array<object>} rows parsed Inventory rows
 * @param {{minYards?: number}} [opts]
 * @returns {{unparseableSoldDates:Array, duplicateUids:Array, shadeVariants:Array,
 *   blankShades:Array, legacy:{count:number, rowIndexes:number[]}, oversize:Array,
 *   zeroPriceSold:Array, customerClusters:Array, blankRates:object}}
 */
function audit(rows, opts = {}) {
  return {
    unparseableSoldDates: unparseableSoldDates(rows),
    duplicateUids: duplicateUids(rows),
    shadeVariants: shadeSpellingVariants(rows),
    blankShades: blankShadesByDesign(rows),
    legacy: legacyRows(rows),
    oversize: oversizeThans(rows, opts),
    zeroPriceSold: zeroPriceSold(rows),
    customerClusters: customerSpellingClusters(rows),
    blankRates: blankRates(rows),
  };
}

module.exports = {
  audit,
  unparseableSoldDates,
  dateShape,
  dateShapes,
  cellType,
  serialToIso,
  soldDateCensus,
  duplicateUids,
  legacyRows,
  shadeSpellingVariants,
  blankShadesByDesign,
  oversizeThans,
  zeroPriceSold,
  customerSpellingClusters,
  blankRates,
  DATE_SHAPES,
  LEGACY_UID_PREFIX,
  DEFAULT_OVERSIZE_YARDS,
  _internals: { damerauLevenshtein, normKey, tokenKey, canonicalShade, isRealUid },
};
