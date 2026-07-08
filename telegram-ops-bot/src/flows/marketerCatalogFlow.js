/**
 * Marketer "My Products" v2 — category-first, allocation-scoped — MKT-2.
 *
 * Exclusive to role=marketer (salesman/employees keep the classic
 * fieldCatalog view). The first screen is TAPPABLE CATEGORY CHIPS
 * (🧣 Cashmere, 🧵 Senator, …) built from the designs an admin has
 * allocated to this marketer (MarketerAllocations, qty > 0). Tapping a
 * category lists its designs with the allocated quantity plus a live
 * "available now" stock reference. Designs without a category are grouped
 * under "Others".
 *
 * Visibility rule: a marketer sees ONLY allocated designs. No allocation =
 * empty state ("ask your admin") — admin control is the whole point.
 *
 * Session shape (`type: 'mkp_flow'`):
 *   { step: 'cats'|'designs', flowMessageId, _cats: string[], category: string }
 *
 * Callback namespace `mkp:*`:
 *   mkp:c:<i>   open category by index
 *   mkp:cats    back to the category screen
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const inventoryRepository = require('../repositories/inventoryRepository');
const marketerAllocationsRepository = require('../repositories/marketerAllocationsRepository');
const designCategoriesRepository = require('../repositories/designCategoriesRepository');
const logger = require('../utils/logger');

const SESSION_TYPE = 'mkp_flow';
const OTHERS = 'Others';

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function menuRow() { return [{ text: '🏠 Menu', callback_data: 'act:__back__' }]; }

/** Anchored-card renderer (edit in place, fall back to fresh message). */
async function render(bot, chatId, userId, text, rows) {
  const session = sessionStore.get(userId);
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const mid = session && session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch { /* message gone or identical — fall through */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  if (session) {
    session.flowMessageId = sent.message_id;
    sessionStore.set(userId, session);
  }
}

/**
 * Group the marketer's live allocations by category.
 * @param {string} userId Marketer telegram id.
 * @returns {Promise<Map<string, Array<object>>>} category → allocation rows.
 */
async function allocationsByCategory(userId) {
  const allocs = await marketerAllocationsRepository.listForMarketer(userId);
  const catMap = await designCategoriesRepository.getMap();
  const grouped = new Map();
  for (const a of allocs) {
    const cat = catMap.get(designCategoriesRepository.normalizeDesign(a.design)) || OTHERS;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(a);
  }
  return grouped;
}

/** Screen 1 — tappable category chips. */
async function showCategories(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;

  const grouped = await allocationsByCategory(userId);
  if (!grouped.size) {
    await render(bot, chatId, userId,
      '📦 *My Products*\n\n🛈 No products have been allocated to you yet.\nAsk your admin to allocate designs to you.',
      [menuRow()]);
    return;
  }

  // Defaults order first (Cashmere, Chinos, …), extras alphabetical, Others last.
  const known = designCategoriesRepository.DEFAULT_CATEGORIES;
  const cats = [...grouped.keys()].sort((a, b) => {
    if (a === OTHERS) return 1;
    if (b === OTHERS) return -1;
    const ia = known.indexOf(a); const ib = known.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  session._cats = cats;
  session.step = 'cats';
  sessionStore.set(userId, session);

  const chips = cats.map((c, i) => ({
    text: `${designCategoriesRepository.iconFor(c)} ${c} (${grouped.get(c).length})`,
    callback_data: `mkp:c:${i}`,
  }));
  const rows = chunk(chips, 2);
  rows.push(menuRow());
  await render(bot, chatId, userId,
    '📦 *My Products*\n\nPick a category to see your allocated designs:',
    rows);
}

/** Screen 2 — designs of one category with allocated qty + live stock. */
async function showCategoryDesigns(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || !session.category) return;
  const category = session.category;

  const grouped = await allocationsByCategory(userId);
  const allocs = grouped.get(category) || [];
  if (!allocs.length) { await showCategories(bot, chatId, userId); return; }

  // Live availability reference: bales available per design, scoped to the
  // marketer's assigned warehouses when set (else all warehouses).
  const usersRepository = require('../repositories/usersRepository');
  let whSet = null;
  try {
    const u = await usersRepository.findByUserId(userId);
    const whs = (u && u.warehouses) || [];
    if (whs.length) whSet = new Set(whs.map((w) => String(w).trim().toLowerCase()));
  } catch { /* fall back to all warehouses */ }
  const inv = await inventoryRepository.getAll();
  const availBales = new Map(); // normalized design → Set(packageNo)
  for (const r of inv) {
    if (r.status !== 'available') continue;
    if (whSet && !whSet.has(String(r.warehouse || '').trim().toLowerCase())) continue;
    const key = designCategoriesRepository.normalizeDesign(r.design);
    if (!availBales.has(key)) availBales.set(key, new Set());
    availBales.get(key).add(r.packageNo);
  }

  session.step = 'designs';
  sessionStore.set(userId, session);

  const icon = designCategoriesRepository.iconFor(category);
  let text = `${icon} *${category}* — your designs\n`;
  for (const a of allocs) {
    const avail = (availBales.get(designCategoriesRepository.normalizeDesign(a.design)) || new Set()).size;
    text += `\n🧵 *${a.design}*\n   Allocated to you: *${a.allocated_qty} bale${a.allocated_qty === 1 ? '' : 's'}*\n   Available now: ${avail} bale${avail === 1 ? '' : 's'}\n`;
  }
  text += '\n_Allocation is set by your admin._';
  await render(bot, chatId, userId, text,
    [[{ text: '⬅ Categories', callback_data: 'mkp:cats' }], menuRow()]);
}

/**
 * Entry — called by the controller's `my_products` case for role=marketer.
 * @param {object} bot Telegram bot instance.
 * @param {number|string} chatId Chat id.
 * @param {string} userId Telegram user id.
 * @param {number|null} messageId Optional message id to edit in place.
 * @returns {Promise<void>}
 */
async function start(bot, chatId, userId, messageId) {
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'cats',
    flowMessageId: messageId || null,
    category: '',
    startedAt: new Date().toISOString(),
  });
  await showCategories(bot, chatId, userId);
  logger.info(`marketerCatalogFlow.start: userId=${userId}`);
}

/**
 * Handle a `mkp:*` callback.
 * @param {object} bot Telegram bot instance.
 * @param {object} query Telegram callback query.
 * @returns {Promise<boolean>} True when the callback was handled.
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('mkp:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);
  let session = sessionStore.get(userId);

  try { await bot.answerCallbackQuery(query.id); } catch { /* ignore */ }

  // Stale card (session expired) — restart fresh from the tapped message.
  if (!session || session.type !== SESSION_TYPE) {
    sessionStore.set(userId, {
      type: SESSION_TYPE, step: 'cats',
      flowMessageId: query.message?.message_id || null,
      category: '', startedAt: new Date().toISOString(),
    });
    session = sessionStore.get(userId);
  }

  if (data === 'mkp:cats') {
    session.category = '';
    sessionStore.set(userId, session);
    await showCategories(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('mkp:c:')) {
    const idx = parseInt(data.slice('mkp:c:'.length), 10);
    const cat = (session._cats || [])[idx];
    if (!cat) { await showCategories(bot, chatId, userId); return true; }
    session.category = cat;
    sessionStore.set(userId, session);
    await showCategoryDesigns(bot, chatId, userId);
    return true;
  }

  return true;
}

module.exports = {
  start,
  handleCallback,
  // Internals exposed for offline tests only.
  _internals: { showCategories, showCategoryDesigns, allocationsByCategory, SESSION_TYPE, OTHERS },
};
