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
    const cap = await myProductsService.availableForDesign(p.design, warehouse || null);
    if (qty > cap) {
      return {
        ok: false, cap,
        reason: `Only ${cap} bale${cap === 1 ? '' : 's'} of ${p.design} ${warehouse ? `in ${warehouse}` : 'in stock'} right now — the allocation cannot exceed that (§16).`,
      };
    }
  }
  const repo = require('../repositories/marketerAllocationsRepository');
  const res = await repo.setAllocation({
    marketerId: String(p.personId), marketerName: p.personName || '',
    design: p.design, qty, updatedBy: String(p.updatedBy || ''),
  });
  try {
    await require('../repositories/auditLogRepository').append('marketer_allocation',
      { marketerId: String(p.personId), marketerName: p.personName || '', design: p.design, qty, warehouse: warehouse || '' },
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

/** Auto ↔ curated. Stored as the design='*' row's notes (no new columns). */
async function setMode(personId, personName, mode, updatedBy) {
  const m = mode === 'curated' ? 'curated' : 'auto';
  const repo = require('../repositories/marketerAllocationsRepository');
  await repo.setAllocation({
    marketerId: String(personId), marketerName: personName || '',
    design: '*', qty: 0, updatedBy: String(updatedBy || ''), notes: m,
  });
  try {
    await require('../repositories/auditLogRepository').append('marketer_allocation_mode',
      { marketerId: String(personId), mode: m }, String(updatedBy || ''));
  } catch (_) { /* best-effort */ }
  return { ok: true, mode: m };
}

module.exports = { setAllocation, setMode };
