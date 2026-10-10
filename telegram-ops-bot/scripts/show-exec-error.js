#!/usr/bin/env node
'use strict';
/**
 * Why did an APPROVED request fail to execute?
 *
 * When the executor refuses or throws after an admin's Approve, the admin's
 * chat gets `⚠️ Approved but execution failed: <reason>` (or `⚠️ Error:
 * <reason>`) and the requester gets only "was approved but could not be
 * completed". The reason is also recorded in Railway Postgres
 * (`usage_events`, event `exec_error`, meta.message / meta.error — ANL-2).
 * This prints, for one request id or short ref:
 *
 *   1. the ApprovalQueue row (status, action, who decided, when);
 *   2. every `exec_error` / `approval_executed` usage event for it, newest
 *      first, with the recorded reason.
 *
 * READ-ONLY. Writes nothing. Needs the Railway env (DATABASE_URL + the
 * Sheets credentials). Usage:
 *   node scripts/show-exec-error.js 939ce162-0229-4111-a059-acdb2c647e3f
 *   node scripts/show-exec-error.js R-939C
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

function matchesRef(requestId, ref) {
  const id = String(requestId || '');
  const cleanId = upper(id).replace(/[^A-Z0-9]/g, '');
  const cleanRef = upper(ref).replace(/^R-/, '').replace(/[^A-Z0-9]/g, '');
  if (!cleanRef) return false;
  if (upper(id) === upper(ref) || cleanId === cleanRef) return true;
  return cleanRef.length === 4 && cleanId.startsWith(cleanRef);
}

async function main() {
  const ref = process.argv[2];
  if (!ref) {
    console.error('usage: node scripts/show-exec-error.js <request id | R-XXXX>');
    process.exit(2);
  }
  const queueRepo = require('../src/repositories/approvalQueueRepository');
  const rows = await queueRepo.getAllWithRowIndex();
  const hits = rows.filter((r) => matchesRef(r.requestId, ref));
  if (!hits.length) {
    console.log(`No ApprovalQueue row matches ${ref}.`);
  }
  for (const q of hits) {
    const aj = q.actionJSON || {};
    console.log('── ApprovalQueue row ──');
    console.log(`request  : ${q.requestId}`);
    console.log(`action   : ${aj.action || '(none)'}${aj.customer ? ` · customer ${aj.customer}` : ''}${aj.warehouse ? ` · ${aj.warehouse}` : ''}`);
    console.log(`status   : ${q.status}${q.approver ? ` · by ${q.approver}` : ''}${q.resolvedAt ? ` · ${q.resolvedAt}` : ''}`);
    console.log(`raised   : ${q.createdAt || '?'} by user ${q.user}`);
    const items = Array.isArray(aj.items) ? aj.items : (aj.packageNo ? [{ packageNo: aj.packageNo, thanNo: aj.thanNo }] : []);
    if (items.length) console.log(`items    : ${items.map((it) => `${it.packageNo}${it.thanNo ? `/${it.thanNo}` : ''}`).join(' · ')}`);
    console.log('');
  }

  const pg = require('../src/db/postgresPool');
  if (!pg.isEnabled()) {
    console.log('Postgres is not configured here (DATABASE_URL missing) — the recorded reason lives in usage_events on Railway.');
    return;
  }
  const ids = hits.length ? hits.map((h) => h.requestId) : [ref];
  const { rows: ev } = await pg.query(
    `SELECT ts, user_id, event, duration_ms, meta
       FROM usage_events
      WHERE request_id = ANY($1) AND event IN ('exec_error', 'approval_executed', 'approval_approved', 'approval_rejected')
      ORDER BY ts DESC LIMIT 20`,
    [ids],
  );
  console.log(`── usage_events (${ev.length}) ──`);
  if (!ev.length) console.log('none recorded for this request (the executor may have been reached before ANL-2, or the event buffer was lost on a restart)');
  for (const e of ev) {
    const meta = typeof e.meta === 'string' ? (() => { try { return JSON.parse(e.meta); } catch (_) { return { raw: e.meta }; } })() : (e.meta || {});
    const reason = meta.message || meta.error || '';
    console.log(`${new Date(e.ts).toISOString()}  ${e.event.padEnd(18)} user ${e.user_id}  ${e.duration_ms != null ? `${e.duration_ms} ms` : ''}${reason ? `\n    → ${reason}` : ''}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
