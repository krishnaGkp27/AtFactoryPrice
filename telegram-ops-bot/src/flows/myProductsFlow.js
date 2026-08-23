'use strict';

/**
 * src/flows/myProductsFlow.js — MYP-1 📦 My Products for LINKED people.
 *
 * The one surface a linked customer/marketer gets (§16). Chips in the
 * Supply Details grammar — `📦 <design> — <suppliedB>B / <availableB>B` —
 * over the person's own purchase history (auto) or the admin's curated
 * set, stock scoped to their source warehouse. Read-only: navigation is
 * the only thing a chip can do. Role-marketers keep marketerCatalogFlow;
 * this flow serves the linked class only.
 *
 * Callback namespace: `myp:` (myp:d:<i> drill · myp:back · myp:noop)
 */

const sessionStore = require('../utils/sessionStore');
const logger = require('../utils/logger');
const { mdEscape } = require('../utils/flowKit');
const { editOrSend } = require('../utils/telegramUI');

const SESSION_TYPE = 'my_products_flow';
const MAX_CHIPS = 24;
const MAX_DAY_LINES = 6;

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

function menuRow() { return [{ text: '🏠 Menu', callback_data: 'act:__back__' }]; }

async function start(bot, chatId, userId, info, messageId = null) {
  let view;
  try {
    view = await require('../services/myProductsService').buildFor({ ...info, telegramId: userId });
  } catch (e) {
    logger.error(`myProducts.start: ${e.message}`);
    await editOrSend(bot, chatId, messageId, '⚠️ Could not load your products just now — try again in a moment.',
      { reply_markup: { inline_keyboard: [menuRow()] } });
    return;
  }
  if (!view.items.length) {
    await editOrSend(bot, chatId, messageId,
      '📦 *My Products*\n\n🛈 Nothing here yet — your products appear once goods are supplied to you'
      + (view.mode === 'curated' ? ' and your admin allocates designs.' : '.')
      + '\n\n_Set up by your admin._',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [menuRow()] } });
    return;
  }
  const items = view.items.slice(0, MAX_CHIPS);
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'list', flowMessageId: messageId || null,
    _items: items, _warehouse: view.warehouse, _mode: view.mode,
  });
  // STK-PRIV (owner, 23-Aug-2026): the sdg pair would leak live stock to a
  // non-admin — the chip carries only what was supplied TO THEM.
  const rows = items.map((it, i) => ([{
    text: `📦 ${it.design} — ${it.suppliedB}B`,
    callback_data: `myp:d:${i}`,
  }]));
  rows.push(menuRow());
  const head = `📦 *My Products*${view.warehouse ? `\n🏭 ${mdEscape(view.warehouse)}` : ''}`
    + `\n_(bales supplied to you)_`
    + (view.mixedHistory ? '\n⚠️ _History spans warehouses — showing your most recent one._' : '');
  const sent = await editOrSend(bot, chatId, messageId, head, {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
  const s = sessionStore.get(userId);
  if (s && sent && sent.message_id) { s.flowMessageId = sent.message_id; sessionStore.set(userId, s); }
}

async function showDesign(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;
  const it = (session._items || [])[idx];
  if (!it) return;
  let days = [];
  try {
    const inventoryRepository = require('../repositories/inventoryRepository');
    const myProductsService = require('../services/myProductsService');
    const linkedAccessService = require('../services/linkedAccessService');
    const info = await linkedAccessService.infoFor(userId);
    const aliases = info ? await myProductsService._internals.aliasSetFor({ ...info, telegramId: userId }) : new Set();
    const sold = await inventoryRepository.getSoldRows();
    const byDay = new Map();
    for (const r of sold) {
      if (norm(r.design) !== norm(it.design)) continue;
      if (!aliases.has(norm(r.soldTo))) continue;
      const day = String(r.soldDate || '').slice(0, 10) || '—';
      if (!byDay.has(day)) byDay.set(day, new Set());
      byDay.get(day).add(r.packageNo);
    }
    days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, bales]) => `${day} — ${bales.size}B`);
  } catch (e) {
    logger.warn(`myProducts.showDesign: ${e.message}`);
  }
  const shown = days.slice(-MAX_DAY_LINES);
  const lines = [
    `📦 *${mdEscape(it.design)}*${session._warehouse ? ` · ${mdEscape(session._warehouse)}` : ''}`, '',
  ];
  if (shown.length) {
    lines.push('🚚 *Supplied to you*');
    if (days.length > shown.length) lines.push(`_…and ${days.length - shown.length} earlier day${days.length - shown.length === 1 ? '' : 's'}_`);
    lines.push(...shown.map((d) => `• ${d}`));
    lines.push('');
  }
  // STK-PRIV — allocated is THEIR number; availability is a word, never a count.
  lines.push(`Allocated: *${it.allocatedB} B* · ${it.availableB > 0 ? '✅ In stock' : '⛔ Out of stock right now'}`);
  lines.push('', '_Allocation is set by your admin._');
  await editOrSend(bot, chatId, session.flowMessageId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '⬅ My Products', callback_data: 'myp:back' }],
      menuRow(),
    ] },
  });
}

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('myp:')) return false;
  const userId = String(query.from.id);
  const chatId = query.message && query.message.chat && query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  const rest = data.slice(4);
  if (rest === 'noop') return true;
  const session = sessionStore.get(userId);
  if (rest === 'back' || !session || session.type !== SESSION_TYPE) {
    const info = await require('../services/linkedAccessService').infoFor(userId);
    if (info) await start(bot, chatId, userId, info, session && session.flowMessageId);
    return true;
  }
  if (rest.startsWith('d:')) {
    await showDesign(bot, chatId, userId, parseInt(rest.slice(2), 10));
    return true;
  }
  return true;
}

module.exports = { SESSION_TYPE, start, showDesign, handleCallback };
