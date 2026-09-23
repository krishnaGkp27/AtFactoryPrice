'use strict';
/**
 * RMV-1 Phase B, the customer half (owner, 23-Sep-2026: "make a provision
 * inside the bot to deactivate the customer with two admin approvals").
 *
 * The engine shipped on 16-Aug — `remove_customer` / `restore_customer` in
 * all three policy lists, the executor that flips the Customers row AND its
 * bound Contacts node, and `buildRemoveCustomerCard` — but nothing in
 * Telegram could raise one. This is the door, in CON-1's shape:
 *
 *   1. pick the customer (active ones A–Z, ten a page, or type to search)
 *   2. type the reason (3–120 chars; it rides the queue row and the audit)
 *   3. the card — name · id · phone · category, what they owe (disclosed,
 *      never a gate), how many supplies are on record, who sits under them
 *      in the network — then ✅ Submit → the dual-admin approval queue.
 *
 * A removal is a STATUS FLIP, never a deletion (§14): the row and every
 * sale stay; the person stops appearing in pickers, search and the network.
 * The same door restores: ↩️ Restore lists the inactive customers instead.
 *
 * Identity: the request id is minted when the confirm card is DRAWN and the
 * queue write is appendOnce (SUB-1), so a double tap or a retry can never
 * queue the same removal twice.
 *
 * Callback namespace `rmc:*` — start · mode:<remove|restore> · pick:<i> ·
 * page:<n> · back:<step> · submit · cancel · noop.
 */
const sessionStore = require('../utils/sessionStore');
const { mdEscape, rowsFor } = require('../utils/flowKit');
const auth = require('../middlewares/auth');
const customersRepository = require('../repositories/customersRepository');
const contactsRepository = require('../repositories/contactsRepository');
const contactLinksRepository = require('../repositories/contactLinksRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const approvalEvents = require('../events/approvalEvents');
const approvalCards = require('../services/approvalCards');
const riskEvaluate = require('../risk/evaluate');
const idGenerator = require('../utils/idGenerator');
const logger = require('../utils/logger');

const SESSION_TYPE = 'customer_remove_flow';
const PAGE_SIZE = 10;
const REASON_MIN = 3;
const REASON_MAX = 120;
const HUSK = new Set(['merged', 'rejected', 'inactive']);
const { cancelRow } = rowsFor('rmc');

const MODES = Object.freeze({
  remove: { action: 'remove_customer', title: '➖ *Remove customer*', verb: 'remove', other: 'restore', otherLabel: '↩️ Restore a removed customer' },
  restore: { action: 'restore_customer', title: '↩️ *Restore customer*', verb: 'restore', other: 'remove', otherLabel: '➖ Remove a customer' },
});

async function render(bot, chatId, userId, text, rows) {
  const session = sessionStore.get(userId);
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (session && session.flowMessageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: session.flowMessageId, ...opts });
      return;
    } catch (e) {
      if (/not modified/i.test(String(e.message || ''))) return;
    }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  if (sent && sent.message_id && session) { session.flowMessageId = sent.message_id; sessionStore.set(userId, session); }
}

/** Customers this mode may act on: live rows for remove, inactive rows for restore. */
async function candidates(mode, query = '') {
  const all = await customersRepository.getAll();
  const q = String(query || '').trim().toLowerCase();
  return all
    .filter((c) => c.customer_id && c.name)
    .filter((c) => {
      const st = String(c.status || 'Active').trim().toLowerCase();
      return mode === 'restore' ? st === 'inactive' : !HUSK.has(st);
    })
    .filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.phone || '').includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

async function start(bot, chatId, userId, messageId, mode = 'remove') {
  if (!auth.isAdmin(userId)) {
    try { await bot.sendMessage(chatId, 'Admin only.'); } catch (_) { /* best-effort */ }
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE, mode: MODES[mode] ? mode : 'remove', step: 'pick',
    flowMessageId: messageId || null, page: 0, query: '', target: null,
  });
  await renderPick(bot, chatId, userId);
}

async function renderPick(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const m = MODES[session.mode];
  let list = [];
  try { list = await candidates(session.mode, session.query); } catch (e) { logger.warn(`customerRemoveFlow: customers read failed: ${e.message}`); }
  const rows = [];
  if (!list.length) {
    rows.push([{ text: m.otherLabel, callback_data: `rmc:mode:${m.other}` }]);
    rows.push(cancelRow());
    await render(bot, chatId, userId,
      `${m.title}\n\n_${session.query ? `No customer matches "${mdEscape(session.query)}".` : `No customer to ${m.verb}.`}_`, rows);
    return;
  }
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, session.page || 0), pages - 1);
  const slice = list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  session._pick = slice.map((c) => c.customer_id);
  session.page = page;
  sessionStore.set(userId, session);
  slice.forEach((c, i) => rows.push([{ text: `👤 ${c.name.slice(0, 40)}${c.phone ? ` · ${c.phone}` : ''}`.slice(0, 60), callback_data: `rmc:pick:${i}` }]));
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `rmc:page:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'rmc:noop' });
    if (page < pages - 1) nav.push({ text: 'Next ➡️', callback_data: `rmc:page:${page + 1}` });
    rows.push(nav);
  }
  rows.push([{ text: m.otherLabel, callback_data: `rmc:mode:${m.other}` }]);
  rows.push(cancelRow());
  const filter = session.query ? `\n🔎 _${mdEscape(session.query)}_ — ${list.length} match${list.length === 1 ? '' : 'es'}` : '';
  await render(bot, chatId, userId,
    `${m.title}\n\n_Step 1 of 3 — tap the customer to ${m.verb}, or type a name to search._${filter}`, rows);
}

async function renderReason(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.target) return;
  const m = MODES[session.mode];
  session.step = 'reason'; sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `${m.title} — *${mdEscape(session.target.name)}*\n\n_Step 2 of 3 — type the reason (${REASON_MIN}–${REASON_MAX} characters). It is written on the approval card and the audit log._`,
    [[{ text: '⬅️ Back', callback_data: 'rmc:back:pick' }, ...cancelRow()]]);
}

/** What the card discloses: what they owe, what they were supplied, who sits under them. */
async function enrich(target) {
  const out = { outstanding_balance: Number(target.outstanding_balance || 0), supply_count: 0, last_supply_date: '', network_children: 0 };
  try {
    const names = new Set([target.name, ...(target.aliases || [])].map((n) => String(n || '').trim().toLowerCase()).filter(Boolean));
    const sold = (await inventoryRepository.getSoldRows()).filter((r) => names.has(String(r.soldTo || '').trim().toLowerCase()));
    out.supply_count = sold.length;
    out.last_supply_date = sold.map((r) => String(r.soldDate || '')).filter(Boolean).sort().pop() || '';
  } catch (e) { logger.warn(`customerRemoveFlow: history read failed: ${e.message}`); }
  try {
    const node = await contactsRepository.findByCustomerId(target.customer_id);
    if (node) {
      const links = await contactLinksRepository.getActive();
      out.network_children = links.filter((l) => l.to_contact_id === node.contact_id).length;
    }
  } catch (e) { logger.warn(`customerRemoveFlow: network read failed: ${e.message}`); }
  return out;
}

function buildActionJSON(session) {
  const t = session.target;
  return {
    action: MODES[session.mode].action,
    customer_id: t.customer_id, name: t.name, phone: t.phone || '', category: t.category || '',
    reason: session.reason || '',
    ...(session._enrich || {}),
  };
}

async function renderConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.target) return;
  session.step = 'confirm';
  if (!session._enrich) session._enrich = await enrich(session.target);
  // SUB-1 — the identity of this send is minted when the card is drawn.
  if (!session.requestId) session.requestId = idGenerator.requestId();
  sessionStore.set(userId, session);
  const card = approvalCards.buildRemoveCustomerCard(buildActionJSON(session));
  await render(bot, chatId, userId,
    `${mdEscape(card)}\n\n_Step 3 of 3 — submitting queues this for a second admin's approval; you cannot approve it yourself._`,
    [[{ text: '✅ Submit for approval', callback_data: 'rmc:submit' }],
      [{ text: '⬅️ Back', callback_data: 'rmc:back:reason' }, ...cancelRow()]]);
}

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || !session.target || !session.requestId) return;
  if (session._submitting) return;
  session._submitting = true; sessionStore.set(userId, session);
  const aj = buildActionJSON(session);
  const requestId = session.requestId;
  try {
    const risk = await riskEvaluate.evaluate({ action: aj.action, userId });
    const { created } = await approvalQueueRepository.appendOnce({
      requestId, user: userId, actionJSON: aj,
      riskReason: risk.reason || 'dual_admin_required', status: 'pending',
    });
    if (created) {
      await auditLogRepository.append('approval_queued', { requestId, action: aj.action, customer_id: aj.customer_id, reason: aj.reason }, userId);
      const userLabel = await approvalCards.resolveUserLabel(userId);
      await approvalEvents.notifyAdminsApprovalRequest(
        bot, requestId, userLabel, approvalCards.buildRemoveCustomerCard(aj), risk.reason, auth.isAdmin(userId) ? userId : undefined,
      );
    }
    sessionStore.clear(userId);
    await bot.sendMessage(chatId,
      `⏳ *${created ? 'Submitted' : 'Already submitted'} for a second admin's approval*\n${mdEscape(MODES[session.mode].verb === 'remove' ? 'Remove' : 'Restore')} *${mdEscape(aj.name)}*\nRequest: \`${approvalCards.shortRequestRef ? approvalCards.shortRequestRef(requestId) : requestId}\``,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]] } });
  } catch (e) {
    logger.error(`customerRemoveFlow.submit failed: ${e.message}`);
    const s = sessionStore.get(userId);
    if (s) { s._submitting = false; sessionStore.set(userId, s); }
    await render(bot, chatId, userId, `⚠️ Could not queue: ${mdEscape(e.message)}`, [[{ text: '⬅️ Back', callback_data: 'rmc:back:reason' }, ...cancelRow()]]);
  }
}

/** Typed text: a search filter on the pick step, the reason on the reason step. */
async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;
  const text = String(msg.text || '').trim();
  if (!text || text.startsWith('/')) return false;
  if (session.step === 'pick') {
    session.query = text.slice(0, 40); session.page = 0; sessionStore.set(userId, session);
    await renderPick(bot, chatId, userId);
    return true;
  }
  if (session.step === 'reason') {
    if (text.length < REASON_MIN || text.length > REASON_MAX) {
      await bot.sendMessage(chatId, `The reason must be ${REASON_MIN}–${REASON_MAX} characters (${text.length} typed). Try again.`);
      return true;
    }
    session.reason = text; sessionStore.set(userId, session);
    await renderConfirm(bot, chatId, userId);
    return true;
  }
  return false;
}

async function handleCallback(bot, query) {
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  const data = String(query.data || '');
  if (!data.startsWith('rmc:')) return false;
  const ack = (text) => bot.answerCallbackQuery(query.id, text ? { text, show_alert: true } : undefined).catch(() => {});
  if (data === 'rmc:start') { await ack(); await start(bot, chatId, userId, query.message.message_id, 'remove'); return true; }
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) { await ack('This screen has expired — open ➖ Remove Customer again.'); return true; }
  if (data === 'rmc:noop') { await ack(); return true; }
  if (data === 'rmc:cancel') {
    await ack(); sessionStore.clear(userId);
    await render(bot, chatId, userId, '❌ Cancelled — nothing was changed.', [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]]);
    return true;
  }
  if (data.startsWith('rmc:mode:')) {
    const mode = data.slice(9);
    if (!MODES[mode]) { await ack(); return true; }
    await ack();
    session.mode = mode; session.step = 'pick'; session.page = 0; session.query = ''; session.target = null;
    delete session._enrich; delete session.requestId; delete session.reason;
    sessionStore.set(userId, session);
    await renderPick(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('rmc:page:')) {
    await ack(); session.page = parseInt(data.slice(9), 10) || 0; sessionStore.set(userId, session);
    await renderPick(bot, chatId, userId); return true;
  }
  if (data.startsWith('rmc:pick:')) {
    const id = (session._pick || [])[parseInt(data.slice(9), 10)];
    const target = id ? await customersRepository.findById(id) : null;
    if (!target) { await ack('That chip belongs to an earlier list — pick again.'); await renderPick(bot, chatId, userId); return true; }
    await ack();
    session.target = { customer_id: target.customer_id, name: target.name, phone: target.phone, category: target.category, outstanding_balance: target.outstanding_balance, aliases: target.aliases || [] };
    delete session._enrich; delete session.requestId; delete session.reason;
    sessionStore.set(userId, session);
    await renderReason(bot, chatId, userId);
    return true;
  }
  if (data === 'rmc:back:pick') { await ack(); session.step = 'pick'; session.target = null; delete session.requestId; sessionStore.set(userId, session); await renderPick(bot, chatId, userId); return true; }
  if (data === 'rmc:back:reason') { await ack(); await renderReason(bot, chatId, userId); return true; }
  if (data === 'rmc:submit') { await ack(); await submit(bot, chatId, userId); return true; }
  await ack();
  return true;
}

module.exports = { SESSION_TYPE, start, handleCallback, handleText, _internals: { candidates, enrich, buildActionJSON, MODES, REASON_MIN, REASON_MAX } };
