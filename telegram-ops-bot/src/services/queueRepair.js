'use strict';

/**
 * queueRepair — TRID-1 duplicate-transfer-id repair (owner-approved 01-Aug).
 *
 * WHY: transfer ids (TR-YYYYMMDD-NNN) were minted from an in-memory daily
 * counter that reset on every deploy, so two transfers created the same day
 * around a restart could share one id. All by-id routing (cards, dispatch,
 * receive, docs) resolves to the FIRST sheet row, stranding the newer
 * pending transfer behind the older resolved one.
 *
 * WHAT IT DOES — deliberately narrow:
 *   - considers ONLY well-formed transfer ids (TR-8digits-Nseq);
 *   - renames ONLY PENDING rows whose id collides with a RESOLVED row —
 *     the resolved row keeps the original id (audit history, Drive
 *     captions and old chat references stay truthful);
 *   - new id = same date part, next unused sequence across the whole
 *     queue, so short refs keep their day ("31Jul·02");
 *   - compare-and-set by physical row — a concurrent write aborts that
 *     rename rather than touching the wrong row;
 *   - pending-vs-pending collisions are LOGGED but left alone (no
 *     resolved row involved — outside the approved repair);
 *   - every rename is audit-logged and the actionable person (dispatcher
 *     for a requested transfer, receiver for an in-transit one) gets a
 *     fresh card with the new id — their old card's buttons carry the old
 *     id, which now correctly answers "already closed".
 *
 * WHAT IT CANNOT AFFECT: Inventory rows carry no transfer id (transitions
 * write status/warehouse/timestamps only), Transactions are written at
 * execution with their own ids, and AuditLog is append-only history. The
 * rename touches exactly one cell (column A) of the pending queue row.
 *
 * Idempotent: once ids are unique it finds nothing and does nothing, so it
 * is safe to run at every boot.
 */

const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const logger = require('../utils/logger');

const TR_ID = /^TR-(\d{8})-(\d+)$/;

/** Next unused sequence for `date` given every id already in the queue
 *  (plus ids assigned earlier in this same run). */
function nextFreeId(date, usedIds) {
  let max = 0;
  for (const id of usedIds) {
    const m = TR_ID.exec(String(id || ''));
    if (m && m[1] === date) max = Math.max(max, parseInt(m[2], 10));
  }
  return `TR-${date}-${String(max + 1).padStart(3, '0')}`;
}

/** Best-effort fresh card to whoever must act on the renamed transfer. */
async function notifyActionable(bot, row, newId) {
  if (!bot) return;
  const aj = row.actionJSON || {};
  try {
    const transferFlow = require('../flows/transferFlow');
    const inTransit = aj.stage === 'in_transit';
    const target = String(inTransit ? aj.receiver : aj.dispatcher || '');
    if (!target) return;
    const card = inTransit
      ? transferFlow._internals.receiverCard(newId, aj)
      : null;
    const head = `🛠 Transfer ref corrected: this request is now *${newId}* (an id clash with an older transfer made its buttons open the wrong card).`;
    if (card) {
      await bot.sendMessage(target, `${head}\n\n${card.text}`, { parse_mode: 'Markdown', reply_markup: card.kb });
    } else {
      await bot.sendMessage(target, head, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🚚 Open transfer', callback_data: `trf:card:${newId}` }]] },
      });
    }
  } catch (e) {
    logger.warn(`queueRepair: notify for ${newId} failed: ${e.message}`);
  }
}

/**
 * Find and repair duplicate transfer ids. Safe to call at every boot.
 * @param {object} [bot] Telegram bot for the fresh-card notifications
 * @returns {Promise<{repaired:Array<{oldId:string,newId:string,rowIndex:number}>, skippedPendingOnly:number, failed:number}>}
 */
async function dedupeTransferIds(bot) {
  const out = { repaired: [], skippedPendingOnly: 0, failed: 0 };
  let rows;
  try {
    rows = await approvalQueueRepository.getAllWithRowIndex();
  } catch (e) {
    logger.warn(`queueRepair: queue read failed: ${e.message}`);
    return out;
  }

  const byId = new Map();
  for (const r of rows) {
    const id = String(r.requestId || '');
    if (!TR_ID.test(id)) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(r);
  }
  const usedIds = new Set(rows.map((r) => String(r.requestId || '')));

  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    const isPending = (r) => String(r.status || '').toLowerCase() === 'pending';
    const pendings = group.filter(isPending);
    const resolved = group.filter((r) => !isPending(r));
    if (!pendings.length) continue; // resolved-only duplicates: history, leave alone
    if (!resolved.length) {
      // Pending-vs-pending clash — no resolved anchor; outside the approved
      // repair. Flag loudly so the owner can decide.
      logger.warn(`queueRepair: ${id} is duplicated across ${pendings.length} PENDING rows — left untouched, needs a human call`);
      out.skippedPendingOnly += 1;
      continue;
    }
    for (const row of pendings) {
      const date = TR_ID.exec(id)[1];
      const newId = nextFreeId(date, usedIds);
      let ok = false;
      try {
        ok = await approvalQueueRepository.renameRequestIdAtRow(row.rowIndex, id, newId);
      } catch (e) {
        logger.warn(`queueRepair: rename ${id} row ${row.rowIndex} failed: ${e.message}`);
      }
      if (!ok) { out.failed += 1; continue; }
      usedIds.add(newId);
      out.repaired.push({ oldId: id, newId, rowIndex: row.rowIndex });
      try {
        await auditLogRepository.append('transfer.id_repaired',
          { oldId: id, newId, rowIndex: row.rowIndex, stage: (row.actionJSON || {}).stage || '' }, 'system');
      } catch (_) { /* audit best-effort */ }
      await notifyActionable(bot, row, newId);
      logger.info(`queueRepair: renamed duplicate transfer id ${id} → ${newId} (row ${row.rowIndex})`);
    }
  }
  return out;
}

module.exports = { dedupeTransferIds, _internals: { nextFreeId, TR_ID } };
