/**
 * RPT-2 — 📈 Sales Browser (owner design, 21-Jul-2026). Admin-only.
 *
 * Date-wise, tap-first browsing of business already done:
 *   Screen 1  tabs 💰 Sales | 📦 Supplies → day chips with mini-summaries
 *             (+ 📆 month calendar up to 90 days back)
 *   Screen 2  the day's list — ONE tappable row per sale/supply, short
 *             summary (customer · bales · yds · ₦ · ⚠️BD marker)
 *   Screen 3  full detail: per-bale lines, rate, amount, receiving
 *             account, backdated stamp, approver, invoice number + link
 *
 * Read-only; everything derived at tap time from the raw sheets
 * (Transactions grouped by SaleRefId, ApprovalQueue for supplies and
 * approver info, Invoices for the number + live link). Nothing persisted.
 *
 * Callback namespace `sbr:` — tab:<t>, day:<iso>, cal:<YYYY-MM>,
 * itm:<idx>, back, close. Item taps index into session._items (64-byte
 * safe).
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const transactionsRepository = require('../repositories/transactionsRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const config = require('../config');
const { makeRenderer, rowsFor } = require('../utils/flowKit');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');
const { LAGOS_TZ } = require('../utils/dates');

const SESSION_TYPE = 'sales_browser_flow';
const NS = 'sbr:';
const DAYS_ON_SCREEN = 7;
const MAX_DAYS_BACK = 90;
const ITEMS_PER_PAGE = 8;

const render = makeRenderer({ parseMode: 'Markdown', requireSession: SESSION_TYPE });

function lagosISO(daysBack = 0) {
  return new Date(Date.now() - daysBack * 86400000).toLocaleDateString('en-CA', { timeZone: LAGOS_TZ });
}
function esc(s) { return String(s == null ? '' : s).replace(/[*_`[\]]/g, ''); }
function ngn(n) { return `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`; }
const { closeRow } = rowsFor('sbr');

/* ── data assembly (read-time, raw sheets) ── */

function isSaleRow(t) {
  return /^(sell|sale)/i.test(t.action || '') && (t.status || '').toLowerCase() !== 'reverted';
}

/** Group a day's sale rows into sales (one group per SaleRefId). */
function groupSales(rows) {
  const map = new Map();
  for (const t of rows.filter(isSaleRow)) {
    const key = t.saleRefId || `${t.timestamp}|${t.customerName}`;
    if (!map.has(key)) {
      map.set(key, {
        kind: 'sale', key, saleRefId: t.saleRefId, customer: t.customerName,
        salesPerson: t.salesPerson, paymentMode: t.paymentMode, salesDate: t.salesDate,
        backdated: '', yards: 0, amount: 0, bales: new Set(), lines: [],
      });
    }
    const g = map.get(key);
    g.yards += t.qty;
    g.amount += t.qty * (t.pricePerYard || 0);
    if (t.design) g.bales.add(`${t.design}|${t.timestamp}`);
    if (t.backdated) g.backdated = t.backdated;
    if (!g.paymentMode && t.paymentMode) g.paymentMode = t.paymentMode;
    g.lines.push({ design: t.design, shade: t.color, yards: t.qty, warehouse: t.warehouse, action: t.action });
  }
  return [...map.values()];
}

async function salesForDay(dayIso) {
  const rows = await transactionsRepository.getBySalesDateRange(dayIso, dayIso);
  return groupSales(rows);
}

async function suppliesForDay(dayIso) {
  const resolved = await approvalQueueRepository.getResolved();
  return resolved
    .filter((r) => (r.actionJSON || {}).action === 'supply_request')
    .filter((r) => {
      const aj = r.actionJSON || {};
      const d = String(aj.salesDate || r.createdAt || '').slice(0, 10);
      return d === dayIso;
    })
    .map((r) => {
      const aj = r.actionJSON || {};
      const totalQty = (aj.cart || []).reduce((s, c) => s + (Number(c.quantity) || 0), 0);
      return {
        kind: 'supply', key: r.requestId, requestId: r.requestId,
        customer: aj.customer || '—', warehouse: aj.warehouse || '—',
        salesperson: aj.salesperson || '', status: r.status, stage: aj.stage || '',
        totalQty, cart: aj.cart || [], salesDate: String(aj.salesDate || r.createdAt || '').slice(0, 10),
      };
    });
}

/* ── screens ── */

async function start(bot, chatId, userId, messageId = null) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, '📈 The Sales Browser is admin-only.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'days', tab: 'sales',
    flowMessageId: messageId || null, startedAt: Date.now(), _items: [],
  });
  await showDays(bot, chatId, userId);
}

async function showDays(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'days';
  sessionStore.set(userId, session);
  const tab = session.tab;
  const rows = [[
    { text: `${tab === 'sales' ? '● ' : ''}💰 Sales`, callback_data: `${NS}tab:sales` },
    { text: `${tab === 'supplies' ? '● ' : ''}📦 Supplies`, callback_data: `${NS}tab:supplies` },
  ]];
  const lines = [];
  for (let d = 0; d < DAYS_ON_SCREEN; d++) {
    const iso = lagosISO(d);
    let label;
    try {
      if (tab === 'sales') {
        const groups = await salesForDay(iso);
        const yds = groups.reduce((s, g) => s + g.yards, 0);
        label = groups.length
          ? `${d === 0 ? '📅 Today — ' : `${fmtDate(iso)} — `}${groups.length} sale${groups.length > 1 ? 's' : ''} · ${Math.round(yds)} yds`
          : `${d === 0 ? '📅 Today — ' : `${fmtDate(iso)} — `}no sales`;
      } else {
        const items = await suppliesForDay(iso);
        label = `${d === 0 ? '📅 Today — ' : `${fmtDate(iso)} — `}${items.length ? `${items.length} suppl${items.length > 1 ? 'ies' : 'y'}` : 'none'}`;
      }
    } catch (e) {
      logger.warn(`salesBrowser day ${iso}: ${e.message}`);
      label = `${fmtDate(iso)} — ⚠️`;
    }
    rows.push([{ text: label, callback_data: `${NS}day:${iso}` }]);
    lines.push(label);
  }
  rows.push([{ text: '📆 Older date — calendar', callback_data: `${NS}cal:${lagosISO(0).slice(0, 7)}` }]);
  rows.push(closeRow());
  await render(bot, chatId, userId,
    `📈 *${tab === 'sales' ? 'Sales' : 'Supplies'} Browser*\n\nTap a day to open its list:`, rows);
}

async function showCalendar(bot, chatId, userId, ym) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const todayIso = lagosISO(0);
  const oldestIso = lagosISO(MAX_DAYS_BACK);
  const [y, m] = ym.split('-').map(Number);
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const rows = [];
  const prevYm = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
  const nextYm = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
  rows.push([
    prevYm >= oldestIso.slice(0, 7) ? { text: '◀', callback_data: `${NS}cal:${prevYm}` } : { text: ' ', callback_data: `${NS}noop` },
    { text: `${monthName} ${y}`, callback_data: `${NS}noop` },
    nextYm <= todayIso.slice(0, 7) ? { text: '▶', callback_data: `${NS}cal:${nextYm}` } : { text: ' ', callback_data: `${NS}noop` },
  ]);
  let week = new Array(firstDow).fill({ text: ' ', callback_data: `${NS}noop` });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${ym}-${String(d).padStart(2, '0')}`;
    const ok = iso <= todayIso && iso >= oldestIso;
    week.push(ok ? { text: String(d), callback_data: `${NS}day:${iso}` } : { text: '·', callback_data: `${NS}noop` });
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length) { while (week.length < 7) week.push({ text: ' ', callback_data: `${NS}noop` }); rows.push(week); }
  rows.push([{ text: '⬅ Recent days', callback_data: `${NS}back` }]);
  rows.push(closeRow());
  await render(bot, chatId, userId, '📆 Tap a day to open its list:', rows);
}

async function showDay(bot, chatId, userId, dayIso, page = 0) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const tab = session.tab;
  const items = tab === 'sales' ? await salesForDay(dayIso) : await suppliesForDay(dayIso);
  session.day = dayIso;
  session._items = items;
  session.step = 'day';
  sessionStore.set(userId, session);
  if (!items.length) {
    await render(bot, chatId, userId,
      `📈 *${fmtDate(dayIso)}* — no ${tab} recorded on this date.`,
      [[{ text: '⬅ Days', callback_data: `${NS}back` }], closeRow()]);
    return;
  }
  const pages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  const rows = items.slice(p * ITEMS_PER_PAGE, (p + 1) * ITEMS_PER_PAGE).map((g, i) => {
    const idx = p * ITEMS_PER_PAGE + i;
    const label = g.kind === 'sale'
      ? `${esc(g.customer || '—')} — ${g.lines.length} item${g.lines.length > 1 ? 's' : ''} · ${Math.round(g.yards)} yds${g.amount ? ` · ${ngn(g.amount)}` : ''}${g.backdated ? ' ⚠️BD' : ''}`
      : `${esc(g.customer)} — ${g.totalQty} bale(s) · ${esc(g.warehouse)} · ${esc(g.status)}`;
    return [{ text: label, callback_data: `${NS}itm:${idx}` }];
  });
  const nav = [{ text: '⬅ Days', callback_data: `${NS}back` }];
  if (p > 0) nav.push({ text: '◀ Prev', callback_data: `${NS}day:${dayIso}:${p - 1}` });
  if (p < pages - 1) nav.push({ text: 'Next ▶', callback_data: `${NS}day:${dayIso}:${p + 1}` });
  rows.push(nav);
  rows.push(closeRow());
  const totalYds = tab === 'sales' ? items.reduce((s, g) => s + g.yards, 0) : 0;
  const totalAmt = tab === 'sales' ? items.reduce((s, g) => s + g.amount, 0) : 0;
  const head = tab === 'sales'
    ? `💰 *${fmtDate(dayIso)}* — ${items.length} sale${items.length > 1 ? 's' : ''} · ${Math.round(totalYds)} yds${totalAmt ? ` · ${ngn(totalAmt)}` : ''}`
    : `📦 *${fmtDate(dayIso)}* — ${items.length} suppl${items.length > 1 ? 'ies' : 'y'}`;
  await render(bot, chatId, userId, `${head}\n\nTap an entry for full details:`, rows);
}

async function showDetail(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const g = (session._items || [])[idx];
  if (!g) return;
  session.step = 'detail';
  sessionStore.set(userId, session);
  let text;
  if (g.kind === 'sale') {
    const lines = g.lines.slice(0, 15).map((l) =>
      `  • ${esc(l.design)}${l.shade ? ` sh ${esc(l.shade)}` : ''} — ${Math.round(l.yards)} yds${l.warehouse ? ` (${esc(l.warehouse)})` : ''}`);
    if (g.lines.length > 15) lines.push(`  …+${g.lines.length - 15} more lines`);
    text = `💰 *Sale — ${esc(g.customer || '—')}*\n\n`
      + `📅 Sale date: ${fmtDate(g.salesDate)}${g.backdated ? `  ⚠️ *${esc(g.backdated)}*` : ''}\n`
      + (g.salesPerson ? `🧑 Salesperson: ${esc(g.salesPerson)}\n` : '')
      + `\n${lines.join('\n')}\n\n`
      + `Total: *${Math.round(g.yards)} yds*${g.amount ? ` · *${ngn(g.amount)}*` : ''}\n`
      + (g.paymentMode ? `💳 Payment: ${esc(g.paymentMode)}\n` : '');
    // Approval + invoice enrichment (best-effort lookups).
    if (g.saleRefId) {
      text += `🧾 Ref: \`${g.saleRefId}\`\n`;
      try {
        const q = await approvalQueueRepository.getByRequestId(g.saleRefId);
        if (q) text += `🛂 Approval: ${esc(q.status)}\n`;
      } catch (_) {}
      try {
        const invoicesRepository = require('../repositories/invoicesRepository');
        const inv = await invoicesRepository.getByRequestId(g.saleRefId);
        if (inv) {
          text += `🧾 Invoice: *${esc(inv.invoiceNo)}*`;
          if (config.baseUrl && inv.token) text += ` — ${config.baseUrl}/i/${inv.token}`;
          text += '\n';
        }
      } catch (_) {}
    }
  } else {
    const cartLines = (g.cart || []).slice(0, 15).map((c) =>
      `  • ${esc(c.design)}${c.shade ? ` sh ${esc(c.shade)}` : ''} × ${c.quantity}`);
    text = `📦 *Supply — ${esc(g.customer)}*\n\n`
      + `📅 Date: ${fmtDate(g.salesDate)}\n🏭 Warehouse: ${esc(g.warehouse)}\n`
      + (g.salesperson ? `🧑 Salesperson: ${esc(g.salesperson)}\n` : '')
      + `🛂 Status: ${esc(g.status)}${g.stage ? ` · stage ${esc(g.stage)}` : ''}\n`
      + `\n${cartLines.join('\n')}\n\nTotal: *${g.totalQty} bale(s)*\n🧾 Ref: \`${g.requestId}\``;
  }
  await render(bot, chatId, userId, text, [
    [{ text: `⬅ ${fmtDate(session.day)}`, callback_data: `${NS}day:${session.day}` }],
    [{ text: '⬅ Days', callback_data: `${NS}back` }],
    closeRow(),
  ]);
}

/* ── dispatch ── */

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith(NS)) return false;
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  await bot.answerCallbackQuery(query.id).catch(() => {});
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    await bot.answerCallbackQuery(query.id, { text: 'Expired — open 📈 Sales Browser again.', show_alert: true }).catch(() => {});
    return true;
  }
  const rest = data.slice(NS.length);
  if (rest === 'noop') return true;
  if (rest === 'close') {
    sessionStore.clear(userId);
    await bot.editMessageText('📈 Sales Browser closed.',
      { chat_id: chatId, message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]] } }).catch(() => {});
    return true;
  }
  if (rest === 'back') { await showDays(bot, chatId, userId); return true; }
  if (rest.startsWith('tab:')) {
    session.tab = rest.slice(4) === 'supplies' ? 'supplies' : 'sales';
    sessionStore.set(userId, session);
    await showDays(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('cal:')) { await showCalendar(bot, chatId, userId, rest.slice(4)); return true; }
  if (rest.startsWith('day:')) {
    const [iso, pageStr] = rest.slice(4).split(':');
    await showDay(bot, chatId, userId, iso, parseInt(pageStr, 10) || 0);
    return true;
  }
  if (rest.startsWith('itm:')) { await showDetail(bot, chatId, userId, parseInt(rest.slice(4), 10)); return true; }
  return true;
}

module.exports = { SESSION_TYPE, start, handleCallback, _internals: { groupSales, salesForDay, suppliesForDay } };
