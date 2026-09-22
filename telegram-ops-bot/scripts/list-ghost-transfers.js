#!/usr/bin/env node
'use strict';
/**
 * TRF-20 — read-only census of ghost and stale transfers.
 *
 * A GHOST is an open transfer at a pre-dispatch stage whose load (route +
 * lines) was also raised as another row that went further — dispatched or
 * received. It is the copy the operation no longer needs, sitting in every
 * list as if it were work. STALE is an open row older than --days (default
 * 14) that is not a ghost: nobody has acted, a human decides.
 *
 * Reads ApprovalQueue through its repository. Writes nothing.
 *
 * Usage:
 *   node scripts/list-ghost-transfers.js [--days 14] [--json]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const approvalQueueRepository = require('../src/repositories/approvalQueueRepository');
const ghosts = require('../src/services/transferGhosts');

function parseArgs(argv) {
  const args = { days: 14, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--days') { args.days = parseInt(argv[i + 1], 10); i += 1; }
    else if (a.startsWith('--days=')) args.days = parseInt(a.slice(7), 10);
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!Number.isFinite(args.days) || args.days < 0) throw new Error('--days needs a number');
  return args;
}

function describe(r) {
  const aj = r.actionJSON || {};
  const bales = (aj.lines || []).reduce((s, l) => s + (parseInt(l.qty, 10) || 0), 0);
  const designs = [...new Set((aj.lines || []).map((l) => l.design))].join(',');
  const age = ghosts.ageDays(r);
  return `${r.requestId}  ${String(r.createdAt || '').slice(0, 10)}  ${aj.from} → ${aj.to}  ${bales}B  ${designs}  stage=${aj.stage || '-'}  by ${r.user}${age == null ? '' : `  ${age}d`}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const rows = [...await approvalQueueRepository.getAllPending(), ...await approvalQueueRepository.getResolved()];
  const found = ghosts.findGhosts(rows);
  const stale = ghosts.staleOpen(rows, args.days);
  const open = rows.filter((r) => ghosts._internals.isTransfer(r) && ghosts._internals.isOpen(r));
  if (args.json) {
    console.log(JSON.stringify({
      openTransfers: open.length,
      ghosts: found.map((g) => ({ ghost: g.ghost.requestId, twin: g.twin.requestId, reason: g.reason })),
      stale: stale.map((r) => r.requestId),
    }, null, 2));
    return;
  }
  console.log(`Transfers: ${open.length} open of ${rows.filter(ghosts._internals.isTransfer).length} ever.\n`);
  console.log(`GHOSTS — ${found.length} (open, pre-dispatch, and the same load went further):`);
  for (const g of found) console.log(`  ${describe(g.ghost)}\n      ↳ ${g.reason}`);
  if (!found.length) console.log('  none');
  console.log(`\nSTALE — ${stale.length} (open for more than ${args.days} days, not a ghost — a human decides):`);
  for (const r of stale) console.log(`  ${describe(r)}`);
  if (!stale.length) console.log('  none');
  console.log(`\nReal open work: ${open.length - found.length} transfer(s).`);
  console.log('\nTo close the ghosts: node scripts/decline-ghost-transfers.js --as <adminTelegramId> [--commit]');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
