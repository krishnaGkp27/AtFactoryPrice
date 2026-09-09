#!/usr/bin/env node
'use strict';

/**
 * PAY-2 — rebuild `payment_reasons` from the ApprovalQueue payloads.
 *
 * Every `request_payment` queue row carries the typed `reason` in its
 * ActionJSON (column C) — that is the raw record. The Postgres row written
 * at submit is fail-open, so a Postgres hiccup leaves a gap this script
 * closes: one `payment_reasons` row per payment_id that has none yet.
 *
 * DRY RUN by default — prints the plan as a table and writes nothing.
 *   node scripts/backfill-payment-reasons.js            # plan only
 *   node scripts/backfill-payment-reasons.js --commit   # insert the missing rows
 *
 * Never touches a sheet. Never re-inserts a payment already present.
 * Requester names come from the Users sheet (id → name); a name the sheet
 * no longer has is stored as the bare id's empty name, never invented.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const COMMIT = process.argv.includes('--commit');

/**
 * Decide what the backfill would do with each queue row. Pure — exported
 * so the selection rules are pinned without a sheet or a database.
 *
 * @param {{rows: Array<object>, existing: Set<string>, namesById?: Map<string,string>}} args
 *   rows: approvalQueueRepository.getAllWithRowIndex() shape
 *   existing: payment_ids already in payment_reasons
 * @returns {{inserts: Array<object>, skipped: Array<{requestId:string, paymentId:string, why:string}>}}
 */
function planBackfill({ rows, existing, namesById }) {
  const names = namesById || new Map();
  const present = new Set([...(existing || [])].map(String));
  const inserts = [];
  const skipped = [];
  const seen = new Set();
  for (const row of rows || []) {
    const aj = row && row.actionJSON && typeof row.actionJSON === 'object' ? row.actionJSON : {};
    if (aj.action !== 'request_payment') continue;
    const paymentId = String(aj.payment_id || '').trim();
    const reason = String(aj.reason || '').trim();
    const requestId = String(row.requestId || '');
    if (!paymentId) { skipped.push({ requestId, paymentId: '', why: 'no payment_id on payload' }); continue; }
    if (!reason) { skipped.push({ requestId, paymentId, why: 'no reason on payload (pre-PAY-2)' }); continue; }
    if (present.has(paymentId)) { skipped.push({ requestId, paymentId, why: 'already in payment_reasons' }); continue; }
    if (seen.has(paymentId)) { skipped.push({ requestId, paymentId, why: 'duplicate queue row' }); continue; }
    seen.add(paymentId);
    const requesterId = String(row.user || '').trim();
    inserts.push({
      paymentId,
      approvalRequestId: requestId,
      requesterId,
      requesterName: names.get(requesterId) || '',
      payeeName: String(aj.payee_name || ''),
      payeeType: String(aj.payee_type || ''),
      amountNgn: Number(aj.amount_ngn) || 0,
      reasonText: reason,
      raisedAt: row.createdAt ? String(row.createdAt) : undefined,
    });
  }
  return { inserts, skipped };
}

/** The table the operator reads before saying --commit. Pure. */
function renderTable(plan, { commit = false } = {}) {
  const head = ['payment_id', 'request', 'requester', 'payee', 'amount', 'reason', 'action'];
  const lines = [];
  const body = [
    ...plan.inserts.map((i) => [i.paymentId, i.approvalRequestId, i.requesterName || i.requesterId,
      i.payeeName, String(i.amountNgn), i.reasonText, commit ? 'INSERT' : 'would insert']),
    ...plan.skipped.map((s) => [s.paymentId || '—', s.requestId, '', '', '', '', `skip: ${s.why}`]),
  ];
  const widths = head.map((h, c) => Math.min(40, Math.max(h.length, ...body.map((r) => String(r[c]).length))));
  const fmt = (r) => r.map((v, c) => String(v).slice(0, widths[c]).padEnd(widths[c])).join('  ');
  lines.push(fmt(head));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of body) lines.push(fmt(r));
  lines.push('');
  lines.push(`${plan.inserts.length} to insert · ${plan.skipped.length} skipped`);
  lines.push(commit
    ? 'COMMIT — the rows above are being written to payment_reasons.'
    : 'DRY RUN — nothing written. Re-run with --commit to insert.');
  return lines;
}

async function main() {
  const pool = require('../src/db/postgresPool');
  const approvalQueueRepository = require('../src/repositories/approvalQueueRepository');
  const usersRepository = require('../src/repositories/usersRepository');
  const paymentReasonsRepository = require('../src/repositories/paymentReasonsRepository');

  if (!pool.isEnabled()) {
    console.log('DATABASE_URL is not set — Postgres is off, so nothing can be read or written.');
    if (COMMIT) process.exit(1);
  }
  const [rows, users, existing] = await Promise.all([
    approvalQueueRepository.getAllWithRowIndex(),
    usersRepository.getAll(),
    paymentReasonsRepository.existingPaymentIds(),
  ]);
  const namesById = new Map((users || []).map((u) => [String(u.user_id), String(u.name || '')]));
  const plan = planBackfill({ rows, existing, namesById });
  for (const line of renderTable(plan, { commit: COMMIT })) console.log(line);
  if (!COMMIT) return;

  let ok = 0; let failed = 0;
  for (const i of plan.inserts) {
    const id = await paymentReasonsRepository.record(i);
    if (id == null) { failed += 1; console.log(`  FAILED ${i.paymentId} (see bot log)`); } else ok += 1;
  }
  console.log(`\nInserted ${ok}${failed ? ` · ${failed} failed` : ''}.`);
  await pool.close();
  if (failed) process.exit(1);
}

module.exports = { planBackfill, renderTable };

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
