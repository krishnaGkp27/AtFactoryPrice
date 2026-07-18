'use strict';

/**
 * CNET-1b — 📇 Contact Network (specs/CNET-1_CONTACT_NETWORK.md, locked).
 *
 * Category → buyers (recency-first, derived from sales) → person card
 * (live phone, native Telegram contact card, wa.me) → subordinates →
 * recursion via the ContactLinks edge graph. ➕ Add person queues an
 * `add_contact_link` approval (single non-requester admin).
 *
 * Access (locked decision 1): admins + managers see everything; other
 * staff see only buyers whose purchases touch their own warehouses.
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, chunk, mdEscape } = require('../utils/flowKit');
const auth = require('../middlewares/auth');
const usersRepository = require('../repositories/usersRepository');
const designCategoriesRepo = require('../repositories/designCategoriesRepository');
const contactsRepository = require('../repositories/contactsRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const contactGraph = require('../services/contactGraphService');
const idGenerator = require('../utils/idGenerator');
const phoneUtil = require('../utils/phone');
const logger = require('../utils/logger');

const SESSION_TYPE = 'contact_network_flow';
const NS = 'cn:';
const PAGE = 8;

const render = makeRenderer({ parseMode: 'Markdown', requireSession: SESSION_TYPE });

function navRow(extra = []) {
  return [...extra, { text: '🏠 Menu', callback_data: 'act:__back__' }];
}

async function callerScope(userId) {
  if (auth.isAdmin(userId)) return { full: true };
  const u = await usersRepository.findByUserId(userId).catch(() => null);
  const role = ((u && u.role) || '').toLowerCase();
  if (role === 'manager') return { full: true };
  const warehouses = (u && u.warehouses) || [];
  return { full: false, warehouses: Array.isArray(warehouses) ? warehouses : String(warehouses).split(',').map((s) => s.trim()).filter(Boolean) };
}

/* ── screens ── */

async function showCategories(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const cats = await designCategoriesRepo.listCategories();
  session._cats = cats;
  sessionStore.set(userId, session);
  const rows = chunk(cats.map((c, i) => ({
    text: `${designCategoriesRepo.iconFor(c)} ${c}`, callback_data: `${NS}c:${i}`,
  })), 2);
  rows.push(navRow());
  await render(bot, chatId, userId, '📇 *Contact Network*\n\nPick a product category to see its buyers and their people.', rows);
}

async function showBuyers(bot, chatId, userId, page = 0) {
  const session = sessionStore.get(userId);
  const scope = await callerScope(userId);
  let buyers = await contactGraph.buyersOfCategory(session.category);
  if (!scope.full) {
    buyers = buyers.filter((b) => (b.warehouses || []).some((w) => scope.warehouses.includes(w)));
  }
  session._buyers = buyers;
  session._page = page;
  session._stack = [];
  sessionStore.set(userId, session);
  if (!buyers.length) {
    await render(bot, chatId, userId, `📇 *${mdEscape(session.category)}* — no buyers on record${scope.full ? '' : ' in your warehouses'}.`,
      [navRow([{ text: '◀ Categories', callback_data: `${NS}cats` }])]);
    return;
  }
  const pages = Math.max(1, Math.ceil(buyers.length / PAGE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = buyers.slice(p * PAGE, p * PAGE + PAGE);
  const rows = chunk(slice.map((b, i) => ({ text: `👤 ${b.name}`, callback_data: `${NS}b:${p * PAGE + i}` })), 2);
  const pager = [];
  if (p > 0) pager.push({ text: '◀ Prev', callback_data: `${NS}bp:${p - 1}` });
  if (p < pages - 1) pager.push({ text: `More ▶ (${buyers.length - (p + 1) * PAGE})`, callback_data: `${NS}bp:${p + 1}` });
  if (pager.length) rows.push(pager);
  rows.push(navRow([{ text: '◀ Categories', callback_data: `${NS}cats` }]));
  await render(bot, chatId, userId,
    `📇 *${mdEscape(session.category)}* — buyers, most recent first (page ${p + 1}/${pages}, ${buyers.length})`, rows);
}

async function showCard(bot, chatId, userId, contactId) {
  const session = sessionStore.get(userId);
  const graph = await contactGraph.loadGraph();
  const node = graph.nodes.get(contactId);
  if (!node) {
    await render(bot, chatId, userId, '⚠️ Contact not found (it may have been deactivated).',
      [navRow([{ text: '◀ Back', callback_data: `${NS}bk` }])]);
    return;
  }
  const phone = await contactGraph.livePhoneOf(node);
  const subs = contactGraph.subordinatesOf(graph, contactId);
  const sups = contactGraph.superiorsOf(graph, contactId);
  session.current = contactId;
  session._people = subs.map((s) => s.contact_id);
  session._sups = sups.map((s) => s.contact_id);
  sessionStore.set(userId, session);

  let text = `👤 *${mdEscape(node.name)}*`;
  if (node.type && node.type !== 'other') text += `  _(${node.type})_`;
  text += '\n';
  text += phone ? `📞 ${phone}\n` : '📞 _no number on file_\n';
  if (node.whatsapp && node.whatsapp !== phone) text += `💬 ${node.whatsapp}\n`;
  if (node.notes) text += `📝 ${mdEscape(node.notes)}\n`;
  if (sups.length) text += `⬆ Works for: ${sups.map((s) => mdEscape(s.name)).join(', ')}\n`;
  text += subs.length ? `\n*People under ${mdEscape(node.name)}:*` : '\n_No people recorded under them yet._';

  const rows = [];
  const actions = [];
  if (phone) actions.push({ text: '👤 Contact card', callback_data: `${NS}vc` });
  const e164 = phoneUtil.normalizePhone(phone).e164;
  if (e164) actions.push({ text: '💬 WhatsApp', url: `https://wa.me/${e164.slice(1)}` });
  if (actions.length) rows.push(actions);
  rows.push(...chunk(subs.map((s, i) => ({ text: `👥 ${s.name}`, callback_data: `${NS}p:${i}` })), 2));
  const util = [{ text: `➕ Add person`, callback_data: `${NS}add` }, { text: '✏️ Update details', callback_data: `${NS}ed` }];
  if (sups.length) util.push({ text: '⬆ Works for', callback_data: `${NS}up` });
  // Audit fix 17-Jul: links could be created but never removed. Unlink is
  // admin-direct (locked decision 3: edits admin-only, audit-logged).
  if (subs.length && auth.isAdmin(userId)) util.push({ text: '🗑 Unlink', callback_data: `${NS}rm` });
  rows.push(util);
  rows.push(navRow([{ text: '◀ Back', callback_data: `${NS}bk` }]));
  await render(bot, chatId, userId, text, rows);
}

async function showAddConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const d = session._addDraft;
  const dupeLine = d.existing_contact_id ? `\n🔗 Linking EXISTING contact (number already on file).` : '';
  await render(bot, chatId, userId,
    `➕ *Add person under ${mdEscape(d.boss_name)}*\n\n👤 ${mdEscape(d.name)}\n📞 ${d.phone || '_none_'}\n📝 ${mdEscape(d.notes || '—')}${dupeLine}\n\nAn admin will approve before it appears.`,
    [[{ text: '✅ Submit', callback_data: `${NS}ok` }, { text: '❌ Cancel', callback_data: `${NS}cancel` }]]);
}

/* ── entry ── */

async function start(bot, chatId, userId, messageId) {
  sessionStore.set(userId, { type: SESSION_TYPE, step: 'browse', flowMessageId: messageId, _stack: [], startedAt: Date.now() });
  await showCategories(bot, chatId, userId);
}

/* ── callbacks ── */

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith(NS)) return false;
  const chatId = callbackQuery.message.chat.id;
  const userId = String(callbackQuery.from.id);
  const session = sessionStore.get(userId);
  await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
  if (!session || session.type !== SESSION_TYPE) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'This card expired. Open 📇 Contact Network again.', show_alert: true }).catch(() => {});
    return true;
  }
  const rest = data.slice(NS.length);

  if (rest === 'cats') { session.step = 'browse'; sessionStore.set(userId, session); await showCategories(bot, chatId, userId); return true; }
  if (rest.startsWith('c:')) {
    const cat = (session._cats || [])[Number(rest.slice(2))];
    if (cat === undefined) return true;
    session.category = cat; sessionStore.set(userId, session);
    await showBuyers(bot, chatId, userId, 0); return true;
  }
  if (rest.startsWith('bp:')) { await showBuyers(bot, chatId, userId, Number(rest.slice(3))); return true; }
  if (rest.startsWith('b:')) {
    const buyer = (session._buyers || [])[Number(rest.slice(2))];
    if (!buyer) return true;
    const node = await contactGraph.ensureNodeForCustomer(buyer.name, userId);
    contactsRepository.invalidateCache();
    session._stack = []; sessionStore.set(userId, session);
    await showCard(bot, chatId, userId, node.contact_id); return true;
  }
  if (rest.startsWith('p:')) {
    const target = (session._people || [])[Number(rest.slice(2))];
    if (!target) return true;
    session._stack.push(session.current); sessionStore.set(userId, session);
    await showCard(bot, chatId, userId, target); return true;
  }
  if (rest === 'up') {
    const target = (session._sups || [])[0];
    if (!target) return true;
    session._stack.push(session.current); sessionStore.set(userId, session);
    await showCard(bot, chatId, userId, target); return true;
  }
  if (rest === 'bk') {
    const prev = (session._stack || []).pop();
    sessionStore.set(userId, session);
    if (prev) { await showCard(bot, chatId, userId, prev); return true; }
    if (session.category) { await showBuyers(bot, chatId, userId, session._page || 0); return true; }
    await showCategories(bot, chatId, userId); return true;
  }
  if (rest === 'vc') {
    const graph = await contactGraph.loadGraph();
    const node = graph.nodes.get(session.current);
    const phone = node ? await contactGraph.livePhoneOf(node) : '';
    if (node && phone && typeof bot.sendContact === 'function') {
      await Promise.resolve(bot.sendContact(chatId, phone, node.name))
        .catch((e) => logger.warn(`cn sendContact: ${e.message}`));
    }
    return true;
  }
  // Audit fix 17-Jul — admin-only: deactivate a subordinate link (the
  // person stays in Contacts; only the edge is retired, audit-logged).
  if (rest === 'rm' || rest.startsWith('rmx:')) {
    if (!auth.isAdmin(userId)) return true;
    const contactLinksRepository = require('../repositories/contactLinksRepository');
    if (rest === 'rm') {
      const graph = await contactGraph.loadGraph();
      const subs = contactGraph.subordinatesOf(graph, session.current);
      session._people = subs.map((s) => s.contact_id);
      sessionStore.set(userId, session);
      await render(bot, chatId, userId, '🗑 *Unlink which person?* (removes only the link — the contact remains)',
        [...chunk(subs.map((s, i) => ({ text: `❌ ${s.name}`, callback_data: `${NS}rmx:${i}` })), 2),
          [{ text: '◀ Back', callback_data: `${NS}bk` }]]);
      session._stack.push(session.current); sessionStore.set(userId, session);
      return true;
    }
    const targetId = (session._people || [])[Number(rest.slice(4))];
    if (!targetId) return true;
    const link = (await contactLinksRepository.getActive())
      .find((l) => l.from_contact_id === targetId && l.to_contact_id === session.current && l.relation === 'subordinate_of');
    if (link) {
      await contactLinksRepository.deactivate(link.link_id);
      await auditLogRepository.append('contact_link_removed', { link_id: link.link_id, from: targetId, to: session.current }, userId);
    }
    (session._stack || []).pop(); // undo the rm screen's breadcrumb push
    sessionStore.set(userId, session);
    await showCard(bot, chatId, userId, session.current);
    return true;
  }
  // CNET-1b.1 — staff propose an edit on the current card; admin approves.
  if (rest === 'ed') {
    const graph = await contactGraph.loadGraph();
    const node = graph.nodes.get(session.current);
    if (!node) return true;
    session.step = 'edit_pick';
    session._editDraft = { contact_id: node.contact_id, name: node.name, customer_id: node.customer_id || '' };
    sessionStore.set(userId, session);
    await render(bot, chatId, userId, `✏️ *Update ${mdEscape(node.name)}* — what do you want to fill in or correct?`,
      [
        [{ text: '📞 Phone', callback_data: `${NS}ef:phone` }, { text: '💬 WhatsApp', callback_data: `${NS}ef:whatsapp` }],
        [{ text: '🏠 Address', callback_data: `${NS}ef:address` }, { text: '📝 Note', callback_data: `${NS}ef:notes` }],
        [{ text: '❌ Cancel', callback_data: `${NS}cancel` }],
      ]);
    return true;
  }
  if (rest.startsWith('ef:')) {
    const field = rest.slice(3);
    if (!['phone', 'whatsapp', 'address', 'notes'].includes(field) || !session._editDraft) return true;
    session._editDraft.field = field;
    session.step = 'edit_value';
    sessionStore.set(userId, session);
    const label = { phone: 'phone number', whatsapp: 'WhatsApp number', address: 'address', notes: 'note' }[field];
    await render(bot, chatId, userId, `✏️ Type the new *${label}* for *${mdEscape(session._editDraft.name)}*:`,
      [[{ text: '❌ Cancel', callback_data: `${NS}cancel` }]]);
    return true;
  }
  if (rest === 'edok') {
    const d = session._editDraft;
    // Step guard (audit 16-Jul): edok is only valid on the confirm screen —
    // without this, tapping ef:<field> then edok directly would queue a
    // blank-value "clear" that an admin might approve unread.
    if (!d || !d.field || session.step !== 'edit_confirm') return true;
    const requestId = idGenerator.requestId();
    const actionJSON = {
      action: 'update_contact_info',
      contact_id: d.contact_id, name: d.name, customer_id: d.customer_id || '',
      field: d.field, old_value: d.old_value || '', new_value: d.new_value || '',
    };
    await approvalQueueRepository.append({
      requestId, user: userId, actionJSON,
      riskReason: 'Contact detail changes are reviewed by an admin.', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, action: 'update_contact_info', contact: d.name, field: d.field }, userId);
    try {
      const approvalEvents = require('../events/approvalEvents');
      const approvalCards = require('../services/approvalCards');
      // APU-1: show the approver WHAT is being overwritten (old → new),
      // the contact's id (two same-name contacts are distinguishable),
      // and the requester's display name. Card reason = queue-row reason.
      const card = `Contact Update Request\nContact: ${d.name}${d.contact_id ? ` (${d.contact_id})` : ''}`
        + `\nField: ${d.field}\nCurrent value: ${d.old_value || '(empty)'}\nNew value: ${d.new_value || '(cleared)'}`;
      await approvalEvents.notifyAdminsApprovalRequest(bot, requestId,
        await approvalCards.resolveUserLabel(userId), card,
        'Contact detail changes are reviewed by an admin.', userId);
    } catch (e) { logger.warn(`cn edit approval cards: ${e.message}`); }
    session.step = 'browse'; delete session._editDraft; sessionStore.set(userId, session);
    await render(bot, chatId, userId,
      `✅ Update submitted for admin approval.\n\n👤 *${mdEscape(d.name)}* — ${d.field}\nNew value: ${mdEscape(d.new_value || '(cleared)')}\nRequest: \`${requestId}\``,
      [navRow([{ text: '◀ Back to card', callback_data: `${NS}bk` }])]);
    session._stack.push(session.current); sessionStore.set(userId, session);
    return true;
  }
  if (rest === 'add') {
    const graph = await contactGraph.loadGraph();
    const boss = graph.nodes.get(session.current);
    if (!boss) return true;
    session.step = 'add_name';
    session._addDraft = { boss_contact_id: boss.contact_id, boss_name: boss.name };
    sessionStore.set(userId, session);
    await render(bot, chatId, userId, `➕ *Add person under ${mdEscape(boss.name)}*\n\nType the person's *name*:`,
      [[{ text: '❌ Cancel', callback_data: `${NS}cancel` }]]);
    return true;
  }
  if (rest === 'dupe') {
    const d = session._addDraft || {};
    if (d._dupeId) { d.existing_contact_id = d._dupeId; d.name = d._dupeName; session.step = 'add_note'; sessionStore.set(userId, session); await promptNote(bot, chatId, userId); }
    return true;
  }
  if (rest === 'rephone') {
    session.step = 'add_phone'; sessionStore.set(userId, session);
    await render(bot, chatId, userId, `📞 Type *${mdEscape((session._addDraft || {}).name || '')}*'s phone number:`,
      [[{ text: '⏭ Skip phone', callback_data: `${NS}skipphone` }, { text: '❌ Cancel', callback_data: `${NS}cancel` }]]);
    return true;
  }
  if (rest === 'skipphone') { session._addDraft.phone = ''; session.step = 'add_note'; sessionStore.set(userId, session); await promptNote(bot, chatId, userId); return true; }
  if (rest === 'skipnote') { session._addDraft.notes = ''; session.step = 'confirm'; sessionStore.set(userId, session); await showAddConfirm(bot, chatId, userId); return true; }
  if (rest === 'cancel') { session.step = 'browse'; delete session._addDraft; delete session._editDraft; sessionStore.set(userId, session); await showCard(bot, chatId, userId, session.current); return true; }
  if (rest === 'ok') {
    const d = session._addDraft;
    // Step guard (audit 16-Jul): submissions only from the confirm screen,
    // never from a half-built draft.
    if (!d || session.step !== 'confirm' || !d.name) return true;
    const requestId = idGenerator.requestId();
    const actionJSON = {
      action: 'add_contact_link',
      boss_contact_id: d.boss_contact_id, boss_name: d.boss_name,
      name: d.name, phone: d.phone || '', notes: d.notes || '',
      existing_contact_id: d.existing_contact_id || '',
    };
    await approvalQueueRepository.append({
      requestId, user: userId, actionJSON,
      riskReason: 'Contact-network changes are reviewed by an admin.', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, action: 'add_contact_link', boss: d.boss_name, person: d.name }, userId);
    try {
      const approvalEvents = require('../events/approvalEvents');
      const approvalCards = require('../services/approvalCards');
      // APU-1: the queued phone/notes were previously approved sight-unseen.
      const card = `Contact Link Request\nPerson: ${d.name}${d.existing_contact_id ? ` (existing contact ${d.existing_contact_id})` : ' (new contact)'}`
        + `\nUnder: ${d.boss_name}`
        + `\nPhone: ${d.phone || '—'}`
        + (d.notes ? `\nNote: ${d.notes}` : '');
      await approvalEvents.notifyAdminsApprovalRequest(bot, requestId,
        await approvalCards.resolveUserLabel(userId), card,
        'Contact-network changes are reviewed by an admin.', userId);
    } catch (e) { logger.warn(`cn approval cards: ${e.message}`); }
    session.step = 'browse'; delete session._addDraft; sessionStore.set(userId, session);
    await render(bot, chatId, userId,
      `✅ Submitted for approval.\n\n👤 ${mdEscape(d.name)} → under *${mdEscape(d.boss_name)}*\nRequest: \`${requestId}\``,
      [navRow([{ text: '◀ Back to card', callback_data: `${NS}bk` }])]);
    session._stack.push(session.current); sessionStore.set(userId, session);
    return true;
  }
  return true;
}

async function promptNote(bot, chatId, userId) {
  const d = sessionStore.get(userId)._addDraft || {};
  await render(bot, chatId, userId, `📝 Role note for *${mdEscape(d.name || '')}* (e.g. "receives goods", "accountant") — or skip:`,
    [[{ text: '⏭ Skip', callback_data: `${NS}skipnote` }, { text: '❌ Cancel', callback_data: `${NS}cancel` }]]);
}

/* ── typed steps ── */

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;
  const text = (msg.text || '').trim();
  if (!text) return false;

  if (session.step === 'add_name') {
    session._addDraft.name = text.slice(0, 60);
    session.step = 'add_phone';
    sessionStore.set(userId, session);
    await render(bot, chatId, userId, `📞 Type *${mdEscape(session._addDraft.name)}*'s phone number:`,
      [[{ text: '⏭ Skip phone', callback_data: `${NS}skipphone` }, { text: '❌ Cancel', callback_data: `${NS}cancel` }]]);
    return true;
  }
  if (session.step === 'add_phone') {
    const r = phoneUtil.normalizePhone(text);
    if (!r.ok) {
      await render(bot, chatId, userId, `⚠️ That doesn't look like a phone number (${r.reason}). Try again:`,
        [[{ text: '⏭ Skip phone', callback_data: `${NS}skipphone` }, { text: '❌ Cancel', callback_data: `${NS}cancel` }]]);
      return true;
    }
    session._addDraft.phone = r.value;
    const dupe = await contactsRepository.findByPhone(r.value);
    if (dupe && dupe.contact_id !== session._addDraft.boss_contact_id) {
      session._addDraft._dupeId = dupe.contact_id;
      session._addDraft._dupeName = dupe.name;
      sessionStore.set(userId, session);
      await render(bot, chatId, userId,
        `⚠️ This number already belongs to *${mdEscape(dupe.name)}*.\n\nLink the existing person instead of creating a duplicate?`,
        [[{ text: `🔗 Link ${dupe.name}`, callback_data: `${NS}dupe` }, { text: '✏️ Re-enter number', callback_data: `${NS}rephone` }]]);
      return true;
    }
    session.step = 'add_note';
    sessionStore.set(userId, session);
    await promptNote(bot, chatId, userId);
    return true;
  }
  if (session.step === 'add_note') {
    session._addDraft.notes = text.slice(0, 120);
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await showAddConfirm(bot, chatId, userId);
    return true;
  }
  if (session.step === 'edit_value') {
    const d = session._editDraft;
    if (!d) return false;
    let value = text.slice(0, d.field === 'notes' ? 120 : 60);
    if (d.field === 'phone' || d.field === 'whatsapp') {
      const r = phoneUtil.normalizePhone(text);
      if (!r.ok) {
        await render(bot, chatId, userId, `⚠️ That doesn't look like a phone number (${r.reason}). Try again:`,
          [[{ text: '❌ Cancel', callback_data: `${NS}cancel` }]]);
        return true;
      }
      value = r.value;
    }
    const graph = await contactGraph.loadGraph();
    const node = graph.nodes.get(d.contact_id);
    d.old_value = node ? (d.field === 'phone' ? await contactGraph.livePhoneOf(node) : node[d.field] || '') : '';
    d.new_value = value;
    session.step = 'edit_confirm';
    sessionStore.set(userId, session);
    await render(bot, chatId, userId,
      `✏️ *${mdEscape(d.name)}* — ${d.field}\n\nOld: ${mdEscape(d.old_value || '(empty)')}\nNew: *${mdEscape(d.new_value)}*\n\nAn admin will approve before it changes.`,
      [[{ text: '✅ Submit', callback_data: `${NS}edok` }, { text: '❌ Cancel', callback_data: `${NS}cancel` }]]);
    return true;
  }
  return false;
}

module.exports = { SESSION_TYPE, start, handleCallback, handleText };
