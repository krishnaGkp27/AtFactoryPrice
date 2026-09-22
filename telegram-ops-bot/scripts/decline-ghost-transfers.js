#!/usr/bin/env node
'use strict';
/**
 * TRF-20 — decline the ghost transfers, exactly as the ✖ Decline button does.
 *
 * Only rows the census (`scripts/list-ghost-transfers.js`) calls ghosts are
 * touched: OPEN, at `requested` or `admin_review` — stages at which no bale
 * has moved, so declining moves nothing back. An in-transit row is never a
 * ghost here and is never declined by this script; that is a reversal and
 * a human's decision on the card.
 *
 * Each decline goes through `transferService.abort`, the same engine as the
 * button: status → rejected, Approver column stamped with the acting admin,
 * `transfer.declined` audit line. Nothing is deleted. What the button ALSO
 * does and this script does NOT: edit the tapped card and DM the requester
 * and the admins. So it prints, per declined row, who raised it — tell them.
 * A live Accept button on an old DM copy is refused by the flow's own status
 * check, so nothing can be dispatched against a declined row.
 *
 * SAFETY: dry-run by default — it writes only with --commit, and --commit
 * requires --as <adminTelegramId> so the record names a person.
 *
 * Usage:
 *   node scripts/decline-ghost-transfers.js                       # plan only
 *   node scripts/decline-ghost-transfers.js --as 777 --commit     # decline every ghost
 *   node scripts/decline-ghost-transfers.js --as 777 --ref TR-20260918-001 --ref TR-20260918-002 --commit
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const approvalQueueRepository = require('../src/repositories/approvalQueueRepository');
const transferService = require('../src/services/transferService');
const ghosts = require('../src/services/transferGhosts');
const config = require('../src/config');

function parseArgs(argv) {
  const args = { commit: false, as: null, refs: [] };
  const value = (name, v) => {
    if (v === undefined || String(v).trim() === '' || String(v).startsWith('--')) throw new Error(`${name} needs a value`);
    return String(v).trim();
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--as') { args.as = value('--as', argv[i + 1]); i += 1; }
    else if (a.startsWith('--as=')) args.as = value('--as', a.slice(5));
    else if (a === '--ref') { args.refs.push(value('--ref', argv[i + 1])); i += 1; }
    else if (a.startsWith('--ref=')) args.refs.push(value('--ref', a.slice(6)));
    else throw new Error(`unknown argument "${a}"`);
  }
  if (args.commit && !args.as) throw new Error('--commit needs --as <adminTelegramId>');
  if (args.as && !config.access.adminIds.includes(String(args.as))) throw new Error(`--as ${args.as} is not in ADMIN_IDS`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const rows = [...await approvalQueueRepository.getAllPending(), ...await approvalQueueRepository.getResolved()];
  let plan = ghosts.findGhosts(rows);
  if (args.refs.length) {
    const want = new Set(args.refs);
    const known = new Set(plan.map((g) => g.ghost.requestId));
    for (const r of want) if (!known.has(r)) throw new Error(`${r} is not a ghost — this script declines ghosts only`);
    plan = plan.filter((g) => want.has(g.ghost.requestId));
  }
  console.log(`${args.commit ? 'DECLINING' : 'DRY RUN — would decline'} ${plan.length} ghost transfer(s):`);
  for (const g of plan) console.log(`  ${g.ghost.requestId}  (${g.ghost.actionJSON.stage})  ↳ ${g.reason}`);
  if (!plan.length || !args.commit) {
    if (!args.commit && plan.length) console.log('\nRe-run with --as <adminTelegramId> --commit to write.');
    return;
  }
  let ok = 0;
  const tell = new Map();
  for (const g of plan) {
    try {
      const res = await transferService.abort(g.ghost.requestId, args.as);
      console.log(`  ${res.ok ? '✅' : '❌'} ${g.ghost.requestId}${res.ok ? ` → ${res.kind}` : ` — ${res.message}`}`);
      if (res.ok) { ok += 1; tell.set(String(g.ghost.user), [...(tell.get(String(g.ghost.user)) || []), g.ghost.requestId]); }
    } catch (e) {
      // One failed row must not strand the rest of the plan half-applied.
      console.log(`  ❌ ${g.ghost.requestId} — ${e.message}`);
    }
  }
  console.log(`\nDeclined ${ok}/${plan.length}.`);
  if (tell.size) {
    console.log('\nNobody was notified by this script. Tell the requesters:');
    for (const [user, refs] of tell) console.log(`  ${user}: ${refs.join(', ')} closed as duplicates of transfers that went ahead`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
