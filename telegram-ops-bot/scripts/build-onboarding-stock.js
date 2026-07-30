#!/usr/bin/env node
'use strict';

/**
 * AUD-X2 — regenerate src/data/onboardingStock.js from the owner's
 * "Stock Summary by Store" workbook.
 *
 *   node scripts/build-onboarding-stock.js ~/Stock_Summary_by_Store.xlsx
 *
 * WHY A GENERATOR AND NOT A ONE-OFF PASTE
 * The owner re-cuts this workbook as the physical audit progresses. Running
 * this script again replaces the list; hand-editing 130 labels would drift.
 *
 * WHAT IT DELIBERATELY DROPS
 * Quantities, rates and values are NOT carried into the bot. Two reasons:
 *   1. The audit is BLIND by design (WAU-3) — an auditor who can see the
 *      book number confirms it instead of counting it.
 *   2. It keeps ₦ valuations out of git.
 * Only the design LABEL, product and packaging travel — enough to print a
 * count sheet, not enough to leak the answer.
 *
 * LABELS MUST BE WHITESPACE-FREE
 * parseAuditBatch reads the design as the first whitespace-free token of a
 * line, so "402/9059 (08) = 12" would parse the design as "402/9059" and
 * choke on the rest. Every generated label is asserted space-free, and
 * disambiguated with the product when a design is not unique inside its
 * store (e.g. CHINOS STR carries 45008 as BOTH Chinos and DMS bales).
 */

const path = require('path');
const fs = require('fs');

const SRC_SHEET = 'Stock Summary';
const OUT = path.join(__dirname, '..', 'src', 'data', 'onboardingStock.js');

function readRows(file) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(file);
  if (!wb.Sheets[SRC_SHEET]) {
    throw new Error(`Workbook has no "${SRC_SHEET}" sheet (found: ${wb.SheetNames.join(', ')})`);
  }
  return XLSX.utils.sheet_to_json(wb.Sheets[SRC_SHEET], { header: 1, raw: false, defval: '' });
}

/** A store heading is a row with text in column A and nothing else. */
function isStoreHeading(row) {
  return row.slice(1).filter((c) => String(c || '').trim()).length === 0;
}

function parseWorkbook(rows) {
  const recs = [];
  let store = null;
  for (const r of rows) {
    const a = String(r[0] || '').trim();
    if (!a || a === 'PRODUCT NAME' || a.startsWith('STOCK SUMMARY') || a.startsWith('All colour')) continue;
    if (isStoreHeading(r)) { store = a; continue; }
    if (/TOTAL/i.test(a)) continue;
    const packaging = String(r[1] || '').trim();
    const design = String(r[2] || '').trim();
    if (!store || !design || !packaging) continue;
    recs.push({ store, product: a, packaging, design });
  }
  return recs;
}

const token = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '');

/**
 * A design number alone is not a key. Suffix the product when the same
 * store repeats a design across products or packaging types.
 */
function labelled(recs) {
  const perPack = new Map();
  const perStore = new Map();
  for (const r of recs) {
    const a = `${r.store}|${r.packaging}|${r.design}`;
    const b = `${r.store}|${r.design}`;
    if (!perPack.has(a)) perPack.set(a, new Set());
    perPack.get(a).add(r.product);
    if (!perStore.has(b)) perStore.set(b, new Set());
    perStore.get(b).add(r.packaging);
  }
  return recs.map((r) => {
    const ambiguous = perPack.get(`${r.store}|${r.packaging}|${r.design}`).size > 1
      || perStore.get(`${r.store}|${r.design}`).size > 1;
    return { ...r, label: ambiguous ? `${r.design}-${token(r.product)}` : r.design };
  });
}

function group(recs) {
  const out = {};
  for (const r of recs) {
    if (!out[r.store]) out[r.store] = new Map();
    if (!out[r.store].has(r.label)) {
      out[r.store].set(r.label, { label: r.label, product: r.product, packaging: r.packaging });
    }
  }
  const sorted = {};
  for (const store of Object.keys(out).sort()) {
    sorted[store] = [...out[store].values()].sort((a, b) =>
      a.packaging.localeCompare(b.packaging)
      || a.label.localeCompare(b.label, undefined, { numeric: true }));
  }
  return sorted;
}

/** A label with whitespace cannot survive the offline count-sheet round trip. */
function assertRoundTrips(byStore) {
  const bad = [];
  for (const [store, list] of Object.entries(byStore)) {
    for (const e of list) if (/\s/.test(e.label)) bad.push(`${store}: "${e.label}"`);
  }
  if (bad.length) {
    throw new Error(`Labels contain whitespace and would break the count sheet:\n  ${bad.join('\n  ')}`);
  }
}

function render(byStore, sourceName) {
  const stores = Object.keys(byStore);
  const total = stores.reduce((n, s) => n + byStore[s].length, 0);
  const body = stores.map((s) => {
    const lines = byStore[s]
      .map((e) => `    { label: ${JSON.stringify(e.label)}, product: ${JSON.stringify(e.product)}, packaging: ${JSON.stringify(e.packaging)} },`)
      .join('\n');
    return `  ${JSON.stringify(s)}: [\n${lines}\n  ],`;
  }).join('\n');
  return `'use strict';

/**
 * AUD-X2 — old-container stock awaiting onboarding, by store.
 *
 * GENERATED FILE — do not hand-edit.
 *   node scripts/build-onboarding-stock.js <Stock_Summary_by_Store.xlsx>
 * Source: ${sourceName} (${total} designs across ${stores.length} stores).
 *
 * These designs are NOT in the Inventory sheet: they arrived in containers
 * predating the spreadsheet, so the bot has no packing detail for them.
 * They exist here only so the audit flow can print a copy-paste count sheet
 * for the warehouse manager. Counts sent back land in StockTakes as
 * \`new_design\` rows for the owner to reconcile design by design.
 *
 * Nothing in this file is ever written to Inventory.
 *
 * Quantities, rates and values are deliberately absent — the audit is blind
 * (an auditor who sees the book number confirms it instead of counting it).
 */

/** @type {Record<string, Array<{label:string, product:string, packaging:string}>>} */
const ONBOARDING_STOCK = {
${body}
};

/** Store names carrying onboarding designs, sorted. */
function stores() {
  return Object.keys(ONBOARDING_STOCK).sort();
}

/**
 * Designs for a store, case-insensitively matched so "idumota" resolves.
 * @param {string} store
 * @param {{packaging?: string}} [opts] optional packaging filter (e.g. 'Bales')
 * @returns {Array<{label:string, product:string, packaging:string}>}
 */
function forStore(store, opts = {}) {
  const want = String(store || '').trim().toLowerCase();
  const key = Object.keys(ONBOARDING_STOCK).find((s) => s.toLowerCase() === want);
  if (!key) return [];
  const list = ONBOARDING_STOCK[key];
  if (!opts.packaging) return list.slice();
  const p = String(opts.packaging).toLowerCase();
  return list.filter((e) => e.packaging.toLowerCase() === p);
}

/** Distinct packaging types present for a store, sorted. */
function packagingFor(store) {
  return [...new Set(forStore(store).map((e) => e.packaging))].sort();
}

module.exports = { ONBOARDING_STOCK, stores, forStore, packagingFor };
`;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/build-onboarding-stock.js <Stock_Summary_by_Store.xlsx>');
    process.exit(1);
  }
  const byStore = group(labelled(parseWorkbook(readRows(file))));
  assertRoundTrips(byStore);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, render(byStore, path.basename(file)));
  const total = Object.values(byStore).reduce((n, l) => n + l.length, 0);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${total} designs across ${Object.keys(byStore).length} stores`);
  for (const [s, l] of Object.entries(byStore)) {
    const bales = l.filter((e) => e.packaging === 'Bales').length;
    console.log(`  ${s}: ${l.length} designs (${bales} in bales)`);
  }
}

if (require.main === module) main();

module.exports = { parseWorkbook, labelled, group, assertRoundTrips };
