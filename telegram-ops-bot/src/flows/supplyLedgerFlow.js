'use strict';

/**
 * supplyLedgerFlow — SLG-1 (owner, 06/07-Aug-2026). 📒 Supply Ledger:
 * per-customer GOODS ledger in the owner's hand-drawn format. Admin-only —
 * the owner monitors it; customers will reach the web face later through
 * the EXT-1 OTP door, never through this flow.
 *
 * Callback namespace: `slg:` (registry-checked).
 *   slg:c:<i>    pick customer (index into session page)
 *   slg:pg:<n>   customer page
 *   slg:d:<i>    open a supply day's detail — hands over to the EXISTING
 *                SBL-2 compact card (soldBalesFlow.renderSummary), so the
 *                "hyperlink opens details along with doc" is the same card
 *                everywhere (owner: no similar thing in two places).
 *   slg:back     back to the customer picker
 *
 * Option B is locked: Debit / Credit / Balance stay reserved for the
 * finance portal; the bot face says so once instead of rendering dashes.
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer } = require('../utils/flowKit');
const supplyLedgerService = require('../services/supplyLedgerService');
const customerEntity = require('../services/customerEntity');
const auth = require('../middlewares/auth');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');

const SESSION_TYPE = 'supply_ledger_flow';
const PAGE = 8;

const render = makeRenderer({ requireSession: true });

async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, '📒 Supply Ledger is admin-only.');
    return;
  }
  sessionStore.set(userId, { type: SESSION_TYPE, step: 'customer', flowMessageId: messageId || null });
  await renderCustomerPicker(bot, chatId, userId, 0);
}

async function renderCustomerPicker(bot, chatId, userId, page) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let list = [];
  try { list = (await customerEntity.activeList()).map((c) => c.name).sort((a, b) => a.localeCompare(b)); } catch (e) {
    logger.warn(`supplyLedger: customer list failed: ${e.message}`);
  }
  const p = Math.max(0, Math.min(page, Math.ceil(list.length / PAGE) - 1));
  const slice = list.slice(p * PAGE, p * PAGE + PAGE);
  session._custPage = slice;
  session.page = p;
  sessionStore.set(userId, session);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [{ text: `👤 ${slice[i].slice(0, 28)}`, callback_data: `slg:c:${i}` }];
    if (slice[i + 1]) row.push({ text: `👤 ${slice[i + 1].slice(0, 28)}`, callback_data: `slg:c:${i + 1}` });
    rows.push(row);
  }
  const nav = [];
  if (p > 0) nav.push({ text: '⬅ Prev', callback_data: `slg:pg:${p - 1}` });
  if ((p + 1) * PAGE < list.length) nav.push({ text: 'Next ➡', callback_data: `slg:pg:${p + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🏠 Menu', callback_data: 'act:__back__' }]);
  await render(bot, chatId, userId,
    `📒 *Supply Ledger*\nPick the customer (${list.length} active):`, rows);
}

async function renderLedger(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.customer) return;
  const { entries, net } = await supplyLedgerService.buildLedger(session.customer);
  if (!entries.length) {
    await render(bot, chatId, userId,
      `📒 *Supply Ledger — ${session.customer}*\n\n_No supplies on record yet._`,
      [[{ text: '⬅ Customers', callback_data: 'slg:back' }], [{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }
  // Supply days are tappable (the SBL-2 card carries the doc); return rows
  // are informational lines sourced from the approved-return movement log.
  const supplyDays = entries.filter((e) => e.kind === 'supply').map((e) => e.day);
  session._days = supplyDays;
  sessionStore.set(userId, session);

  let body = `📒 *Supply Ledger — ${session.customer}*\n`
    + '_Debit · Credit · Balance are reserved for the finance portal._\n\n';
  for (const e of entries) {
    body += e.kind === 'supply'
      ? `${fmtDate.short(e.day)} — Supplied ${e.label}\n`
      : `${fmtDate.short(e.day)} — ↩ ${e.label}\n`;
  }
  body += `\n*Net supplied: ${net.bales} Bale${net.bales === 1 ? '' : 's'} to date*`;

  const kb = [];
  const chips = supplyDays.map((d, i) => ({ text: `📅 ${fmtDate.short(d)}`, callback_data: `slg:d:${i}` }));
  for (let i = 0; i < chips.length; i += 3) kb.push(chips.slice(i, i + 3));
  try {
    const token = supplyLedgerService.mintLedgerToken(session.customer, userId);
    const base = require('../config').baseUrl;
    if (base) kb.push([{ text: '🌐 Open ledger page', url: `${base}/sl/${token}` }]);
  } catch (e) { logger.warn(`supplyLedger: token mint failed: ${e.message}`); }
  kb.push([{ text: '⬅ Customers', callback_data: 'slg:back' }, { text: '🏠 Menu', callback_data: 'act:__back__' }]);
  await render(bot, chatId, userId, body, kb);
}

/** Hand over to the EXISTING Customer Supplies day card (SBL-2). */
async function openDay(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  const day = session && Array.isArray(session._days) ? session._days[idx] : null;
  if (!day) return;
  const soldBalesFlow = require('./soldBalesFlow');
  const sbl = soldBalesFlow._internals;
  sessionStore.set(userId, {
    type: sbl.SESSION_TYPE, step: 'summary',
    customer: session.customer, soldDate: day,
    flowMessageId: session.flowMessageId || null,
  });
  await sbl.renderSummary(bot, chatId, userId);
}

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('slg:')) return false;
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  if (!auth.isAdmin(userId)) return true;
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    // Stale card from an expired session — restart at the picker.
    await start(bot, chatId, userId, query.message.message_id);
    return true;
  }
  session.flowMessageId = query.message.message_id;
  sessionStore.set(userId, session);

  if (data === 'slg:back') { session.customer = null; sessionStore.set(userId, session); await renderCustomerPicker(bot, chatId, userId, session.page || 0); return true; }
  if (data.startsWith('slg:pg:')) { await renderCustomerPicker(bot, chatId, userId, parseInt(data.slice(7), 10) || 0); return true; }
  if (data.startsWith('slg:c:')) {
    const name = (session._custPage || [])[parseInt(data.slice(6), 10)];
    if (!name) { await renderCustomerPicker(bot, chatId, userId, session.page || 0); return true; }
    session.customer = name;
    sessionStore.set(userId, session);
    await renderLedger(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('slg:d:')) { await openDay(bot, chatId, userId, parseInt(data.slice(6), 10)); return true; }
  return true;
}

module.exports = {
  start, handleCallback,
  _internals: { renderCustomerPicker, renderLedger, openDay, SESSION_TYPE },
};
