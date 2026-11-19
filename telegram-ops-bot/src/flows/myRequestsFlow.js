'use strict';

/**
 * REQ-1 — 📨 My Requests (beside 📋 My Tasks, for everyone). Session-free:
 * every screen is rebuilt from the ApprovalQueue at the tap, and every tap
 * re-checks who may see what, so a card survives a restart and a forwarded
 * or crafted button shows nothing it should not.
 *
 * Owner, 19-Nov-2026: "every employee admin can see the list of requests
 * for his own, along with the other employees, with the meaningful chips".
 *
 * Screens:
 *   list    ⏳ Waiting · ✅ Approved · ❌ Rejected chips (with counts); an
 *           admin also gets 🙋 Mine · 👥 Everyone · 👤 By person; eight
 *           requests a page, each two lines, opened by its number chip.
 *   people  (admin) one chip per person who has requests in that group.
 *   detail  the request's status card — who signed, who is awaited — with
 *           🔔 Remind approvers for a request still waiting.
 *
 * Decided requests are listed for Settings APPROVALS_DECIDED_DAYS (the
 * 🛂 inbox's window); a waiting request is listed until it is decided.
 *
 * Callback namespace `myr:` —
 *   l:<scope>:<status>:<page>            a list
 *   p:<status>                           the people picker (admin)
 *   o:<scope>:<status>:<page>:<request>  one request
 *   noop
 * scope = m (mine) · e (everyone) · u<id> (one person); status = w · a · r.
 */

const auth = require('../middlewares/auth');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const settingsRepository = require('../repositories/settingsRepository');
const approvalCards = require('../services/approvalCards');
const approvalGate = require('../services/approvalGate');
const progress = require('../services/approvalProgress');
const myRequests = require('../services/myRequests');
const { editOrSend } = require('../utils/telegramUI');
const logger = require('../utils/logger');

const NS = 'myr';
const CB_MAX = 64;
const { STATUS_LABEL } = myRequests;

async function nameOf(id, bot) {
  try {
    const n = await approvalCards.resolveUserLabel(String(id), bot);
    return n && n !== 'Unknown' ? n : `id ${id}`;
  } catch (_) { return `id ${id}`; }
}

async function decidedDays() {
  const fallback = Number(settingsRepository.DEFAULTS.APPROVALS_DECIDED_DAYS);
  try {
    const v = Number((await settingsRepository.getAll()).APPROVALS_DECIDED_DAYS);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  } catch (_) { return fallback; }
}

/** Every row the viewer may see in this scope, inside the decided window. */
async function load(viewerId, scope) {
  const isAdmin = auth.isAdmin(String(viewerId));
  const eff = myRequests.effectiveScope(scope, isAdmin);
  const all = await approvalQueueRepository.getAllWithRowIndex();
  const days = await decidedDays();
  const now = Date.now();
  const rows = myRequests.scopeRows(all, { viewerId, isAdmin, scope: eff }).filter((r) => myRequests.inWindow(r, days, now));
  return { isAdmin, scope: eff, rows, days };
}

/** The callback that opens one request; the id is cut only when it must be. */
function openCb(scope, st, page, requestId) {
  const head = `${NS}:o:${scope}:${st}:${page}:`;
  const room = CB_MAX - Buffer.byteLength(head);
  let id = String(requestId);
  while (Buffer.byteLength(id) > room) id = id.slice(0, -1);
  return head + id;
}

async function scopeTitle(scope, bot) {
  if (scope === 'e') return 'Everyone\'s requests';
  if (scope.startsWith('u')) return `Requests of ${await nameOf(scope.slice(1), bot)}`;
  return 'My requests';
}

async function renderList(bot, chatId, messageId, viewerId, scopeIn, stIn, pageIn, note = '') {
  const st = myRequests.STATUS_KEYS.includes(stIn) ? stIn : 'w';
  let data;
  try { data = await load(viewerId, scopeIn); } catch (e) {
    logger.warn(`myRequestsFlow: queue read failed: ${e.message}`);
    await editOrSend(bot, chatId, messageId, '📨 My requests\n\n⚠️ The requests could not be read just now. Try again in a moment.', {
      reply_markup: { inline_keyboard: [[{ text: '🔁 Try again', callback_data: `${NS}:l:${scopeIn || 'm'}:${st}:0` }], [{ text: '🏠 Menu', callback_data: 'act:__back__' }]] },
    });
    return;
  }
  const { isAdmin, scope, rows, days } = data;
  const count = myRequests.counts(rows);
  const list = myRequests.sortRows(rows.filter((r) => myRequests.statusKey(r) === st));
  const pg = myRequests.pageOf(list, pageIn);
  const showWho = scope === 'e';

  const lines = [`📨 ${await scopeTitle(scope, bot)} · ${STATUS_LABEL[st]}`];
  if (st !== 'w' && days > 0) lines.push(`Decided in the last ${days} day${days === 1 ? '' : 's'}.`);
  lines.push('');
  if (!pg.rows.length) {
    lines.push(st === 'w' ? 'Nothing is waiting.' : 'Nothing here.');
  } else {
    const now = Date.now();
    for (let i = 0; i < pg.rows.length; i += 1) {
      const row = pg.rows[i];
      const who = showWho ? await nameOf(row.user, bot) : '';
      lines.push(...myRequests.rowLines(row, pg.page * myRequests.PAGE_SIZE + i + 1, {
        showWho, who, required: approvalGate.requiredFor(row), now,
      }));
    }
    if (pg.pages > 1) { lines.push(''); lines.push(`page ${pg.page + 1} of ${pg.pages}`); }
  }
  if (note) { lines.push(''); lines.push(note); }

  const kb = [];
  kb.push(myRequests.STATUS_KEYS.map((k) => ({
    text: `${STATUS_LABEL[k]} · ${count[k]}${k === st ? ' ✓' : ''}`, callback_data: `${NS}:l:${scope}:${k}:0`,
  })));
  if (isAdmin) {
    kb.push([
      { text: `🙋 Mine${scope === 'm' ? ' ✓' : ''}`, callback_data: `${NS}:l:m:${st}:0` },
      { text: `👥 Everyone${scope === 'e' ? ' ✓' : ''}`, callback_data: `${NS}:l:e:${st}:0` },
      { text: `👤 By person${scope.startsWith('u') ? ' ✓' : ''}`, callback_data: `${NS}:p:${st}` },
    ]);
  }
  // one number chip per request on the page, four to a row
  for (let i = 0; i < pg.rows.length; i += 4) {
    kb.push(pg.rows.slice(i, i + 4).map((row, j) => ({
      text: String(pg.page * myRequests.PAGE_SIZE + i + j + 1), callback_data: openCb(scope, st, pg.page, row.requestId),
    })));
  }
  if (pg.pages > 1) {
    kb.push([
      pg.page > 0 ? { text: '◀ Back', callback_data: `${NS}:l:${scope}:${st}:${pg.page - 1}` } : { text: ' ', callback_data: `${NS}:noop` },
      pg.page < pg.pages - 1 ? { text: 'Next ▶', callback_data: `${NS}:l:${scope}:${st}:${pg.page + 1}` } : { text: ' ', callback_data: `${NS}:noop` },
    ]);
  }
  kb.push([{ text: '🏠 Menu', callback_data: 'act:__back__' }]);
  await editOrSend(bot, chatId, messageId, lines.join('\n'), { reply_markup: { inline_keyboard: kb } });
}

/** Admin: who has requests in this group. */
async function renderPeople(bot, chatId, messageId, viewerId, stIn) {
  const st = myRequests.STATUS_KEYS.includes(stIn) ? stIn : 'w';
  if (!auth.isAdmin(String(viewerId))) { await renderList(bot, chatId, messageId, viewerId, 'm', st, 0); return; }
  const { rows } = await load(viewerId, 'e');
  const ppl = myRequests.people(rows.filter((r) => myRequests.statusKey(r) === st)).slice(0, 24);
  const kb = [];
  for (let i = 0; i < ppl.length; i += 2) {
    const row = [];
    for (const p of ppl.slice(i, i + 2)) {
      row.push({ text: `👤 ${await nameOf(p.id, bot)} · ${p.count}`.slice(0, 60), callback_data: `${NS}:l:u${p.id}:${st}:0` });
    }
    kb.push(row);
  }
  kb.push([{ text: '⬅ Back', callback_data: `${NS}:l:e:${st}:0` }, { text: '🏠 Menu', callback_data: 'act:__back__' }]);
  await editOrSend(bot, chatId, messageId,
    `📨 Requests by person · ${STATUS_LABEL[st]}\n\n${ppl.length ? 'Tap a person.' : 'Nobody has a request here.'}`,
    { reply_markup: { inline_keyboard: kb } });
}

async function renderDetail(bot, chatId, messageId, viewerId, scopeIn, st, page, idKey) {
  const { isAdmin, scope, rows } = await load(viewerId, scopeIn);
  // the full id, or — when the button had to cut it — the one row it starts
  const row = rows.find((r) => String(r.requestId) === idKey)
    || ((m) => (m.length === 1 ? m[0] : null))(rows.filter((r) => String(r.requestId).startsWith(idKey)));
  if (!row) {
    // decided since, out of the window, or not theirs: the list says what is there now
    await renderList(bot, chatId, messageId, viewerId, scope, st, page, 'That request is no longer on this list.');
    return;
  }
  const aj = row.actionJSON || {};
  const trail = progress.trailOf(aj);
  for (const s of trail) if (!s.name && s.id) s.name = await nameOf(s.id, bot);
  const pending = myRequests.statusKey(row) === 'w';
  const required = approvalGate.requiredFor(row);
  let text = progress.buildStatus({
    row, signoffs: trail, required,
    raisedByName: await nameOf(row.user, bot),
    ageWords: pending ? `${myRequests.age(row.createdAt)} waiting` : '',
  });
  // a transfer and a supply request move through stages of their own
  if (pending && (aj.action === 'transfer_stock' || aj.action === 'supply_request')) {
    text += `\n${myRequests.waitingWords(row, required)}`;
  }
  const mine = String(row.user) === String(viewerId);
  const kb = [];
  const nudgeCb = `apg:nudge:${row.requestId}`;
  if (pending && (mine || isAdmin) && Buffer.byteLength(nudgeCb) <= CB_MAX) {
    kb.push([{ text: '🔔 Remind approvers', callback_data: nudgeCb }]);
  }
  if (pending && isAdmin && !mine) kb.push([{ text: '🛂 Open Approvals', callback_data: 'act:approvals_inbox' }]);
  kb.push([{ text: '⬅ Back to list', callback_data: `${NS}:l:${scope}:${st}:${page}` }, { text: '🏠 Menu', callback_data: 'act:__back__' }]);
  await editOrSend(bot, chatId, messageId, text, { reply_markup: { inline_keyboard: kb } });
}

async function start(bot, chatId, userId, messageId = null) {
  await renderList(bot, chatId, messageId, String(userId), 'm', 'w', 0);
}

async function handleCallback(bot, callbackQuery) {
  const data = String(callbackQuery.data || '');
  if (!data.startsWith(`${NS}:`)) return false;
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id;
  const messageId = callbackQuery.message && callbackQuery.message.message_id;
  try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) { /* stale query */ }
  const parts = data.split(':');
  try {
    if (parts[1] === 'l') {
      await renderList(bot, chatId, messageId, userId, parts[2], parts[3], parseInt(parts[4], 10) || 0);
    } else if (parts[1] === 'p') {
      await renderPeople(bot, chatId, messageId, userId, parts[2]);
    } else if (parts[1] === 'o') {
      await renderDetail(bot, chatId, messageId, userId, parts[2], parts[3], parseInt(parts[4], 10) || 0, parts.slice(5).join(':'));
    }
  } catch (e) {
    logger.warn(`myRequestsFlow: ${data} failed: ${e.message}`);
    try { await bot.sendMessage(chatId, '⚠️ That could not be shown just now. Open 📨 My Requests again.'); } catch (_) { /* ignore */ }
  }
  return true;
}

module.exports = { NS, start, handleCallback, _internals: { openCb, renderList, renderDetail, renderPeople } };
