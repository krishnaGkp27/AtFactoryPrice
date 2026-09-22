#!/usr/bin/env node
'use strict';
/**
 * TRF-20 (6/8) — parity: does the Postgres `transfers` table agree with the
 * ApprovalQueue sheet? Read-only on both sides. Run daily during the shadow
 * period; the read flip (spec §3-G step 4) waits for a clean report.
 *
 * Prints: rows on each side, refs missing on either side, and rows whose
 * stage/status differ. Exit 0 always — it reports, it never repairs.
 *
 * Usage: node scripts/transfers-parity.js [--json]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const approvalQueueRepository = require('../src/repositories/approvalQueueRepository');
const pg = require('../src/repositories/transfersPgRepository');
const pool = require('../src/db/postgresPool');

async function main() {
  const json = process.argv.includes('--json');
  if (!pool.isEnabled()) { console.log('Postgres is not configured (DATABASE_URL unset) — nothing to compare.'); return; }
  const sheet = [...await approvalQueueRepository.getAllPending(), ...await approvalQueueRepository.getResolved()]
    .filter((r) => r.actionJSON && r.actionJSON.action === 'transfer_stock');
  const table = await pg.all();
  const bySheet = new Map(sheet.map((r) => [String(r.requestId), pg._internals.shape(r)]));
  const byTable = new Map(table.map((r) => [String(r.ref), r]));
  const missingInTable = [...bySheet.keys()].filter((k) => !byTable.has(k));
  const missingInSheet = [...byTable.keys()].filter((k) => !bySheet.has(k));
  const differ = [];
  for (const [ref, s] of bySheet) {
    const t = byTable.get(ref);
    if (!t) continue;
    if (t.stage !== s.stage || t.status !== s.status) differ.push({ ref, sheet: `${s.stage}/${s.status}`, table: `${t.stage}/${t.status}` });
  }
  const out = { sheetRows: sheet.length, tableRows: table.length, missingInTable, missingInSheet, differ };
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`Sheet: ${sheet.length} transfer rows · Table: ${table.length} rows`);
  console.log(`Missing in table (${missingInTable.length}): ${missingInTable.join(', ') || 'none'}`);
  console.log(`Missing in sheet (${missingInSheet.length}): ${missingInSheet.join(', ') || 'none'}`);
  console.log(`Stage/status differ (${differ.length}):`);
  for (const d of differ) console.log(`  ${d.ref}  sheet=${d.sheet}  table=${d.table}`);
  console.log(!missingInTable.length && !missingInSheet.length && !differ.length ? '\nPARITY OK' : '\nNOT IN PARITY — do not flip reads yet');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
