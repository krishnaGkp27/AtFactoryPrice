'use strict';

/**
 * MYP-1 — the ONE door every allocation write goes through (§16).
 *
 * The cap is the rule that makes this a service instead of a sheet write:
 * an allocated quantity can NEVER exceed what the warehouse actually holds
 * at the time of writing. Both operating surfaces — the bot's mal: flow
 * and the web matrix (§15c) — call here, so the cap cannot be bypassed by
 * choosing a door. Audit row per change; the person is DM'd best-effort.
 */

const logger = require('../utils/logger');

/**
 * @param {object} p {personId, personName, design, qty, updatedBy, warehouse?, bot?}
 * @returns {{ok:boolean, cap?:number, updated?:boolean, reason?:string}}
 */
async function setAllocation(p) {
  const qty = Number(p.qty);
  if (!p.personId || !p.design || !Number.isFinite(qty) || qty < 0) {
    return { ok: false, reason: 'personId, design and a non-negative qty are required.' };
  }
  const myProductsService = require('./myProductsService');
  let warehouse = p.warehouse;
  if (warehouse === undefined) {
    try {
      const linkedAccessService = require('./linkedAccessService');
      const info = await linkedAccessService.infoFor(p.personId);
      warehouse = info ? await myProductsService.sourceWarehouseFor({ ...info, telegramId: p.personId }) : null;
    } catch (_) { warehouse = null; }
  }
  if (qty > 0) {
    // MYP-2 — the cap follows the allocation's grain: a shade row is capped
    // against that shade's live stock, a design row against the design's.
    const cap = await myProductsService.availableForDesign(p.design, warehouse || null, p.shade || null);
    if (qty > cap) {
      return {
        ok: false, cap,
        reason: `Only ${cap} bale${cap === 1 ? '' : 's'} of ${p.design}${p.shade ? ` / ${p.shade}` : ''} ${warehouse ? `in ${warehouse}` : 'in stock'} right now — the allocation cannot exceed that (§16).`,
      };
    }
  }
  const repo = require('../repositories/marketerAllocationsRepository');
  const res = await repo.setAllocation({
    marketerId: String(p.personId), marketerName: p.personName || '',
    design: p.design, qty, updatedBy: String(p.updatedBy || ''),
    shade: p.shade || '',
  });
  try {
    await require('../repositories/auditLogRepository').append('marketer_allocation',
      { marketerId: String(p.personId), marketerName: p.personName || '', design: p.design, shade: p.shade || '', qty, warehouse: warehouse || '' },
      String(p.updatedBy || ''));
  } catch (_) { /* best-effort */ }
  if (p.bot) {
    const shown = p.label || p.design;
    try {
      await p.bot.sendMessage(String(p.personId), qty > 0
        ? `📦 *Products update*\n\nYou've been allocated *${qty} bale${qty === 1 ? '' : 's'}* of design *${shown}*.\nOpen 📦 My Products to see it.`
        : `📦 *Products update*\n\nDesign *${shown}* has been removed from your allocation.`,
      { parse_mode: 'Markdown' });
    } catch (e) { logger.info(`allocationService: DM to ${p.personId} skipped (${e.message})`); }
  }
  return { ok: true, updated: res.updated };
}

// MYP-2 (owner, 23-Aug-2026): the auto/curated display mode is superseded —
// the linked view is allocation-driven only, so there is no mode to set.
// Legacy '*' rows in the sheet are ignored by every reader.

module.exports = { setAllocation };
