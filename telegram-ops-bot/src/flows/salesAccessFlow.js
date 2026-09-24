'use strict';

/**
 * src/flows/salesAccessFlow.js — 🔐 SALES ACCESS (SSA-1, owner go 24-Sep-2026).
 *
 * "An admin feature where I can grant access to see the sales from
 * different warehouses to different employees … through checkboxes."
 *
 *   A. pick_user   — one chip per active non-admin person in the Users
 *                    sheet, showing what they hold today
 *                    (`👤 Abdul · Kano office` / `👤 Musa · —`).
 *   B. tick_places — one ✅/⬜ chip per place the bot knows; tap toggles in
 *                    place; ✅ Save writes Users column L, logs one AuditLog
 *                    line and DMs the person what they can now see (owner:
 *                    immediate, tell them — but a removal is silent).
 *
 * Owner rulings (24-Sep-2026): immediate (single admin, no second
 * signature — read access only, one tap revokes); tell the employee;
 * nothing until ticked. What the grant opens: 🏬 Store Sales and
 * 📒 Customer Supplies, both scoped to the ticked places by
 * salesAccessService. 📦 Supply Details is untouched ("needs more
 * polishing, leave this for now").
 *
 * Callback namespace `ssa:*`:
 *   ssa:menu       screen A's 🏠 Back to menu (ends the session first)
 *   ssa:close      end the flow → the card becomes "Closed." + menu
 *   ssa:back       B → A
 *   ssa:u:<i>      pick a person (index into session._users)
 *   ssa:p:<i>      toggle a place (index into session._places)
 *   ssa:save       write the ticks
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor, chunk, disposeAux } = require('../utils/flowKit');
const usersRepository = require('../repositories/usersRepository');
const salesAccessService = require('../services/salesAccessService');
const auth = require('../middlewares/auth');
const config = require('../config');
const logger = require('../utils/logger');

const SESSION_TYPE = 'sales_access_flow';
const NS = 'ssa';
const PEOPLE_PER_ROW = 2;
const PLACES_PER_ROW = 2;
const PEOPLE_CAP = 40; // Telegram allows 100 buttons; keep the card readable

const render = makeRenderer();
const { backRow, closeRow, menuRow } = rowsFor(NS);

/**
 * Bold a sheet string under legacy Markdown: no escapes are honoured
 * inside an entity, so only `*` matters — close and reopen around it.
 */
function bold(v) {
  const s = String(v == null ? '' : v).trim() || '—';
  return `*${s.replace(/\*/g, '*\\**')}*`;
}

/** Active, non-admin people: the ones a grant can apply to. */
async function loadPeople() {
  const all = await usersRepository.getAll();
  const seen = new Set();
  const people = [];
  for (const u of all) {
    if (!u.user_id || (u.status || 'active') !== 'active') continue;
    if (seen.has(u.user_id)) continue;
    if (auth.isAdmin(u.user_id) || config.access.adminIds.includes(String(u.user_id))) continue;
    if (String(u.role || '').toLowerCase() === 'admin') continue;
    seen.add(u.user_id);
    people.push(u);
  }
  return people.sort((a, b) => String(a.name || a.user_id).localeCompare(String(b.name || b.user_id), 'en', { sensitivity: 'base' }));
}

/* ───────────────────────────── entry ───────────────────────────── */

async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, '🔐 Sales Access is admin-only.');
    return;
  }
  const prev = sessionStore.get(userId);
  if (prev && prev.type !== SESSION_TYPE) {
    await disposeAux(bot, chatId, userId);
    sessionStore.clear(userId, 'cancelled');
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'pick_user',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    _users: [],
    _places: [],
    _ticked: [],
    target: null,
  });
  await renderPeople(bot, chatId, userId);
}

/* ───────────────────────────── screen A — people ───────────────────────────── */

async function renderPeople(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const people = await loadPeople();
  if (!people.length) {
    await render(bot, chatId, userId, '🔐 *Sales Access*\n\n_No active employees in the Users sheet yet._', [menuRow()]);
    sessionStore.clear(userId, 'completed');
    return;
  }
  const shown = people.slice(0, PEOPLE_CAP);
  session._users = shown.map((u) => ({ id: u.user_id, name: u.name || u.user_id, places: u.store_sales_places || [] }));
  sessionStore.set(userId, session);
  const tiles = session._users.map((u, i) => ({
    text: `👤 ${u.name} · ${u.places.length ? u.places.join(', ') : '—'}`,
    callback_data: `${NS}:u:${i}`,
  }));
  const rows = chunk(tiles, PEOPLE_PER_ROW);
  rows.push([{ text: '🏠 Back to menu', callback_data: `${NS}:menu` }]);
  const cap = people.length > PEOPLE_CAP ? `\n_Showing the first ${PEOPLE_CAP} of ${people.length} people._` : '';
  await render(bot, chatId, userId,
    '🔐 *Sales Access*\n\nWho may see store sales? Tap a person.' + cap, rows);
}

/* ───────────────────────────── screen B — places ───────────────────────────── */

async function renderPlaces(bot, chatId, userId, note) {
  const session = sessionStore.get(userId);
  if (!session || !session.target) return;
  if (!session._places.length) {
    session._places = await salesAccessService.listPlaces();
    // A granted place the register no longer lists stays tickable, so a
    // renamed or retired place can still be unticked.
    for (const p of session._ticked) {
      if (!session._places.some((x) => salesAccessService.placeKey(x) === salesAccessService.placeKey(p))) session._places.push(p);
    }
    sessionStore.set(userId, session);
  }
  const ticked = new Set(session._ticked.map(salesAccessService.placeKey));
  const tiles = session._places.map((p, i) => ({
    text: `${ticked.has(salesAccessService.placeKey(p)) ? '✅' : '⬜'} ${p}`,
    callback_data: `${NS}:p:${i}`,
  }));
  const rows = chunk(tiles, PLACES_PER_ROW);
  rows.push([{ text: '✅ Save', callback_data: `${NS}:save` }]);
  rows.push([{ text: '👤 Change person', callback_data: `${NS}:back` }, ...closeRow()]);
  const body = `🔐 ${bold(`Sales Access — ${session.target.name}`)}\n\n`
    + (session._places.length
      ? `Tick the places ${bold(session.target.name)} may see, then Save.`
      : '_No warehouse or store is registered yet._')
    + (note ? `\n\n${note}` : '');
  await render(bot, chatId, userId, body, rows);
}

async function save(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.target) return;
  const user = await usersRepository.findByUserId(session.target.id);
  if (!user) {
    await renderPlaces(bot, chatId, userId, '⚠️ That person is no longer in the Users sheet.');
    return;
  }
  let result;
  try {
    result = await salesAccessService.grant({ bot, adminId: userId, user, places: session._ticked });
  } catch (e) {
    logger.warn(`salesAccessFlow: save failed for ${user.user_id}: ${e.message}`);
    result = { ok: false };
  }
  if (!result.ok) {
    await renderPlaces(bot, chatId, userId, '⚠️ Could not save — try again.');
    return;
  }
  const places = session._ticked.slice();
  const line = places.length
    ? `✅ ${bold(user.name || user.user_id)} now sees the sales of ${places.map((p) => bold(p)).join(', ')}.`
    : `✅ ${bold(user.name || user.user_id)} no longer sees any store's sales.`;
  const told = result.told ? '\n_They have been told._' : (result.changed ? '' : '\n_No change — nothing sent._');
  session.step = 'saved';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId, `🔐 *Sales Access*\n\n${line}${told}`,
    [[{ text: '👤 Change person', callback_data: `${NS}:back` }], closeRow()]);
}

/* ───────────────────────────── navigation ───────────────────────────── */

async function closeFlow(bot, chatId, userId, outcome) {
  await render(bot, chatId, userId, '🔐 Closed.', [menuRow()]);
  sessionStore.clear(userId, outcome);
}

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith(`${NS}:`)) return false;
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const messageId = query.message && query.message.message_id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);

  if (data === `${NS}:menu`) {
    if (session && session.type === SESSION_TYPE) sessionStore.clear(userId, 'cancelled');
    await require('../controllers/telegramController').handleCallbackQuery(bot, { ...query, data: 'act:__back__' });
    return true;
  }

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  if (!session || session.type !== SESSION_TYPE) {
    if (chatId && messageId) {
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }); } catch (_) { /* gone */ }
    }
    if (chatId) {
      try {
        await bot.sendMessage(chatId, '🔐 That Sales Access screen has expired — open 🔐 Sales Access again.',
          { reply_markup: { inline_keyboard: [menuRow()] } });
      } catch (_) { /* ignore */ }
    }
    return true;
  }
  if (!auth.isAdmin(userId)) { await closeFlow(bot, chatId, userId, 'cancelled'); return true; }

  if (data === `${NS}:close`) { await closeFlow(bot, chatId, userId, 'completed'); return true; }

  if (data === `${NS}:back`) {
    session.step = 'pick_user';
    session.target = null;
    session._ticked = [];
    sessionStore.set(userId, session);
    await renderPeople(bot, chatId, userId);
    return true;
  }

  if (data.startsWith(`${NS}:u:`)) {
    if (session.step !== 'pick_user') return true;
    const i = parseInt(data.slice(`${NS}:u:`.length), 10);
    const u = (session._users || [])[i];
    if (u) {
      session.target = { id: u.id, name: u.name };
      session._ticked = u.places.slice();
      session.step = 'tick_places';
      sessionStore.set(userId, session);
      await renderPlaces(bot, chatId, userId);
    }
    return true;
  }

  if (data.startsWith(`${NS}:p:`)) {
    if (session.step !== 'tick_places') return true;
    const i = parseInt(data.slice(`${NS}:p:`.length), 10);
    const p = (session._places || [])[i];
    if (p) {
      const k = salesAccessService.placeKey(p);
      const at = session._ticked.findIndex((x) => salesAccessService.placeKey(x) === k);
      if (at >= 0) session._ticked.splice(at, 1); else session._ticked.push(p);
      sessionStore.set(userId, session);
      await renderPlaces(bot, chatId, userId);
    }
    return true;
  }

  if (data === `${NS}:save`) {
    if (session.step !== 'tick_places') return true;
    await save(bot, chatId, userId);
    return true;
  }

  return true;
}

module.exports = {
  start,
  handleCallback,
  _internals: { SESSION_TYPE, NS, loadPeople, renderPeople, renderPlaces, save },
};
