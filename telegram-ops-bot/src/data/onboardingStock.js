'use strict';

/**
 * AUD-X2 — old-container stock awaiting onboarding, by store.
 *
 * GENERATED FILE — do not hand-edit.
 *   node scripts/build-onboarding-stock.js <Stock_Summary_by_Store.xlsx>
 * Source: a5a9a526-Stock_Summary_by_Store.xlsx (125 designs across 4 stores).
 *
 * These designs are NOT in the Inventory sheet: they arrived in containers
 * predating the spreadsheet, so the bot has no packing detail for them.
 * They exist here only so the audit flow can print a copy-paste count sheet
 * for the warehouse manager. Counts sent back land in StockTakes as
 * `new_design` rows for the owner to reconcile design by design.
 *
 * Nothing in this file is ever written to Inventory.
 *
 * Quantities, rates and values are deliberately absent — the audit is blind
 * (an auditor who sees the book number confirms it instead of counting it).
 */

/** @type {Record<string, Array<{label:string, product:string, packaging:string}>>} */
const ONBOARDING_STOCK = {
  "CASHMERE STR": [
    { label: "44444-PureWater", product: "Pure Water", packaging: "Bales" },
    { label: "42171", product: "TR", packaging: "Rolls" },
    { label: "44110", product: "Cashmere", packaging: "Rolls" },
    { label: "44140", product: "Cashmere", packaging: "Rolls" },
    { label: "44144", product: "Cashmere", packaging: "Rolls" },
    { label: "44147", product: "Cashmere", packaging: "Rolls" },
    { label: "44176", product: "Cashmere", packaging: "Rolls" },
  ],
  "CHINOS STR": [
    { label: "3001,YC-01", product: "Senator", packaging: "Bales" },
    { label: "3002", product: "Senator", packaging: "Bales" },
    { label: "16100", product: "Senator", packaging: "Bales" },
    { label: "42171", product: "TR", packaging: "Bales" },
    { label: "44137", product: "Cashmere", packaging: "Bales" },
    { label: "44141", product: "Cashmere", packaging: "Bales" },
    { label: "44143", product: "Cashmere", packaging: "Bales" },
    { label: "44144", product: "Cashmere", packaging: "Bales" },
    { label: "44147", product: "Cashmere", packaging: "Bales" },
    { label: "44176", product: "Cashmere", packaging: "Bales" },
    { label: "44205", product: "Cashmere", packaging: "Bales" },
    { label: "45006", product: "Gabardine", packaging: "Bales" },
    { label: "45008-Chinos", product: "Chinos", packaging: "Bales" },
    { label: "45008-DMS", product: "DMS", packaging: "Bales" },
    { label: "45009", product: "Chinos", packaging: "Bales" },
    { label: "45010", product: "Chinos", packaging: "Bales" },
    { label: "47014,2084/01", product: "Senator", packaging: "Bales" },
    { label: "55170-A,YC-03", product: "Senator", packaging: "Bales" },
    { label: "55170-B,YC-03", product: "Senator", packaging: "Bales" },
    { label: "80044-A", product: "Senator", packaging: "Bales" },
    { label: "80045-B", product: "Senator", packaging: "Bales" },
    { label: "93652-A", product: "Senator", packaging: "Bales" },
    { label: "93652-B", product: "Senator", packaging: "Bales" },
    { label: "A", product: "T-shirts", packaging: "Bales" },
  ],
  "IDUMOTA": [
    { label: "1214", product: "Senator", packaging: "Bales" },
    { label: "4444", product: "T-shirts", packaging: "Bales" },
    { label: "8004", product: "Senator", packaging: "Bales" },
    { label: "16159", product: "Cashmere HQ", packaging: "Bales" },
    { label: "42016", product: "Senator", packaging: "Bales" },
    { label: "44176", product: "Cashmere", packaging: "Bales" },
    { label: "44232", product: "Cashmere", packaging: "Bales" },
    { label: "45008", product: "Chinos", packaging: "Bales" },
    { label: "45010-ChinosHQ", product: "Chinos HQ", packaging: "Bales" },
    { label: "45014", product: "Chinos HQ", packaging: "Bales" },
    { label: "49002", product: "Senator", packaging: "Bales" },
    { label: "75276", product: "Senator_Feb25", packaging: "Bales" },
    { label: "75277", product: "Senator_Feb25", packaging: "Bales" },
    { label: "75279", product: "Senator_Feb25", packaging: "Bales" },
    { label: "77006", product: "Senator_Feb25", packaging: "Bales" },
    { label: "77007", product: "Senator_Feb25", packaging: "Bales" },
    { label: "Kitton", product: "Senator", packaging: "Bales" },
    { label: "1-Cashmere", product: "Cashmere", packaging: "Rolls" },
    { label: "1-Senator", product: "Senator", packaging: "Rolls" },
  ],
  "MAIN OFFICE": [
    { label: "1214", product: "Senator", packaging: "Bales" },
    { label: "8003", product: "Senator", packaging: "Bales" },
    { label: "8004", product: "Senator", packaging: "Bales" },
    { label: "45010-Chinos", product: "Chinos", packaging: "Bales" },
    { label: "49001", product: "Senator", packaging: "Bales" },
    { label: "75145-DMS", product: "DMS", packaging: "Bales" },
    { label: "1-Bag", product: "Bag", packaging: "Pieces" },
    { label: "1-Cap", product: "Cap", packaging: "Pieces" },
    { label: "1-Childrentop", product: "Children top", packaging: "Pieces" },
    { label: "1-Kaftan", product: "Kaftan", packaging: "Pieces" },
    { label: "1-LadiesBoxers", product: "Ladies Boxers", packaging: "Pieces" },
    { label: "1-LadiesGown", product: "Ladies Gown", packaging: "Pieces" },
    { label: "1-Newsilk", product: "New silk", packaging: "Pieces" },
    { label: "1-Nikker", product: "Nikker", packaging: "Pieces" },
    { label: "1-Oldsilk", product: "Old silk", packaging: "Pieces" },
    { label: "1-Pant", product: "Pant", packaging: "Pieces" },
    { label: "1-Shirt", product: "Shirt", packaging: "Pieces" },
    { label: "1-Singlet", product: "Singlet", packaging: "Pieces" },
    { label: "1-Skirt", product: "Skirt", packaging: "Pieces" },
    { label: "1-Socks", product: "Socks", packaging: "Pieces" },
    { label: "1-Tshirts", product: "T-shirts", packaging: "Pieces" },
    { label: "1,2…..9", product: "Ladies Gown", packaging: "Pieces" },
    { label: "2-LadiesBoxers", product: "Ladies Boxers", packaging: "Pieces" },
    { label: "2-LadiesGown", product: "Ladies Gown", packaging: "Pieces" },
    { label: "2-Newsilk", product: "New silk", packaging: "Pieces" },
    { label: "2-Oldsilk", product: "Old silk", packaging: "Pieces" },
    { label: "3-LadiesBoxers", product: "Ladies Boxers", packaging: "Pieces" },
    { label: "3-LadiesGown", product: "Ladies Gown", packaging: "Pieces" },
    { label: "3-Newsilk", product: "New silk", packaging: "Pieces" },
    { label: "3-Oldsilk", product: "Old silk", packaging: "Pieces" },
    { label: "4-LadiesBoxers", product: "Ladies Boxers", packaging: "Pieces" },
    { label: "4-LadiesGown", product: "Ladies Gown", packaging: "Pieces" },
    { label: "4-Newsilk", product: "New silk", packaging: "Pieces" },
    { label: "4-Oldsilk", product: "Old silk", packaging: "Pieces" },
    { label: "5-LadiesBoxers", product: "Ladies Boxers", packaging: "Pieces" },
    { label: "5-LadiesGown", product: "Ladies Gown", packaging: "Pieces" },
    { label: "5-Newsilk", product: "New silk", packaging: "Pieces" },
    { label: "5-Oldsilk", product: "Old silk", packaging: "Pieces" },
    { label: "6-LadiesGown", product: "Ladies Gown", packaging: "Pieces" },
    { label: "6-Newsilk", product: "New silk", packaging: "Pieces" },
    { label: "6-Oldsilk", product: "Old silk", packaging: "Pieces" },
    { label: "7-LadiesGown", product: "Ladies Gown", packaging: "Pieces" },
    { label: "7-Oldsilk", product: "Old silk", packaging: "Pieces" },
    { label: "8-LadiesGown", product: "Ladies Gown", packaging: "Pieces" },
    { label: "8-Oldsilk", product: "Old silk", packaging: "Pieces" },
    { label: "9-LadiesGown", product: "Ladies Gown", packaging: "Pieces" },
    { label: "9-Oldsilk", product: "Old silk", packaging: "Pieces" },
    { label: "10", product: "Old silk", packaging: "Pieces" },
    { label: "11", product: "Old silk", packaging: "Pieces" },
    { label: "112", product: "Kaftan new1", packaging: "Pieces" },
    { label: "115", product: "Kaftan new1", packaging: "Pieces" },
    { label: "116", product: "Kaftan new1", packaging: "Pieces" },
    { label: "118", product: "Kaftan new1", packaging: "Pieces" },
    { label: "119", product: "Kaftan new1", packaging: "Pieces" },
    { label: "120", product: "Kaftan new1", packaging: "Pieces" },
    { label: "121", product: "Kaftan new1", packaging: "Pieces" },
    { label: "122", product: "Kaftan new1", packaging: "Pieces" },
    { label: "123", product: "Kaftan new1", packaging: "Pieces" },
    { label: "124", product: "Kaftan new1", packaging: "Pieces" },
    { label: "151", product: "Kaftan new1", packaging: "Pieces" },
    { label: "1-Senator", product: "Senator", packaging: "Rolls" },
    { label: "2-Senator", product: "Senator", packaging: "Rolls" },
    { label: "3-Senator", product: "Senator", packaging: "Rolls" },
    { label: "4-Senator", product: "Senator", packaging: "Rolls" },
    { label: "5-Senator", product: "Senator", packaging: "Rolls" },
    { label: "6-Senator", product: "Senator", packaging: "Rolls" },
    { label: "7-Senator", product: "Senator", packaging: "Rolls" },
    { label: "4444", product: "Pure Water", packaging: "Rolls" },
    { label: "42171", product: "TR", packaging: "Rolls" },
    { label: "44176", product: "Cashmere", packaging: "Rolls" },
    { label: "45006", product: "Gabardine", packaging: "Rolls" },
    { label: "45007", product: "Chinos", packaging: "Rolls" },
    { label: "45008", product: "Chinos", packaging: "Rolls" },
    { label: "45009", product: "Chinos", packaging: "Rolls" },
    { label: "55001", product: "DMS", packaging: "Rolls" },
  ],
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
