'use strict';

/**
 * SHR-1 — share a catalogue design as a tracked domain link
 * (specs/SHR-1_SHARE_TRACKING.md).
 *
 * Entry: the 📤 Share button on the Browse Catalog design card
 * (`shr:d:<design>`). The flow asks WHICH CUSTOMER the link is for (that
 * first hop is the only identity we ever get — onward WhatsApp hops are
 * anonymous), mints a signed token, records a 'created' event, and hands
 * the marketer a ready-to-send wa.me button.
 *
 * Session shape (`type: 'share_flow'`):
 *   { step: 'customer'|'done', flowMessageId, design, page, _cust: [{id,name}] }
 *
 * Callback namespace `shr:*`:
 *   shr:d:<design>  start for a design (session-free entry from the card)
 *   shr:pg:<n>      customer picker page
 *   shr:c:<i>       pick customer by index into _cust
 *   shr:skip        no specific customer
 *   shr:x           cancel / done (clears the session)
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, chunk, mdEscape } = require('../utils/flowKit');
const settingsRepository = require('../repositories/settingsRepository');
const shareLinkService = require('../services/shareLinkService');
const shareTrackService = require('../services/shareTrackService');
const logger = require('../utils/logger');

const SESSION_TYPE = 'share_flow';
const PER_PAGE = 8;

const render = makeRenderer({ disablePreview: true });

function menuRow() { return [{ text: '🏠 Menu', callback_data: 'act:__back__' }]; }

/** Active customers, lightest possible shape for the session.
 *  CUS-2: via customerEntity.activeList — the raw getAll filter let
 *  Merged/Pending/Rejected rows into the picker, baking dead ids into
 *  tokens and share_events. */
async function loadCustomers() {
  const all = await require('../services/customerEntity').activeList();
  return all
    .filter((c) => c.name)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ id: c.customer_id || '', name: c.name }));
}

async function showCustomerPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;
  const cust = session._cust || [];
  const pages = Math.max(1, Math.ceil(cust.length / PER_PAGE));
  const page = Math.min(Math.max(session.page || 0, 0), pages - 1);
  session.page = page;
  sessionStore.set(userId, session);

  const chips = cust.slice(page * PER_PAGE, (page + 1) * PER_PAGE)
    .map((c, i) => ({ text: c.name, callback_data: `shr:c:${page * PER_PAGE + i}` }));
  const rows = chunk(chips, 2);
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `shr:pg:${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'Next ➡️', callback_data: `shr:pg:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '⏭ Skip — no specific customer', callback_data: 'shr:skip' }]);
  rows.push([{ text: '❌ Cancel', callback_data: 'shr:x' }]);
  rows.push(menuRow());

  await render(bot, chatId, userId,
    `📤 *Share design ${mdEscape(session.design)}*\n\nWho is this link for? The pick is what makes the numbers read per customer.`
    + (cust.length ? '' : '\n\n🛈 No customers on file yet — Skip to share anyway.'),
    rows);
}

async function showLink(bot, chatId, userId, customer) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;

  const token = shareLinkService.mintToken({
    design: session.design,
    customerId: (customer && customer.id) || '',
    mintedBy: userId,
  });
  const url = await shareLinkService.pageUrl(token);
  if (!url) {
    await render(bot, chatId, userId,
      '⚠️ No share page is configured yet.\nSet *BASE_URL* on the server or a *SHARE_PAGE_BASE_URL* Settings row, then try again.',
      [[{ text: '✖ Close', callback_data: 'shr:x' }], menuRow()]);
    return;
  }

  // The 'created' row is what ties every later open/download back to this
  // customer. Best-effort: without Postgres the link still ships.
  shareTrackService.record({
    event: 'created', token, design: session.design,
    customerId: (customer && customer.id) || '', mintedBy: userId,
    meta: customer && customer.name ? { customer_name: customer.name } : {},
  }).catch(() => {});

  session.step = 'done';
  sessionStore.set(userId, session);

  const forLine = customer && customer.name ? `\n👤 For: *${mdEscape(customer.name)}*` : '';
  const waText = encodeURIComponent(`Design ${session.design} — ${url}`);
  await render(bot, chatId, userId,
    `✅ *Share link ready — design ${mdEscape(session.design)}*${forLine}\n\n`
    + `🔗 ${url}\n\n`
    + 'Send the LINK, not a screenshot — every person who opens it (and everyone they forward it to) shows up in the share numbers.',
    [
      [{ text: '📲 Send on WhatsApp', url: `https://wa.me/?text=${waText}` }],
      [{ text: '✔ Done', callback_data: 'shr:x' }],
      menuRow(),
    ]);
  logger.info(`shareFlow: link minted design=${session.design} customer=${(customer && customer.id) || '-'} by=${userId}`);
}

/**
 * Start from the catalog card's 📤 Share button.
 * @param {object} bot
 * @param {number|string} chatId
 * @param {string} userId
 * @param {string} design
 */
async function start(bot, chatId, userId, design) {
  const settings = await settingsRepository.getAll();
  if (!Number(settings.SHARE_LINKS_ENABLED)) {
    await bot.sendMessage(chatId, '🛈 Share links are switched off (Settings: SHARE_LINKS_ENABLED).');
    return;
  }
  const cust = await loadCustomers();
  // flowMessageId starts null: the entry card is a PHOTO message, which
  // text-edit renderers can't touch — the first render sends a fresh card.
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'customer',
    flowMessageId: null,
    design: String(design || '').trim().toUpperCase(),
    page: 0,
    _cust: cust,
    startedAt: new Date().toISOString(),
  });
  await showCustomerPicker(bot, chatId, userId);
}

/**
 * Handle a `shr:*` callback.
 * @returns {Promise<boolean>} true when handled.
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('shr:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);

  try { await bot.answerCallbackQuery(query.id); } catch { /* ignore */ }

  if (data.startsWith('shr:d:')) {
    await start(bot, chatId, userId, data.slice('shr:d:'.length));
    return true;
  }

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    // Stale card from an expired session — nothing to resume safely.
    try {
      await bot.editMessageText('This share card has expired — open the design from 📖 Browse Catalog and tap 📤 Share again.',
        { chat_id: chatId, message_id: query.message?.message_id });
    } catch { /* ignore */ }
    return true;
  }

  if (data === 'shr:x') {
    sessionStore.clear(userId);
    try {
      await bot.editMessageText('✅ Share closed.',
        { chat_id: chatId, message_id: session.flowMessageId || query.message?.message_id });
    } catch { /* ignore */ }
    return true;
  }

  if (data.startsWith('shr:pg:')) {
    session.page = parseInt(data.slice('shr:pg:'.length), 10) || 0;
    sessionStore.set(userId, session);
    await showCustomerPicker(bot, chatId, userId);
    return true;
  }

  if (data === 'shr:skip') {
    await showLink(bot, chatId, userId, null);
    return true;
  }

  if (data.startsWith('shr:c:')) {
    const idx = parseInt(data.slice('shr:c:'.length), 10);
    const customer = (session._cust || [])[idx];
    if (!customer) { await showCustomerPicker(bot, chatId, userId); return true; }
    await showLink(bot, chatId, userId, customer);
    return true;
  }

  return true;
}

module.exports = {
  start,
  handleCallback,
  _internals: { SESSION_TYPE, loadCustomers, showCustomerPicker, showLink },
};
