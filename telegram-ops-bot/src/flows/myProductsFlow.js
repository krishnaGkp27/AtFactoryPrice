'use strict';

/**
 * src/flows/myProductsFlow.js — MYP-2 📦 My Products for LINKED people.
 *
 * The one surface a linked customer/marketer gets (§16), v4: EXACTLY the
 * supply-orders experience, allocation-scoped (owner, 23-Aug-2026).
 *
 *   design chips  📦 202/201 (28B / 48B)      supplied-to-them / ALLOCATED
 *      ↓ tap
 *   the catalogue PHOTO card (DesignAssets album page, caption = design
 *   only — no warehouse or market name in their world) with per-shade
 *   chips in the same pair grammar, ✅ Take ALL, ⬅ Back to designs
 *      ↓ tap a shade / Take ALL
 *   a REAL supply request is raised (linkedSupplyService) into the
 *   existing dispatch→admin→warehouse-boy pipeline; they see
 *   "Request sent — your admin will confirm supply."
 *
 * The recursive one-grammar law: the second number is always the total of
 * the reader's own scope — the admin's screens read warehouse totals,
 * this screen reads THEIR allocation. No stock count, no in-stock word,
 * no warehouse name, no price ever renders here.
 *
 * Callback namespace: `myp:`
 *   myp:d:<i>      open design i's photo card
 *   myp:s:<i>:<j>  request shade j of design i (remaining allocation)
 *   myp:all:<i>    request every shade's remainder of design i
 *   myp:back       back to the design chips
 *   myp:noop       page indicator
 */

const sessionStore = require('../utils/sessionStore');
const logger = require('../utils/logger');
const { mdEscape } = require('../utils/flowKit');
const { editOrSend } = require('../utils/telegramUI');

const SESSION_TYPE = 'my_products_flow';
const MAX_CHIPS = 24;

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
      '📦 *My Products*\n\nNothing here yet. Your admin sets up your products.',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [menuRow()] } });
    return;
  }
  const items = view.items.slice(0, MAX_CHIPS);
  const old = sessionStore.get(userId);
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'designs',
    flowMessageId: messageId || (old && old.flowMessageId) || null,
    _items: items,
  });
  const rows = items.map((it, i) => ([{
    text: `📦 ${it.design} (${it.suppliedB}B / ${it.allocatedB}B)`,
    callback_data: `myp:d:${i}`,
  }]));
  rows.push(menuRow());
  const sent = await editOrSend(bot, chatId, messageId,
    '📦 *My Products*\n_(supplied / allocated to you)_', {
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
    });
  const s = sessionStore.get(userId);
  if (s && sent && sent.message_id) { s.flowMessageId = sent.message_id; sessionStore.set(userId, s); }
}

/** The catalogue photo card with per-shade pair chips — the orders shape. */
async function showDesign(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;
  const it = (session._items || [])[idx];
  if (!it) return;
  session.step = 'shades';
  session._design = idx;
  sessionStore.set(userId, session);

  const rows = [];
  if (it.shades.length) {
    it.shades.forEach((sh, j) => {
      rows.push([{
        text: `${sh.shade} (${sh.suppliedB}B / ${sh.allocatedB}B)`,
        callback_data: `myp:s:${idx}:${j}`,
      }]);
    });
    const totalAlloc = it.shades.reduce((n, s) => n + s.allocatedB, 0);
    if (it.shades.length > 1) {
      rows.push([{ text: `✅ Take ALL ${it.shades.length} shades (${totalAlloc}B)`, callback_data: `myp:all:${idx}` }]);
    }
  } else {
    // Design-level allocation with no shade split — one request chip.
    rows.push([{ text: `✅ Request supply (${it.suppliedB}B / ${it.allocatedB}B)`, callback_data: `myp:all:${idx}` }]);
  }
  rows.push([{ text: '⬅️ Back to designs', callback_data: 'myp:back' }]);

  // The catalogue photo, exactly as the orders flow shows it — caption is
  // the design ONLY (no warehouse/market name in their world).
  let sent = null;
  try {
    const designAssetsService = require('../services/designAssetsService');
    const photoAsset = await designAssetsService.getPhotoForSend(it.design);
    if (photoAsset && photoAsset.photo) {
      sent = await bot.sendPhoto(chatId, photoAsset.photo, {
        caption: `📷 *${mdEscape(it.design)}*`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      });
      if (photoAsset.photoSource !== 'telegram_file_id' && sent && sent.photo && sent.photo.length) {
        designAssetsService.cacheTelegramFileId(photoAsset.rowIndex, sent.photo[sent.photo.length - 1].file_id).catch(() => {});
      }
    }
  } catch (e) {
    logger.warn(`myProducts.showDesign(${it.design}): photo card failed — text fallback (${e.message})`);
    sent = null;
  }
  if (sent && sent.message_id) {
    // The old text card is folded away so one card leads the chat.
    if (session.flowMessageId) {
      try { await bot.deleteMessage(chatId, session.flowMessageId); } catch (_) { /* gone */ }
    }
    session.photoMessageId = sent.message_id;
    session.flowMessageId = null;
    sessionStore.set(userId, session);
    return;
  }
  await editOrSend(bot, chatId, session.flowMessageId, `📦 *${mdEscape(it.design)}*\n\nPick a shade:`, {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows },
  });
}

/** Raise the remaining allocation as a real supply request. */
async function requestSupply(bot, chatId, userId, idx, shadeIdx) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;
  const it = (session._items || [])[idx];
  if (!it) return;
  const info = await require('../services/linkedAccessService').infoFor(userId);
  if (!info) return;

  let lines;
  if (shadeIdx != null) {
    const sh = it.shades[shadeIdx];
    if (!sh) return;
    lines = [{ design: it.design, shade: sh.shade, quantity: sh.allocatedB - sh.suppliedB }];
  } else if (it.shades.length) {
    lines = it.shades.map((sh) => ({ design: it.design, shade: sh.shade, quantity: sh.allocatedB - sh.suppliedB }));
  } else {
    lines = [{ design: it.design, shade: '', quantity: it.allocatedB - it.suppliedB }];
  }
  lines = lines.filter((l) => l.quantity > 0);
  if (!lines.length) {
    await bot.sendMessage(chatId, `✅ ${it.design} is already fully supplied against your allocation.`, { disable_notification: true });
    return;
  }

  const res = await require('../services/linkedSupplyService').raise(bot, { ...info, telegramId: userId }, lines);
  if (!res.ok) {
    await bot.sendMessage(chatId,
      res.reason === 'already_requested'
        ? '⏳ You already have an open request for this — your admin will confirm supply.'
        : '⚠️ Could not send the request just now — try again in a moment.',
      { disable_notification: true });
    return;
  }
  const total = lines.reduce((n, l) => n + l.quantity, 0);
  const what = lines.length === 1
    ? `${it.design}${lines[0].shade ? ` · ${lines[0].shade}` : ''} · ${lines[0].quantity}B`
    : `${it.design} · ${lines.length} shades · ${total}B`;
  const text = `✅ *Request sent.*\n\n${mdEscape(what)}\nYour admin will confirm supply.`;
  const kb = { inline_keyboard: [[{ text: '⬅️ Back to My Products', callback_data: 'myp:back' }], menuRow()] };
  if (session.photoMessageId) {
    try {
      await bot.editMessageCaption(text, {
        chat_id: chatId, message_id: session.photoMessageId,
        parse_mode: 'Markdown', reply_markup: kb,
      });
      return;
    } catch (_) { /* fall through */ }
  }
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
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
    if (info) {
      const s = sessionStore.get(userId);
      const oldPhoto = s && s.photoMessageId;
      if (oldPhoto) {
        try { await bot.deleteMessage(chatId, oldPhoto); } catch (_) { /* gone */ }
        s.photoMessageId = null; sessionStore.set(userId, s);
      }
      await start(bot, chatId, userId, info, s && s.flowMessageId);
    }
    return true;
  }
  if (rest.startsWith('d:')) {
    await showDesign(bot, chatId, userId, parseInt(rest.slice(2), 10));
    return true;
  }
  if (rest.startsWith('s:')) {
    const [i, j] = rest.slice(2).split(':').map((n) => parseInt(n, 10));
    await requestSupply(bot, chatId, userId, i, j);
    return true;
  }
  if (rest.startsWith('all:')) {
    await requestSupply(bot, chatId, userId, parseInt(rest.slice(4), 10), null);
    return true;
  }
  return true;
}

module.exports = { SESSION_TYPE, start, showDesign, handleCallback };
