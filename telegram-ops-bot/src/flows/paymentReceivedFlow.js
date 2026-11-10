'use strict';

/**
 * PRC-1 — 💰 Finance → 💵 Payment Received.
 *
 * A customer pays against what they owe. Until 01-Nov-2026 the only way to
 * record that was a typed sentence the AI read ("Record payment 50000 from
 * Ibrahim via bank"); TXT-1 switched the AI off for anything that changes
 * the sheet, and the owner ruled that the typed line waits for a tap door.
 * This is that door (APG-1 phase 3, owner's go 11-Nov-2026).
 *
 *   1. who paid     tap a customer (A–Z, eight a page) or type part of a name
 *   2. how much     type the amount
 *   3. paid how     💵 Cash · 🏦 one chip per bank in Settings BANK_LIST
 *   4. confirm      ✅ Submit for approval
 *
 * It raises the SAME `record_payment` request the typed line raised — same
 * action code, same executor (crmService.recordPayment), same approval
 * (ALWAYS_APPROVAL_ACTIONS) — through approvalGate.raise. A bank chip stores
 * `Bank — <name>`, so the money lands in the Bank ledger: the typed line
 * sent any wording without the word "bank" to Cash.
 *
 * No balance is shown to the person entering the payment (FIN-V2: customer
 * outstanding is admins-only). The admin's approval card carries it.
 *
 * Callback namespace `prc:` — pg:<n> · c:<i> · m:<i> · submit · back · cancel · noop.
 */

const sessionStore = require('../utils/sessionStore');
const { mdEscape, rowsFor, beginSubmit, endSubmit } = require('../utils/flowKit');
const customersRepository = require('../repositories/customersRepository');
const settingsRepository = require('../repositories/settingsRepository');
const approvalCards = require('../services/approvalCards');
const riskEvaluate = require('../risk/evaluate');
const idGenerator = require('../utils/idGenerator');
const money = require('../utils/money');
const fmtDate = require('../utils/formatDate');
const { todayInLagos } = require('../utils/dates');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');

const SESSION_TYPE = 'payment_received_flow';
const NS = 'prc';
const PAGE_SIZE = 8;
const HIDDEN = new Set(['merged', 'rejected', 'inactive', 'pending']);
const MAX_AMOUNT = 1e10;
const { cancelRow } = rowsFor(NS);
const TITLE = '💵 *Payment received*';

async function render(bot, chatId, userId, text, rows) {
  const session = sessionStore.get(userId);
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (session && session.flowMessageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: session.flowMessageId, ...opts });
      return;
    } catch (e) {
      if (/message is not modified/i.test(String(e && e.message))) return;
    }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  const s = sessionStore.get(userId);
  if (s && sent && sent.message_id) { s.flowMessageId = sent.message_id; sessionStore.set(userId, s); }
}

async function customers(query = '') {
  const all = await customersRepository.getAll();
  const q = String(query || '').trim().toLowerCase();
  return all
    .filter((c) => c.customer_id && c.name)
    .filter((c) => !HIDDEN.has(String(c.status || 'Active').trim().toLowerCase()))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.phone || '').includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/**
 * "50,000" · "50000" · "50k" · "1.5m" → a number, or null. Pure.
 * A typed naira sign (U+20A6) is tolerated on the way IN; nothing on this
 * side of the business ever prints one (CUR-1: sale figures are bare).
 */
function parseAmount(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[\u20a6,\s]/g, '');
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
  return Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT ? Math.round(n * 100) / 100 : null;
}

async function bankList() {
  try {
    const all = (await settingsRepository.getAll()) || {};
    return String(all.BANK_LIST || '').split(',').map((b) => b.trim()).filter(Boolean).slice(0, 12);
  } catch (_) { return []; }
}

async function start(bot, chatId, userId, messageId = null) {
  sessionStore.set(String(userId), {
    type: SESSION_TYPE, step: 'pick', flowMessageId: messageId || null,
    page: 0, query: '', customer: null, amount: null, method: '',
  });
  await renderPick(bot, chatId, String(userId));
}

async function renderPick(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let list = [];
  let unreadable = false;
  try { list = await customers(session.query); } catch (e) {
    unreadable = true;
    logger.warn(`paymentReceivedFlow: customers read failed: ${e.message}`);
  }
  const rows = [];
  if (!list.length) {
    session.step = 'pick'; session._pick = []; sessionStore.set(userId, session);
    rows.push(cancelRow());
    const why = unreadable ? 'The customer list could not be read just now. Try again in a moment.'
      : session.query ? `No customer matches "${mdEscape(session.query)}". Type another name.`
        : 'There is no customer on the list yet.';
    await render(bot, chatId, userId, `${TITLE}\n\n_${why}_`, rows);
    return;
  }
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, session.page || 0), pages - 1);
  const slice = list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  session.step = 'pick';
  session.page = page;
  session._pick = slice.map((c) => ({ id: c.customer_id, name: c.name }));
  sessionStore.set(userId, session);
  slice.forEach((c, i) => rows.push([{ text: `👤 ${c.name}`.slice(0, 60), callback_data: `${NS}:c:${i}` }]));
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀ Back', callback_data: `${NS}:pg:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: `${NS}:noop` });
    if (page < pages - 1) nav.push({ text: 'Next ▶', callback_data: `${NS}:pg:${page + 1}` });
    rows.push(nav);
  }
  rows.push(cancelRow());
  const filter = session.query ? `\n🔎 _${mdEscape(session.query)}_ · ${list.length} match${list.length === 1 ? '' : 'es'}` : '';
  await render(bot, chatId, userId,
    `${TITLE}\n\nWho paid?\nTap the customer, or type part of the name.${filter}`, rows);
}

async function renderAmount(bot, chatId, userId, note = '') {
  const session = sessionStore.get(userId);
  if (!session || !session.customer) return;
  session.step = 'amount'; sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `${TITLE}\n\nCustomer: *${mdEscape(session.customer.name)}*\n\nHow much did they pay?\nType the amount, for example \`50000\`.${note ? `\n\n${note}` : ''}`,
    [[{ text: '⬅ Back', callback_data: `${NS}:back` }, ...cancelRow()]]);
}

async function renderMethod(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.customer || !session.amount) return;
  const banks = await bankList();
  session.step = 'method';
  session._methods = ['Cash', ...banks.map((b) => `Bank — ${b}`)];
  sessionStore.set(userId, session);
  const rows = [[{ text: '💵 Cash', callback_data: `${NS}:m:0` }]];
  banks.forEach((b, i) => rows.push([{ text: `🏦 ${b}`.slice(0, 60), callback_data: `${NS}:m:${i + 1}` }]));
  rows.push([{ text: '⬅ Back', callback_data: `${NS}:back` }, ...cancelRow()]);
  await render(bot, chatId, userId,
    `${TITLE}\n\nCustomer: *${mdEscape(session.customer.name)}*\nAmount: *${money.sale(session.amount)}*\n\nHow was it paid?`, rows);
}

function summaryLines(session) {
  return [
    `Customer: *${mdEscape(session.customer.name)}*`,
    `Amount: *${money.sale(session.amount)}*`,
    `Paid by: ${mdEscape(session.method)}`,
    `Date: ${fmtDate(todayInLagos())}`,
  ].join('\n');
}

async function renderConfirm(bot, chatId, userId, note = '') {
  const session = sessionStore.get(userId);
  if (!session || !session.customer || !session.amount || !session.method) return;
  session.step = 'confirm';
  // One id per confirm cycle: a retry of this Submit is the same request.
  if (!session.requestId) session.requestId = idGenerator.requestId();
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `${TITLE}\n\n${summaryLines(session)}\n\nAn admin approves it before the customer's balance moves.${note ? `\n\n${note}` : ''}`,
    [[{ text: '✅ Submit for approval', callback_data: `${NS}:submit` }],
      [{ text: '⬅ Back', callback_data: `${NS}:back` }, ...cancelRow()]]);
}

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.step !== 'confirm' || !session.requestId) return;
  if (!beginSubmit(session, userId)) return;
  const payload = {
    customer: session.customer.name, customerId: session.customer.id,
    amount: session.amount, method: session.method, source: 'payment_received_door',
  };
  try {
    const risk = await riskEvaluate.evaluate({ action: 'record_payment', userId });
    const gate = require('../services/approvalGate');
    const raised = await gate.raise({
      requestId: session.requestId, userId, action: 'record_payment', payload,
      riskReason: risk.reason || 'Admin approval required',
      auditMeta: { reason: 'record_payment', via: 'payment_received_door', amount: session.amount },
    });
    const requestId = raised.requestId;
    let sent = 1;
    if (raised.created) {
      const card = await approvalCards.buildPaymentCard({ customer: payload.customer, amount: payload.amount, method: payload.method });
      const label = await approvalCards.resolveUserLabel(userId, bot);
      const res = await require('../events/approvalEvents').notifyAdminsApprovalRequest(
        bot, requestId, label, card, risk.reason || 'Admin approval required', auth.isAdmin(userId) ? userId : undefined);
      sent = (res && res.sent) || 0;
    }
    const warn = sent === 0 ? '\n\n⚠️ The admins could not be notified just now. Ask an admin to open 🛂 Approvals.' : '';
    await render(bot, chatId, userId,
      `⏳ *Sent for approval*\n\n${summaryLines(session)}\nRef ${approvalCards.shortRequestRef(requestId)}${warn}`,
      [gate.receiptRow(requestId), [{ text: '💵 Record another', callback_data: 'act:payment_received' }, { text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    sessionStore.clear(userId);
  } catch (e) {
    logger.error(`paymentReceivedFlow.submit failed: ${e.message}`);
    endSubmit(session, userId);
    await renderConfirm(bot, chatId, userId, `⚠️ Could not send: ${mdEscape(e.message)}. Tap Submit again.`);
  }
}

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
  if (session.step === 'amount') {
    const amount = parseAmount(text);
    if (!amount) {
      await renderAmount(bot, chatId, userId, '⚠️ That is not an amount. Type digits only, for example `50000`.');
      return true;
    }
    session.amount = amount; sessionStore.set(userId, session);
    await renderMethod(bot, chatId, userId);
    return true;
  }
  return false;
}

async function handleCallback(bot, query) {
  const data = String(query.data || '');
  if (!data.startsWith(`${NS}:`)) return false;
  const userId = String(query.from.id);
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const rest = data.slice(NS.length + 1);
  const answer = (text) => bot.answerCallbackQuery(query.id, text ? { text } : undefined).catch(() => {});
  if (rest === 'noop') { await answer(); return true; }
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    await answer('This card has expired. Open 💵 Payment Received again.');
    return true;
  }
  await answer();
  if (rest === 'cancel') {
    sessionStore.clear(userId);
    await require('../utils/telegramUI').editOrSend(bot, chatId, session.flowMessageId,
      '❌ Payment entry cancelled. Nothing was recorded.',
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]] } });
    return true;
  }
  if (rest.startsWith('pg:')) {
    session.page = parseInt(rest.slice(3), 10) || 0; sessionStore.set(userId, session);
    await renderPick(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('c:') && session.step === 'pick') {
    const pick = (session._pick || [])[parseInt(rest.slice(2), 10)];
    if (!pick) { await renderPick(bot, chatId, userId); return true; }
    session.customer = pick; session.requestId = null; sessionStore.set(userId, session);
    await renderAmount(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('m:') && session.step === 'method') {
    const method = (session._methods || [])[parseInt(rest.slice(2), 10)];
    if (!method) { await renderMethod(bot, chatId, userId); return true; }
    session.method = method; session.requestId = null; sessionStore.set(userId, session);
    await renderConfirm(bot, chatId, userId);
    return true;
  }
  if (rest === 'back') {
    if (session.step === 'confirm') { await renderMethod(bot, chatId, userId); return true; }
    if (session.step === 'method') { await renderAmount(bot, chatId, userId); return true; }
    session.customer = null; sessionStore.set(userId, session);
    await renderPick(bot, chatId, userId);
    return true;
  }
  if (rest === 'submit') { await submit(bot, chatId, userId); return true; }
  return true;
}

module.exports = { SESSION_TYPE, NS, start, handleCallback, handleText, _internals: { parseAmount } };
