'use strict';

/**
 * SLED-1 — 📄 Supply Statement (specless owner confirmation, 31-Jul-2026):
 * pick a customer → pick a period → receive the PDF supply statement
 * (quantities only; Rate/Amount printed as blank ruled lines).
 *
 * Admin-only: the statement is a customer-facing handover document and
 * quantities are commercially sensitive.
 *
 * Session shape (`type: 'supply_statement_flow'`):
 *   { step: 'customer'|'period', flowMessageId, page, _cust: [{id,name}], customer }
 *
 * Callback namespace `sst:*`:
 *   sst:c:<i>   pick customer   sst:pg:<n>  page customers
 *   sst:p:<k>   pick period (m30/m90/all/month)
 *   sst:x       cancel
 */

const sessionStore = require('../utils/sessionStore');
const { todayInLagos, lagosDayPlus } = require('../utils/dates');
const fmtDate = require('../utils/formatDate');
const { makeRenderer, chunk, mdEscape } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const supplyStatementService = require('../services/supplyStatementService');
const config = require('../config');
const logger = require('../utils/logger');

const SESSION_TYPE = 'supply_statement_flow';
const PER_PAGE = 8;

const render = makeRenderer({ disablePreview: true });

function menuRow() { return [{ text: '🏠 Menu', callback_data: 'act:__back__' }]; }

const PERIODS = {
  month: { label: 'This month', fromDate: () => `${todayInLagos().slice(0, 7)}-01` },  // TIME-1
  m30: { label: 'Last 30 days', fromDate: () => lagosDayPlus(-30) },  // TIME-1
  m90: { label: 'Last 90 days', fromDate: () => lagosDayPlus(-90) },  // TIME-1
  all: { label: 'All time', fromDate: () => '' },
};

async function showCustomerPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;
  const cust = session._cust || [];
  const pages = Math.max(1, Math.ceil(cust.length / PER_PAGE));
  const page = Math.min(Math.max(session.page || 0, 0), pages - 1);
  session.page = page;
  sessionStore.set(userId, session);

  const chips = cust.slice(page * PER_PAGE, (page + 1) * PER_PAGE)
    .map((c, i) => ({ text: c.name, callback_data: `sst:c:${page * PER_PAGE + i}` }));
  const rows = chunk(chips, 2);
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `sst:pg:${page - 1}` });
  if (page < pages - 1) nav.push({ text: 'Next ➡️', callback_data: `sst:pg:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '❌ Cancel', callback_data: 'sst:x' }]);
  rows.push(menuRow());
  await render(bot, chatId, userId,
    '📄 *Supply Statement*\n\nWhose supplies? Pick the customer:'
    + (cust.length ? '' : '\n\n🛈 No customers on file.'),
    rows);
}

async function showPeriodPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return;
  session.step = 'period';
  sessionStore.set(userId, session);
  const rows = [
    [{ text: '📅 This month', callback_data: 'sst:p:month' }, { text: '📅 Last 30 days', callback_data: 'sst:p:m30' }],
    [{ text: '📅 Last 90 days', callback_data: 'sst:p:m90' }, { text: '🗓 All time', callback_data: 'sst:p:all' }],
    [{ text: '❌ Cancel', callback_data: 'sst:x' }],
    menuRow(),
  ];
  await render(bot, chatId, userId,
    `📄 *Supply Statement — ${mdEscape(session.customer.name)}*\n\nWhich period?`, rows);
}

async function sendStatement(bot, chatId, userId, periodKey) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || !session.customer) return;
  const period = PERIODS[periodKey] || PERIODS.all;
  const customer = session.customer;
  // SJ-4 — capture the anchor before the session goes so the period card
  // can be sealed instead of dangling with live-looking buttons.
  const anchorId = session.flowMessageId || null;
  sessionStore.clear(userId);
  try {
    const customerEntity = require('../services/customerEntity');
    const resolved = await customerEntity.resolve({ id: customer.id, name: customer.name });
    const names = resolved ? customerEntity.namesFor(resolved) : [customer.name];
    const all = await inventoryRepository.getAll();
    const fromDate = period.fromDate();
    const { lines, totals } = supplyStatementService.buildStatement(all, names, { fromDate });
    const periodLabel = fromDate
      ? `${fmtDate(fromDate)} to ${fmtDate(todayInLagos())}`  // TIME-1 — Lagos day, house format
      : 'All time';
    const pdf = await supplyStatementService.renderPdf({
      customerName: (resolved && resolved.name) || customer.name,
      periodLabel, lines, totals,
    });
    const fname = `supply-statement-${String(customer.name).replace(/[^A-Za-z0-9]+/g, '_')}.pdf`;
    await bot.sendDocument(chatId, pdf, {
      caption: `📄 Supply statement — ${customer.name} · ${period.label}\n${totals.bales} bales · ${totals.thans} thans · ${totals.yards} yds (net as of today). Rate & amount columns left blank.`,
    }, { filename: fname, contentType: 'application/pdf' });
    // SJ-4 — seal the period card; the PDF below is the deliverable.
    if (anchorId) {
      try {
        await bot.editMessageText(`📄 Statement sent — ${customer.name} · ${period.label}`, {
          chat_id: chatId, message_id: anchorId,
          reply_markup: { inline_keyboard: [menuRow()] },
        });
      } catch (_) { /* card gone — nothing to seal */ }
    }
  } catch (e) {
    logger.error(`supplyStatementFlow: render/send failed: ${e.message}`);
    // SJ-4 — put the error on the anchor instead of a stray extra message.
    const errText = '⚠️ Could not build the statement just now — try again in a moment.';
    let onAnchor = false;
    if (anchorId) {
      try {
        await bot.editMessageText(errText, {
          chat_id: chatId, message_id: anchorId,
          reply_markup: { inline_keyboard: [menuRow()] },
        });
        onAnchor = true;
      } catch (_) { /* fall through */ }
    }
    if (!onAnchor) {
      try { await bot.sendMessage(chatId, errText); } catch (_) { /* ignore */ }
    }
  }
}

/** Entry — CRM tile (admin-only). */
async function start(bot, chatId, userId, messageId) {
  if (!config.access.adminIds.includes(String(userId))) {
    await bot.sendMessage(chatId, '📄 Supply Statement is admin-only.');
    return;
  }
  const customerEntity = require('../services/customerEntity');
  const active = await customerEntity.activeList();
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'customer',
    flowMessageId: messageId || null,
    page: 0,
    _cust: active.filter((c) => c.name).sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ id: c.customer_id || '', name: c.name })),
    startedAt: new Date().toISOString(),
  });
  await showCustomerPicker(bot, chatId, userId);
}

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('sst:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);

  try { await bot.answerCallbackQuery(query.id); } catch { /* ignore */ }

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    try {
      await bot.editMessageText('This card has expired — open 📄 Supply Statement again.',
        { chat_id: chatId, message_id: query.message?.message_id, reply_markup: { inline_keyboard: [menuRow()] } });
    } catch { /* ignore */ }
    return true;
  }

  if (data === 'sst:x') {
    sessionStore.clear(userId);
    try {
      await bot.editMessageText('✅ Closed.', {
        chat_id: chatId, message_id: session.flowMessageId || query.message?.message_id,
        reply_markup: { inline_keyboard: [menuRow()] },
      });
    } catch { /* ignore */ }
    return true;
  }

  if (data.startsWith('sst:pg:')) {
    session.page = parseInt(data.slice('sst:pg:'.length), 10) || 0;
    sessionStore.set(userId, session);
    await showCustomerPicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sst:c:')) {
    const customer = (session._cust || [])[parseInt(data.slice('sst:c:'.length), 10)];
    if (!customer) { await showCustomerPicker(bot, chatId, userId); return true; }
    session.customer = customer;
    sessionStore.set(userId, session);
    await showPeriodPicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('sst:p:')) {
    await sendStatement(bot, chatId, userId, data.slice('sst:p:'.length));
    return true;
  }

  return true;
}

module.exports = { start, handleCallback, _internals: { SESSION_TYPE, PERIODS } };
