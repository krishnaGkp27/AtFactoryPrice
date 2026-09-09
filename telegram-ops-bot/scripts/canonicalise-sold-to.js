'use strict';

/**
 * ISC-1 Phase 2b — rewrite Inventory column L (SoldTo) to the registry's
 * spelling for the buyer clusters the owner ruled on.
 *
 * WHY (ISC-1 §2b). SoldTo is free text; one buyer sits under several
 * spellings (R1 Awunawu ×3, R2 Oshodi ×4). Merge Customers only adds
 * aliases, and seven readers still compare the raw cell, so the history
 * stays split until the CELL says the canonical name. This is the second
 * half of the order locked in §4 2b: merge in-bot first (dual-admin, keeps
 * every old spelling resolvable), THEN rewrite the cell.
 *
 * What it does, and nothing else:
 *   1. reads Inventory (fresh) and Customers through their repositories;
 *   2. builds the plan with src/services/soldToCanonicaliser — a cluster
 *      is READY only when its canonical names exactly one live Customers
 *      row and every ruled variant already resolves to that customer;
 *      otherwise it is BLOCKED ("run Merge Customers first (CUS-1)") and
 *      not one of its cells is touched;
 *   3. prints every write (row · current → next) before writing anything;
 *   4. with --commit, re-reads column L in one call immediately before the
 *      single batch write and SKIPS any cell whose value no longer equals
 *      the plan (the CUS-ID1 guard) — reported, never guessed.
 *
 * It never creates, merges or edits a Customers row (that is the in-bot
 * dual-admin door) and never writes any column but L.
 *
 * SAFETY: dry-run by default — it only writes when you pass --commit.
 *
 * Usage:
 *   node scripts/canonicalise-sold-to.js                       # dry-run, R1 + R2
 *   node scripts/canonicalise-sold-to.js --cluster Awunawu     # one cluster only
 *   node scripts/canonicalise-sold-to.js --map rulings.json    # replace the map
 *   node scripts/canonicalise-sold-to.js --commit              # apply
 *
 * A --map file is a JSON array: [{"canonical": "...", "variants": ["..."]}].
 *
 * Requires the same .env (Google Sheets credentials) as the bot.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const sheets = require('../src/repositories/sheetsClient');
const inventoryRepository = require('../src/repositories/inventoryRepository');
const customersRepository = require('../src/repositories/customersRepository');
const canonicaliser = require('../src/services/soldToCanonicaliser');

const SHEET = 'Inventory';
const COLUMN = 'L'; // SoldTo — the ONLY column this script writes

const str = (v) => String(v == null ? '' : v).trim();
const lower = (v) => str(v).toLowerCase();

/**
 * @param {string[]} argv process.argv
 * @returns {{commit:boolean, mapFile:string|null, cluster:string|null}}
 */
function parseArgs(argv) {
  const args = { commit: false, mapFile: null, cluster: null };
  // A switch that takes a value must GET one: a dangling `--map` or
  // `--cluster` (end of line, or followed by another switch) is a hard
  // failure, never a silent fall-back to the default map / every cluster —
  // under --commit that fall-back would widen a live write past what was typed.
  const value = (name, v) => {
    if (v === undefined || str(v) === '' || String(v).startsWith('--')) {
      throw new Error(`${name} needs a value`);
    }
    return v;
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--map') { args.mapFile = value('--map', argv[i + 1]); i += 1; }
    else if (a.startsWith('--map=')) args.mapFile = value('--map', a.slice('--map='.length));
    else if (a === '--cluster') { args.cluster = value('--cluster', argv[i + 1]); i += 1; }
    else if (a.startsWith('--cluster=')) args.cluster = value('--cluster', a.slice('--cluster='.length));
    else throw new Error(`unknown argument "${a}"`);
  }
  return args;
}

/**
 * The default R1 + R2 map, or the JSON array in `mapFile` — validated
 * either way so a typo in a hand-written map stops the run.
 * @param {string|null} mapFile
 * @returns {Array<{canonical:string, variants:string[]}>}
 */
function loadClusters(mapFile) {
  if (!mapFile) return canonicaliser.DEFAULT_CLUSTERS.map((c) => ({ ...c, variants: [...c.variants] }));
  const file = path.resolve(mapFile);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`--map ${file}: ${e.message}`, { cause: e });
  }
  canonicaliser.validateClusters(parsed);
  return parsed;
}

/**
 * `--cluster <name>` — keep only the cluster whose canonical matches
 * (case-insensitive). Unknown name → hard failure, never a silent no-op.
 */
function selectClusters(clusters, name) {
  const hit = clusters.filter((c) => lower(c.canonical) === lower(name));
  if (!hit.length) {
    throw new Error(`--cluster "${name}" is not in the map (have: ${clusters.map((c) => c.canonical).join(', ')})`);
  }
  return hit;
}

/**
 * Read both sheets and build the plan. Reads only.
 * @param {Array<{canonical:string, variants:string[]}>} clusters
 * @returns {Promise<{clusters:object[], plan:object[]}>}
 */
async function plan(clusters) {
  const rows = await inventoryRepository.getAll(true);
  const customers = await customersRepository.getAll();
  return canonicaliser.buildPlan(rows, clusters, customers);
}

/**
 * The printed plan — per cluster: status + reason, the spellings found,
 * and every exact write. Returned as text so the tests can pin it.
 * @param {{clusters:object[], plan:object[]}} result
 * @returns {string}
 */
function render(result) {
  const out = [];
  for (const c of result.clusters) {
    out.push('');
    if (c.status === 'ready') {
      out.push(`Cluster "${c.canonical}" → Customers row ${c.target.rowIndex} "${c.target.name}" (${c.target.customer_id || 'no id'})   READY`);
    } else {
      out.push(`Cluster "${c.canonical}"   BLOCKED — ${c.reason}`);
      for (const p of c.problems) out.push(`  • ${p}`);
    }
    const found = Object.entries(c.counts).map(([s, n]) => {
      const tag = c.target && s === c.target.name ? ' (already canonical)' : '';
      return `"${s}" ×${n}${tag}`;
    });
    out.push(`  spellings in ${SHEET}!${COLUMN}: ${found.length ? found.join(' · ') : '(none)'}`);
    for (const u of c.unruled) {
      out.push(`  row ${String(u.rowIndex).padEnd(5)} "${u.current}" — NOT in the ruling (casing differs), left alone`);
    }
    if (c.status !== 'ready') {
      out.push(`  ${c.rows.length} cell(s) would be affected once merged — left untouched now`);
      continue;
    }
    out.push(`  ${c.writes} cell(s) to rewrite, ${c.rows.length - c.writes} already canonical:`);
    for (const r of c.rows) {
      if (r.next === r.current) continue;
      out.push(`    row ${String(r.rowIndex).padEnd(5)} ${COLUMN}: "${r.current}"  →  "${r.next}"`);
    }
  }
  return out.join('\n');
}

/**
 * Write the plan. Column L is re-read in ONE call right before the single
 * batch write; every target cell is compared to the plan and a cell that
 * moved since the plan is skipped and reported (the CUS-ID1 guard).
 * @param {Array<{rowIndex:number,current:string,next:string,cluster:string}>} entries
 * @returns {Promise<{written:number, skipped:Array<{rowIndex:number,current:string,live:string}>}>}
 */
async function apply(entries) {
  const skipped = [];
  if (!entries.length) return { written: 0, skipped };

  const live = await sheets.readRange(SHEET, `${COLUMN}2:${COLUMN}`);
  const updates = [];
  for (const e of entries) {
    const cell = str((live[e.rowIndex - 2] || [])[0]);
    if (cell !== e.current) {
      skipped.push({ rowIndex: e.rowIndex, current: e.current, live: cell });
      continue;
    }
    updates.push({ range: `${COLUMN}${e.rowIndex}`, values: [[e.next]] });
  }
  if (updates.length) await sheets.batchUpdateRanges(SHEET, updates);
  inventoryRepository.invalidateCache();
  customersRepository.invalidateCache();
  return { written: updates.length, skipped };
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  console.log(`ISC-1 2b canonicalise SoldTo — sheet="${SHEET}" column=${COLUMN} `
    + `mode=${args.commit ? 'COMMIT (will write)' : 'DRY-RUN (no writes)'}`);

  let clusters = loadClusters(args.mapFile);
  if (args.cluster) clusters = selectClusters(clusters, args.cluster);
  console.log(`clusters: ${clusters.map((c) => `${c.canonical} [${c.variants.join(' | ')}]`).join(' ; ')}`);

  const result = await plan(clusters);
  console.log(render(result));

  const planned = result.plan.length;
  if (!args.commit) {
    console.log('\nDRY-RUN: nothing written. Re-run with --commit to apply.');
    console.log(`SUMMARY planned=${planned} written=0 skipped=0`);
    return { planned, written: 0, skipped: [] };
  }

  const { written, skipped } = await apply(result.plan);
  for (const s of skipped) {
    console.log(`  row ${s.rowIndex}: SKIPPED — cell now reads "${s.live}", plan expected "${s.current}"`);
  }
  console.log(`\n${written ? '✅' : 'ℹ️'} Wrote ${written} cell(s) in ${SHEET}!${COLUMN}; no other column touched.`);
  console.log(`SUMMARY planned=${planned} written=${written} skipped=${skipped.length}`);
  return { planned, written, skipped };
}

// Importable so the plan and the guarded write can be exercised against a
// fake sheet with no credentials — this rewrites live business records, so
// its behaviour is pinned by tests rather than trusted.
if (require.main === module) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = {
  parseArgs, loadClusters, selectClusters, plan, render, apply, main, SHEET, COLUMN,
};
