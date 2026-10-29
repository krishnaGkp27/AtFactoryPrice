#!/usr/bin/env node
'use strict';

/**
 * seed-locations — CRM-R1 (owner, 30-Oct-2026).
 *
 * Writes the three rows the region split needs into the Locations register
 * (LOC-1), skipping any place already registered:
 *
 *   Lagos        → Lagos   (warehouse)
 *   IDUMOTA      → Lagos   (store)
 *   Kano office  → Kano    (store)
 *
 * Dry run by default — prints what it WOULD append. `--commit` appends.
 * Edit the ROWS below (or the sheet by hand) for other places.
 *
 *   node scripts/seed-locations.js
 *   node scripts/seed-locations.js --commit
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROWS = [
  { name: 'Lagos', location: 'Lagos', kind: 'warehouse' },
  { name: 'IDUMOTA', location: 'Lagos', kind: 'store' },
  { name: 'Kano office', location: 'Kano', kind: 'store' },
];

async function main() {
  const commit = process.argv.includes('--commit');
  const repo = require('../src/repositories/locationsRepository');
  const have = await repo.getAll();
  const haveNames = new Set(have.map((p) => String(p.name || '').trim().toUpperCase()));
  const todo = ROWS.filter((r) => !haveNames.has(r.name.toUpperCase()));
  console.log(`Locations register: ${have.length} row(s) today.`);
  for (const r of ROWS) {
    const tag = haveNames.has(r.name.toUpperCase()) ? 'already there' : (commit ? 'APPEND' : 'would append');
    console.log(`  ${r.name.padEnd(12)} → ${r.location.padEnd(6)} (${r.kind})  ${tag}`);
  }
  if (!todo.length) { console.log('Nothing to do.'); return; }
  if (!commit) { console.log(`\nDry run — ${todo.length} row(s) to add. Re-run with --commit to write them.`); return; }
  for (const r of todo) {
    await repo.append({ ...r, status: 'active', notes: 'seeded by scripts/seed-locations.js (CRM-R1)', updated_by: 'script' });
    console.log(`  appended ${r.name}`);
  }
  console.log('Done.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
