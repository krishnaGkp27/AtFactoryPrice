#!/usr/bin/env node
'use strict';

/**
 * PAY-1 — release the bank-account registrations that were REJECTED before
 * the fix of 11-Nov-2026.
 *
 * 🏦 Register account writes the PaymentAccounts row as `pending`. Until
 * 11-Nov-2026 a rejection closed the request and left that row as it was,
 * and the door then refused the same number + bank for ever as "Already
 * registered … awaiting approval". The bot now sets the row to `inactive`
 * at the moment of rejection (`paymentService.releaseRejectedAccount`);
 * this one-off does the same for the rows rejected BEFORE that.
 *
 * What it changes: for each PaymentAccounts row that reads `pending` and
 * whose approval_request_id names an ApprovalQueue request that reads
 * `rejected`, the status cell (column G) is set to `inactive`. That one
 * cell and nothing else; no row is deleted or moved.
 *
 * What it never touches:
 *   - an `active` or already `inactive` row;
 *   - a row whose request is still pending, or was approved;
 *   - a row with no request id, or whose request id is not on the queue
 *     (listed for you to look at — a raise that failed half-way);
 *   - a request id the queue holds more than once unless EVERY copy is
 *     rejected, and a request that is not an account registration.
 *
 * SAFETY: dry run by default — it reads both sheets, prints what it would
 * change and writes nothing. Only --commit writes.
 *
 *   node scripts/release-rejected-registrations.js            # list only
 *   node scripts/release-rejected-registrations.js --commit   # set those rows to inactive
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ACTION = 'register_payment_account';
const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Decide what the release would do with each PaymentAccounts row. Pure —
 * exported so the selection rules are pinned without a sheet.
 *
 * @param {{accounts: Array<object>, queue: Array<object>}} args
 *   accounts: paymentAccountsRepository.getAllStrict() shape
 *   queue: approvalQueueRepository.getAllWithRowIndex() shape
 * @returns {{release: Array<{account: object, request: object}>,
 *            kept: Array<{account: object, why: string}>}}
 *   release — pending rows whose request was rejected;
 *   kept — every OTHER pending row, with the reason it is left alone
 *   (rows that are not pending appear in neither list)
 */
function planRelease({ accounts, queue }) {
  const byId = new Map();
  for (const q of queue || []) {
    const id = String((q && q.requestId) == null ? '' : q.requestId).trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(q);
  }
  const release = [];
  const kept = [];
  for (const account of accounts || []) {
    if (!account || lower(account.status) !== 'pending') continue;
    const id = String(account.approval_request_id == null ? '' : account.approval_request_id).trim();
    if (!id) { kept.push({ account, why: 'no request id on the row' }); continue; }
    const rows = byId.get(id) || [];
    if (!rows.length) { kept.push({ account, why: `request ${id} is not on the ApprovalQueue — look at it by hand` }); continue; }
    if (rows.some((q) => ((q.actionJSON && q.actionJSON.action) || '') !== ACTION)) {
      kept.push({ account, why: `request ${id} is not an account registration` });
      continue;
    }
    const statuses = [...new Set(rows.map((q) => lower(q.status) || '(blank)'))];
    if (statuses.length === 1 && statuses[0] === 'rejected') { release.push({ account, request: rows[0] }); continue; }
    kept.push({
      account,
      why: statuses.length > 1
        ? `request ${id} is on the ApprovalQueue ${rows.length} times (${statuses.join(' / ')})`
        : `request ${id} ${statusWords(statuses[0])}`,
    });
  }
  return { release, kept };
}

function statusWords(status) {
  if (status === 'pending') return 'is still pending';
  if (status === 'approved') return 'was approved';
  return `reads "${status}"`;
}

const describe = (a) => `${a.account_id}  row ${a.rowIndex || '?'}  ${a.owner_name || '(no name)'} · ${a.bank || '(no bank)'} ${a.account_number || ''}`.trimEnd();

/** The listing the owner reads before saying --commit. Pure. */
function renderPlan(plan, { commit = false } = {}) {
  const lines = [];
  if (!plan.release.length) {
    lines.push('No pending registration belongs to a rejected request. Nothing to release.');
  } else {
    lines.push(`${commit ? 'RELEASING' : 'DRY RUN — would release'} ${plan.release.length} rejected registration(s) (status pending → inactive):`);
    for (const { account, request } of plan.release) {
      const when = String(request.resolvedAt || '').slice(0, 10);
      lines.push(`  ${describe(account)}  ← ${request.requestId} rejected${when ? ` ${when}` : ''}${request.approver ? ` by ${request.approver}` : ''}`);
    }
  }
  if (plan.kept.length) {
    lines.push('');
    lines.push(`Left exactly as they are — ${plan.kept.length} other pending row(s):`);
    for (const { account, why } of plan.kept) lines.push(`  ${describe(account)}  — ${why}`);
  }
  if (plan.release.length && !commit) {
    lines.push('');
    lines.push('Nothing was written. Re-run with --commit to set those rows to inactive.');
  }
  return lines;
}

/**
 * Read both sheets, print the plan and — only with `commit` — write it.
 * @param {{commit?: boolean, log?: Function}} [opts]
 * @returns {Promise<{plan: object, released: number, failed: number}>}
 */
async function run({ commit = false, log = console.log } = {}) {
  const paymentAccountsRepo = require('../src/repositories/paymentAccountsRepository');
  const approvalQueueRepository = require('../src/repositories/approvalQueueRepository');
  // Both reads are the strict ones: a sheet that cannot be read stops the
  // run here — it is never taken for "no such request".
  const [accounts, queue] = await Promise.all([
    paymentAccountsRepo.getAllStrict(),
    approvalQueueRepository.getAllWithRowIndex(),
  ]);
  const plan = planRelease({ accounts, queue });
  for (const line of renderPlan(plan, { commit })) log(line);
  if (!commit || !plan.release.length) return { plan, released: 0, failed: 0 };

  log('');
  let released = 0; let failed = 0;
  for (const { account } of plan.release) {
    try {
      // Status cell only — setStatus writes column G of that row and nothing else.
      const row = await paymentAccountsRepo.setStatus(account.account_id, 'inactive');
      if (row && row.status === 'inactive') { released += 1; log(`  ✅ ${account.account_id} → inactive`); } else { failed += 1; log(`  ❌ ${account.account_id} — row not found`); }
    } catch (e) {
      // One refused write must not strand the rest of the list.
      failed += 1;
      log(`  ❌ ${account.account_id} — ${e.message}`);
    }
  }
  log('');
  log(`Released ${released}/${plan.release.length}${failed ? ` · ${failed} failed (run it again)` : ''}.`);
  if (released) log('Those account numbers can now be registered again from 🏦 Register account. Nobody was notified by this script.');
  return { plan, released, failed };
}

module.exports = { planRelease, renderPlan, run };

if (require.main === module) {
  const unknown = process.argv.slice(2).filter((a) => a !== '--commit');
  if (unknown.length) { console.error(`unknown argument "${unknown[0]}" — the only flag is --commit`); process.exit(1); }
  run({ commit: process.argv.includes('--commit') })
    .then((r) => { if (r.failed) process.exit(1); })
    .catch((e) => { console.error(`release-rejected-registrations failed: ${e.message}`); process.exit(1); });
}
