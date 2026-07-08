/**
 * Allocate to Marketer — admin controls a marketer's My Products — MKT-2.
 *
 * Admin picks: marketer → design → bale quantity → Save. The allocation is
 * written straight to MarketerAllocations (direct admin write, no approval
 * queue — owner wants fast test cycles; easy to gate later). Re-allocating
 * the same (marketer, design) overwrites; quantity 0 removes the design
 * from the marketer's view. The marketer gets a DM on every change.
 *
 * Session shape (`type: 'mal_flow'`):
 *   {
 *     step: 'marketer'|'design'|'qty'|'confirm',
 *     flowMessageId, page,
 *     _marketers: [{id,name}], _designs: string[],
 *     marketerId, marketerName, design, qty,
 *   }
 *
 * Callback namespace `mal:*`:
 *   mal:mk:<i>  pick marketer      mal:dg:<i>  pick design
 *   mal:pg:<n>  design page        mal:q:<n>   pick quantity
 *   mal:save    write allocation   mal:again   allocate another design (same marketer)
 *   mal:back    one step back      mal:cancel  abandon
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const usersRepository = require('../repositories/usersRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const marketerAllocationsRepository = require('../repositories/marketerAllocationsRepository');
const designCategoriesRepository = require('../repositories/designCategoriesRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const fieldRoles = require('../services/fieldRoles');
const logger = require('../utils/logger');

const SESSION_TYPE = 'mal_flow';
const PAGE_SIZE = 24;
const QTY_CHIPS = [1, 2, 3, 5, 10, 20];

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function cancelRow() { return [{ text: '❌ Cancel', callback_data: 'mal:cancel' }]; }
function navRow() {
  return [{ text: '⬅ Back', callback_data: 'mal:back' }, { text: '❌ Cancel', callback_data: 'mal:cancel' }];
}

/** Anchored-card renderer (edit in place, fall back to fresh message). */
async function render(bot, chatId, userId, prompt, rows) {
  const session = sessionStore.get(userId);
  const text = `🧑‍💼 *Allocate to Marketer*\n\n${prompt}`;
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

/** Decorated design label: "80045 · Senator". */
function designLabel(design, catMap) {
  const cat = catMap.get(designCategoriesRepository.normalizeDesign(design)) || '';
  return cat ? `${design} · ${cat}` : String(design);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Step 1 — marketer picker (active Users rows with role=marketer). */
async function showMarketers(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;

  const all = await usersRepository.getAll();
  const marketers = (all || [])
    .filter((u) => fieldRoles.classify(u.role) === fieldRoles.MARKETER
      && String(u.status || 'active').toLowerCase() === 'active')
    .map((u) => ({ id: String(u.user_id), name: u.name || String(u.user_id) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!marketers.length) {
    await render(bot, chatId, userId,
      '⚠️ No active users with role *marketer* yet.\n\n_Onboard one first (Add Employee with role marketer, or set role=marketer on their Users row), then come back._',
      [cancelRow()]);
    return;
  }

  let counts = new Map();
  try { counts = await marketerAllocationsRepository.countsByMarketer(); } catch { /* chips without counts */ }

  session._marketers = marketers;
  session.step = 'marketer';
  sessionStore.set(userId, session);

  const chips = marketers.map((m, i) => {
    const n = counts.get(m.id) || 0;
    return { text: n ? `🧑‍💼 ${m.name} (${n})` : `🧑‍💼 ${m.name}`, callback_data: `mal:mk:${i}` };
  });
  const rows = chunk(chips, 2);
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    'Pick the *marketer*.\n_(n) = designs already allocated._',
    rows);
}

/** Step 2 — design picker (all inventory designs, category-labelled, paged). */
async function showDesigns(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;

  const raw = await inventoryRepository.getDistinctDesigns();
  const designs = [...new Set(raw.map((d) => (d.design || '').trim()).filter(Boolean))].sort();
  if (!designs.length) {
    await render(bot, chatId, userId, '⚠️ No designs found in inventory.', [cancelRow()]);
    return;
  }
  let catMap = new Map();
  try { catMap = await designCategoriesRepository.getMap(); } catch { /* bare chips */ }

  const pages = Math.max(1, Math.ceil(designs.length / PAGE_SIZE));
  const page = Math.min(Math.max(session.page || 0, 0), pages - 1);
  const visible = designs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  session._designs = visible;
  session.page = page;
  session.step = 'design';
  sessionStore.set(userId, session);

  const chips = visible.map((d, i) => ({ text: designLabel(d, catMap), callback_data: `mal:dg:${i}` }));
  const rows = chunk(chips, 3);
  if (pages > 1) {
    const pager = [];
    if (page > 0) pager.push({ text: '⬅ Prev', callback_data: `mal:pg:${page - 1}` });
    pager.push({ text: `${page + 1}/${pages}`, callback_data: `mal:pg:${page}` });
    if (page < pages - 1) pager.push({ text: 'Next ➡', callback_data: `mal:pg:${page + 1}` });
    rows.push(pager);
  }
  rows.push(navRow());
  await render(bot, chatId, userId,
    `Marketer: *${session.marketerName}*\n\nPick the *design* to allocate:`,
    rows);
}

/** Step 3 — quantity chips (with current allocation + stock reference). */
async function showQty(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || !session.design) return;
  session.step = 'qty';
  sessionStore.set(userId, session);

  let current = 0;
  try {
    const rows = await marketerAllocationsRepository.getAll();
    const hit = rows.find((r) => r.marketer_id === session.marketerId
      && r.design.toUpperCase() === session.design.toUpperCase());
    current = hit ? hit.allocated_qty : 0;
  } catch { /* show without current */ }

  let avail = 0;
  try {
    const inv = await inventoryRepository.getAll();
    const pkgs = new Set();
    for (const r of inv) {
      if (r.status === 'available'
          && designCategoriesRepository.normalizeDesign(r.design) === designCategoriesRepository.normalizeDesign(session.design)) {
        pkgs.add(r.packageNo);
      }
    }
    avail = pkgs.size;
  } catch { /* show without stock */ }

  const cat = designCategoriesRepository.categoryOfSync(session.design);
  const chips = QTY_CHIPS.map((n) => ({ text: `${n}`, callback_data: `mal:q:${n}` }));
  const rows = chunk(chips, 3);
  rows.push([{ text: '🗑 Remove (0)', callback_data: 'mal:q:0' }]);
  rows.push(navRow());
  await render(bot, chatId, userId,
    `Marketer: *${session.marketerName}*\nDesign: *${session.design}*${cat ? ` · ${cat}` : ''}\n`
    + `Currently allocated: *${current}* · In stock: ${avail} bale${avail === 1 ? '' : 's'}\n\n`
    + 'How many *bales* to allocate?',
    rows);
}

/** Step 4 — confirm card. */
async function showConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;
  session.step = 'confirm';
  sessionStore.set(userId, session);

  const cat = designCategoriesRepository.categoryOfSync(session.design);
  const line = session.qty > 0
    ? `• Allocation: *${session.qty} bale${session.qty === 1 ? '' : 's'}*`
    : '• Allocation: *remove* (design disappears from their My Products)';
  await render(bot, chatId, userId,
    `Confirm:\n\n• Marketer: *${session.marketerName}*\n• Design: *${session.design}*${cat ? ` · ${cat}` : ''}\n${line}\n\n`
    + '_Saves immediately and DMs the marketer. Re-allocating later overwrites this._',
    [
      [{ text: '✅ Save allocation', callback_data: 'mal:save' }],
      navRow(),
    ]);
}

/** Save → sheet write + audit + marketer DM + success card. */
async function save(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || !session.marketerId || !session.design) return;
  const { marketerId, marketerName, design, qty } = session;

  try {
    await marketerAllocationsRepository.setAllocation({
      marketerId, marketerName, design, qty, updatedBy: String(userId),
    });
    await auditLogRepository.append('marketer_allocation',
      { marketerId, marketerName, design, qty }, String(userId));

    const cat = designCategoriesRepository.categoryOfSync(design);
    const label = cat ? `${design} (${cat})` : design;
    try {
      await bot.sendMessage(marketerId, qty > 0
        ? `📦 *Products update*\n\nYou've been allocated *${qty} bale${qty === 1 ? '' : 's'}* of design *${label}*.\nOpen 📦 My Products to see it.`
        : `📦 *Products update*\n\nDesign *${label}* has been removed from your allocation.`,
      { parse_mode: 'Markdown' });
    } catch (e) {
      logger.info(`allocateMarketerFlow: DM to ${marketerId} skipped (${e.message})`);
    }

    await render(bot, chatId, userId,
      `✅ *Saved*\n\n• ${marketerName} — ${label}: *${qty} bale${qty === 1 ? '' : 's'}*\n\n_The marketer's My Products updates immediately._`,
      [
        [{ text: '➕ Allocate another design', callback_data: 'mal:again' }],
        [{ text: '🏠 Menu', callback_data: 'act:__back__' }],
      ]);
    session.design = ''; session.qty = 0; session.step = 'done';
    sessionStore.set(userId, session);
    logger.info(`allocateMarketerFlow.save: ${marketerId} ${design} qty=${qty} by=${userId}`);
  } catch (e) {
    logger.error(`allocateMarketerFlow.save failed: ${e.message}`);
    await render(bot, chatId, userId, `⚠️ Could not save: ${e.message}`, [navRow()]);
  }
}

// ---------------------------------------------------------------------------
// Entry + dispatcher
// ---------------------------------------------------------------------------

/**
 * Start the Allocate-to-Marketer flow (admin only; controller also gates).
 * @param {object} bot Telegram bot instance.
 * @param {number|string} chatId Chat id.
 * @param {string} userId Telegram user id.
 * @param {number|null} messageId Optional message id to edit in place.
 * @returns {Promise<void>}
 */
async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(String(userId))) {
    await bot.sendMessage(chatId, '🧑‍💼 Marketer allocations can be set by admins only.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'marketer',
    flowMessageId: messageId || null,
    page: 0,
    marketerId: '', marketerName: '', design: '', qty: 0,
    startedAt: new Date().toISOString(),
  });
  await showMarketers(bot, chatId, userId);
}

/**
 * Handle a `mal:*` callback.
 * @param {object} bot Telegram bot instance.
 * @param {object} query Telegram callback query.
 * @returns {Promise<boolean>} True when the callback was handled.
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('mal:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);

  if (!session || session.type !== SESSION_TYPE) {
    try {
      await bot.answerCallbackQuery(query.id, {
        text: 'This card expired. Open 🧑‍💼 Allocate to Marketer again.',
        show_alert: true,
      });
    } catch { /* ignore */ }
    return true;
  }
  try { await bot.answerCallbackQuery(query.id); } catch { /* ignore */ }

  if (data === 'mal:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '❌ Cancelled — nothing was changed.', []);
    return true;
  }

  if (data.startsWith('mal:mk:')) {
    const idx = parseInt(data.slice('mal:mk:'.length), 10);
    const m = (session._marketers || [])[idx];
    if (!m) { await showMarketers(bot, chatId, userId); return true; }
    session.marketerId = m.id;
    session.marketerName = m.name;
    session.page = 0;
    sessionStore.set(userId, session);
    await showDesigns(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('mal:pg:')) {
    session.page = parseInt(data.slice('mal:pg:'.length), 10) || 0;
    sessionStore.set(userId, session);
    await showDesigns(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('mal:dg:')) {
    const idx = parseInt(data.slice('mal:dg:'.length), 10);
    const design = (session._designs || [])[idx];
    if (!design) { await showDesigns(bot, chatId, userId); return true; }
    session.design = design;
    sessionStore.set(userId, session);
    await showQty(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('mal:q:')) {
    session.qty = Math.max(0, parseInt(data.slice('mal:q:'.length), 10) || 0);
    sessionStore.set(userId, session);
    await showConfirm(bot, chatId, userId);
    return true;
  }

  if (data === 'mal:save') {
    await save(bot, chatId, userId);
    return true;
  }

  if (data === 'mal:again') {
    session.page = 0; session.design = ''; session.qty = 0;
    sessionStore.set(userId, session);
    await showDesigns(bot, chatId, userId);
    return true;
  }

  if (data === 'mal:back') {
    if (session.step === 'confirm') await showQty(bot, chatId, userId);
    else if (session.step === 'qty') await showDesigns(bot, chatId, userId);
    else await showMarketers(bot, chatId, userId);
    return true;
  }

  return true;
}

module.exports = {
  start,
  handleCallback,
  // Internals exposed for offline tests only.
  _internals: { showMarketers, showDesigns, showQty, showConfirm, save, SESSION_TYPE },
};
