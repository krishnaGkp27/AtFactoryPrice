'use strict';

/**
 * transferRepair — one-off guarded bale swap for transfer 02Aug·01
 * (owner-approved 02-Aug-2026).
 *
 * WHY: the typed order "Transfer packages 869,843,874,864,903 to Kano"
 * dropped its bale numbers at line-building (pre-TRF-14), so the dispatch
 * picker pre-ticked the FIFO neighbours 867/842/873/863 and those got
 * flipped in_transit while the truck physically carries 869/843/874/864.
 * 903 matched and is untouched.
 *
 * WHAT IT DOES — deliberately narrow:
 *   - targets ONE transfer, matched by a strict fingerprint: a TR-20260802-*
 *     row, IDUMOTA → Kano, whose logged bale set is exactly
 *     {842, 863, 867, 873, 903};
 *   - per pair (wrong → right), swaps the Inventory rows only when every
 *     state guard holds: the wrong rows are the very rows dispatch logged
 *     (by bale_uid) in the expected status/warehouse, and the right bale is
 *     available at the source with the same design+shade;
 *   - handles both lifecycle states: still in transit (pending) and already
 *     received (approved). A rejected transfer needs no swap (the reject
 *     already sent the logged rows home) — reported, not touched;
 *   - rewrites the queue row's bales / baleUids / dispatched lists so the
 *     receive/reject that follows flips the CORRECT rows;
 *   - every swap is audit-logged; admins get a summary DM and, while the
 *     transfer is still in transit, the receiver gets a corrected card.
 *
 * Idempotent: after the swap the logged bale set no longer matches the
 * fingerprint, so later boots find nothing and do nothing.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const mutex = require('../utils/asyncMutex');
const config = require('../config');
const logger = require('../utils/logger');

const AVAILABLE = 'available';
const IN_TRANSIT = 'in_transit';

/** The four wrong→right swaps (903 was correct). */
const SWAPS = [
  { wrong: '867', right: '869' },
  { wrong: '842', right: '843' },
  { wrong: '873', right: '874' },
  { wrong: '863', right: '864' },
];
const EXPECTED_BALES = ['842', '863', '867', '873', '903'];

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function sameSet(a, b) {
  const A = [...new Set((a || []).map(String))].sort();
  const B = [...new Set((b || []).map(String))].sort();
  return A.length === B.length && A.every((v, i) => v === B[i]);
}

/** Locate the one transfer this repair is approved for. */
async function findTarget() {
  const rows = await approvalQueueRepository.getAllWithRowIndex();
  return rows.find((r) => {
    if (!/^TR-20260802-\d+$/.test(String(r.requestId || ''))) return false;
    const aj = r.actionJSON || {};
    if (aj.action !== 'transfer_stock') return false;
    if (!norm(aj.from).includes('idumota') || !norm(aj.to).includes('kano')) return false;
    return sameSet(aj.bales, EXPECTED_BALES);
  }) || null;
}

/**
 * Run the guarded swap. Safe to call at every boot.
 * @param {object} [bot] Telegram bot for the notifications
 * @returns {Promise<{done:boolean, swapped:Array, skipped:Array, reason?:string}>}
 */
async function repair(bot) {
  const out = { done: false, swapped: [], skipped: [] };
  let target;
  try {
    target = await findTarget();
  } catch (e) {
    logger.warn(`transferRepair: queue read failed: ${e.message}`);
    return { ...out, reason: `queue read failed: ${e.message}` };
  }
  if (!target) return { ...out, reason: 'no matching transfer (already repaired or fingerprint changed)' };

  const requestId = String(target.requestId);
  // Same nesting order as transferService.dispatchInner: request lock, then
  // source-warehouse lock — serialized against a receive/reject/dispatch
  // racing this repair.
  return mutex.runExclusive(requestId, () =>
    mutex.runExclusive(`dispatch-wh:${norm((target.actionJSON || {}).from)}`, () =>
      repairInner(bot, requestId, out)));
}

async function repairInner(bot, requestId, out) {
  // Re-read inside the lock — the state may have moved since findTarget.
  const row = (await approvalQueueRepository.getAllWithRowIndex())
    .find((r) => String(r.requestId) === requestId);
  if (!row || !sameSet((row.actionJSON || {}).bales, EXPECTED_BALES)) {
    return { ...out, reason: 'transfer changed under the lock — nothing done' };
  }
  const aj = row.actionJSON;
  const status = norm(row.status);
  if (status === 'rejected') {
    return { ...out, reason: 'transfer was rejected — logged rows already went home, no swap needed' };
  }
  const received = status !== 'pending'; // 'approved' once the receiver confirmed
  // Expected location/status of the WRONG rows right now:
  const wrongStatus = received ? AVAILABLE : IN_TRANSIT;
  // in_transit rows already carry the destination in the warehouse column
  // (dispatch stamps it); received rows are available at the destination.
  const wrongWh = aj.to;

  const inv = await inventoryRepository.getAll(true);
  const loggedUids = new Set((aj.baleUids || []).map(String));
  let bales = (aj.bales || []).map(String);
  let baleUids = (aj.baleUids || []).map(String);
  const dispatched = (aj.dispatched || []).map((d) => ({ ...d, bales: (d.bales || []).map(String) }));

  for (const { wrong, right } of SWAPS) {
    const line = dispatched.find((d) => d.bales.includes(wrong));
    if (!line) { out.skipped.push({ wrong, right, reason: 'not in dispatched lines' }); continue; }
    // The exact rows dispatch flipped, in the state this repair expects.
    const wrongRows = inv.filter((r) => loggedUids.has(String(r.baleUid))
      && String(r.packageNo) === wrong
      && r.status === wrongStatus && norm(r.warehouse) === norm(wrongWh));
    if (!wrongRows.length) { out.skipped.push({ wrong, right, reason: `no ${wrong} rows in expected state (${wrongStatus} @ ${wrongWh})` }); continue; }
    // The bale that was physically taken — must be sitting "available" at the
    // source under the same design+shade, or the swap does not happen.
    const rightRows = inv.filter((r) => String(r.packageNo) === right
      && r.status === AVAILABLE && norm(r.warehouse) === norm(aj.from)
      && norm(r.design) === norm(line.design) && norm(r.shade) === norm(line.shade));
    if (!rightRows.length) { out.skipped.push({ wrong, right, reason: `${right} not available at ${aj.from} as ${line.design}/${line.shade}` }); continue; }

    const uidByRow = await inventoryRepository.ensureRowUids(rightRows);
    const rightUids = rightRows.map((r) => String(uidByRow.get(r.rowIndex)));
    const wrongUids = wrongRows.map((r) => String(r.baleUid));

    // Claim the right bale first; only then send the wrong one home. If the
    // second flip fails we are over-claimed (both marked moved) — loud, and
    // recoverable — never under-claimed (transfer pointing at nothing).
    const rightFlipped = await inventoryRepository.transitionBales([right], AVAILABLE,
      received ? AVAILABLE : IN_TRANSIT, aj.to, { uids: rightUids });
    if (!rightFlipped.length) { out.skipped.push({ wrong, right, reason: `flip of ${right} matched no rows (concurrent change)` }); continue; }
    const wrongFlipped = await inventoryRepository.transitionBales([wrong], wrongStatus, AVAILABLE, aj.from, { uids: wrongUids });
    if (!wrongFlipped.length) {
      out.skipped.push({ wrong, right, reason: `⚠️ ${right} claimed but ${wrong} did not flip back — check rows by hand` });
    }

    // Rewrite the transfer's logged lists so receive/reject flips the
    // corrected rows.
    line.bales = line.bales.map((b) => (b === wrong ? right : b));
    bales = bales.map((b) => (b === wrong ? right : b));
    baleUids = [...baleUids.filter((u) => !wrongUids.includes(u)), ...rightUids];
    out.swapped.push({ wrong, right, rows: wrongFlipped.length, rightRows: rightFlipped.length });
  }

  if (!out.swapped.length) return { ...out, reason: 'nothing swapped — every pair guarded out' };

  await approvalQueueRepository.updateActionJSON(requestId, {
    bales, baleUids, dispatched,
    repairedAt: new Date().toISOString(),
    repairNote: 'REP-2: FIFO-picked bales swapped to the typed/physical ones (owner, 02-Aug)',
  });
  await auditLogRepository.append('transfer.bale_repair',
    { requestId, swapped: out.swapped, skipped: out.skipped, received: status !== 'pending' }, 'system');
  out.done = true;

  await notify(bot, requestId, { ...aj, bales, baleUids, dispatched }, out, status);
  return out;
}

/** Admin summary + (in-transit only) corrected receiver card. */
async function notify(bot, requestId, aj, out, status) {
  if (!bot) return;
  const lines = out.swapped.map((s) => `  • ${s.wrong} → ${s.right}`).join('\n');
  const skips = out.skipped.length
    ? `\nSkipped:\n${out.skipped.map((s) => `  • ${s.wrong}: ${s.reason}`).join('\n')}` : '';
  const text = `🛠 *Transfer bale repair — ${requestId}*\n`
    + `The logged bales were corrected to the ones physically dispatched:\n${lines}${skips}\n`
    + `_Inventory rows and the transfer record now match the truck. 903 was already correct._`;
  for (const adminId of config.access.adminIds) {
    try { await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' }); } catch (_) { /* best-effort */ }
  }
  if (status === 'pending') {
    try {
      const transferFlow = require('../flows/transferFlow');
      const card = transferFlow._internals.receiverCard(requestId, aj);
      const target = String(aj.receiver || '');
      if (target) {
        await bot.sendMessage(target,
          `🛠 Bale numbers on this transfer were corrected — use this card:\n\n${card.text}`,
          { parse_mode: 'Markdown', reply_markup: card.kb });
      }
    } catch (e) {
      logger.warn(`transferRepair: receiver notify failed: ${e.message}`);
    }
  }
}

module.exports = { repair, _internals: { findTarget, sameSet, SWAPS, EXPECTED_BALES } };
