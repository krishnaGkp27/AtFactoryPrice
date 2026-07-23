/**
 * Sales Workflow View (T3) — admin lens.
 *
 * Read-only consolidated view of every supply order grouped by status,
 * joined with the customer's contact info and current credit position.
 * No writes; no admin override actions in this commit (those are
 * deferred to a follow-up that requires an order state-machine).
 *
 * Visibility: admin-only. Routed from `act:sales_workflow_view` in
 * the controller; this module gates again via `isAdmin` so it's
 * safe to require from anywhere.
 *
 * Callback namespace: `swv:*`
 *   swv:list                — re-render the grouped list
 *   swv:d:<orderId>         — open the detail card for that order
 */

'use strict';

const ordersRepo = require('../repositories/ordersRepository');
const customersRepo = require('../repositories/customersRepository');
const ledgerCache = require('../repositories/ledgerBalanceCacheRepository');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');
const { editOrSend, sendLong } = require('../utils/telegramUI');
const { fmtMoneyShort: fmtMoney } = require('../utils/format');

const RECENT_DELIVERED_LIMIT = 5;

const { mdEscape: escapeMd } = require('../utils/flowKit');

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mmm = d.toLocaleString('en-US', { month: 'short' });
    // 4-digit year to match the canonical fmtDate() output (DD-MMM-YYYY).
    const yyyy = String(d.getFullYear());
    return `${dd}-${mmm}-${yyyy}`;
  } catch (_) { return iso; }
}

function navFooterRow() {
  return [
    { text: '⬅ Back to Reporting', callback_data: 'act:__hub__:reporting' },
    { text: '🏠 Menu',          callback_data: 'act:__back__' },
  ];
}

function listNavRow() {
  return [
    { text: '🔄 Refresh',       callback_data: 'swv:list' },
    { text: '⬅ Back to Reporting', callback_data: 'act:__hub__:reporting' },
  ];
}

/**
 * Look up the customer's record by name (orders store the customer's
 * displayed name, not their ID). Returns null when no match. Used both
 * by the list ("ledger balance line") and the detail card.
 */
async function findCustomerByOrderName(name, customers) {
  if (!name) return null;
  const target = String(name).trim().toLowerCase();
  return customers.find((c) => String(c.name || '').trim().toLowerCase() === target) || null;
}

/**
 * Try to find the LedgerBalanceCache row for a customer. Cache key is
 * customer_id; missing entries imply zero balance (or not yet tracked
 * in the ledger system).
 */
async function lookupLedgerBalance(customer, balanceCache) {
  if (!customer || !customer.customer_id) return null;
  const row = balanceCache.find((b) => b.customer_id === customer.customer_id);
  return row ? row.balance : null;
}

function statusOrder(status) {
  // pending → accepted → delivered. Other (rare) statuses sort last.
  if (status === 'pending_accept') return 0;
  if (status === 'accepted') return 1;
  if (status === 'delivered') return 2;
  return 9;
}

function pendingDays(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 3600 * 1000)));
}

/**
 * Render the grouped list. Admins only. Reads three sheets in parallel
 * (Orders, Customers, LedgerBalanceCache) so the page renders in one
 * round-trip's wait.
 */
async function showSalesWorkflow(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await editOrSend(bot, chatId, messageId,
      '🔒 Sales Workflow is admin-only.',
      { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  let orders, customers, balanceCache;
  try {
    [orders, customers, balanceCache] = await Promise.all([
      ordersRepo.getAll(),
      customersRepo.getAll().catch(() => []),
      ledgerCache.getAll().catch(() => []),
    ]);
  } catch (e) {
    logger.error(`salesWorkflowView.show: read failed: ${e.message}`);
    await editOrSend(bot, chatId, messageId,
      `❌ Couldn't read orders: ${e.message}`,
      { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  // Bucket by lifecycle phase.
  const pending = orders
    .filter((o) => o.status === 'pending_accept')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const accepted = orders
    .filter((o) => o.status === 'accepted')
    .sort((a, b) => String(a.scheduled_date).localeCompare(String(b.scheduled_date)));
  const delivered = orders
    .filter((o) => o.status === 'delivered')
    .sort((a, b) => String(b.delivered_at).localeCompare(String(a.delivered_at)))
    .slice(0, RECENT_DELIVERED_LIMIT);

  const lines = ['📊 *Sales Workflow*', ''];
  const rows = [];

  if (!pending.length && !accepted.length && !delivered.length) {
    lines.push('_No orders in the system yet._');
    rows.push(navFooterRow());
    await editOrSend(bot, chatId, messageId, lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  // --- Pending block -------------------------------------------------------
  lines.push(`⏳ *Pending acceptance* (${pending.length})`);
  if (!pending.length) {
    lines.push('   _none_', '');
  } else {
    for (const o of pending) {
      const cust = await findCustomerByOrderName(o.customer, customers);
      const bal = await lookupLedgerBalance(cust, balanceCache);
      const days = pendingDays(o.created_at);
      const ageHint = days != null ? ` · ${days}d waiting` : '';
      lines.push(`• \`${o.order_id}\` · ${escapeMd(o.design)}${o.shade ? ' / ' + escapeMd(o.shade) : ''} · ${escapeMd(o.quantity)}`);
      lines.push(`   👤 ${escapeMd(o.customer)}${cust ? ' · ' + escapeMd(cust.category || 'Standard') : ''}${bal != null ? ' · ' + fmtMoney(bal) + ' cr' : ''}`);
      lines.push(`   📅 ${fmtDate(o.scheduled_date)} · 💵 ${escapeMd(o.payment_status)} · 👷 ${escapeMd(o.salesperson_name)}${ageHint}`);
      rows.push([{
        text: `📋 ${truncate(o.order_id + ' · ' + o.customer, 38)}`,
        callback_data: `swv:d:${o.order_id}`,
      }]);
    }
    lines.push('');
  }

  // --- Accepted block ------------------------------------------------------
  lines.push(`✅ *Accepted, in flight* (${accepted.length})`);
  if (!accepted.length) {
    lines.push('   _none_', '');
  } else {
    for (const o of accepted) {
      const cust = await findCustomerByOrderName(o.customer, customers);
      const bal = await lookupLedgerBalance(cust, balanceCache);
      lines.push(`• \`${o.order_id}\` · ${escapeMd(o.design)}${o.shade ? ' / ' + escapeMd(o.shade) : ''} · ${escapeMd(o.quantity)}`);
      lines.push(`   👤 ${escapeMd(o.customer)}${cust ? ' · ' + escapeMd(cust.category || 'Standard') : ''}${bal != null ? ' · ' + fmtMoney(bal) + ' cr' : ''}`);
      lines.push(`   📅 ${fmtDate(o.scheduled_date)} · ✅ accepted ${fmtDate(o.accepted_at)} · 👷 ${escapeMd(o.salesperson_name)}`);
      rows.push([{
        text: `📋 ${truncate(o.order_id + ' · ' + o.customer, 38)}`,
        callback_data: `swv:d:${o.order_id}`,
      }]);
    }
    lines.push('');
  }

  // --- Recently delivered tail --------------------------------------------
  if (delivered.length) {
    lines.push(`🗂 *Recently delivered (last ${RECENT_DELIVERED_LIMIT})*`);
    for (const o of delivered) {
      lines.push(`• \`${o.order_id}\` · ${escapeMd(o.design)} · ${escapeMd(o.customer)} · delivered ${fmtDate(o.delivered_at)}`);
    }
  }

  rows.push(listNavRow());

  await sendLong(bot, chatId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows },
  });
}

/**
 * Render a detail card for one order. Admin-gated. Pulls customer and
 * ledger info, plus the customer's most recent 3 other orders so admin
 * has context without leaving the card.
 */
async function showOrderDetail(bot, chatId, userId, messageId, orderId) {
  if (!auth.isAdmin(userId)) {
    await editOrSend(bot, chatId, messageId,
      '🔒 Sales Workflow is admin-only.',
      { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  let order, allOrders, customers, balanceCache;
  try {
    [allOrders, customers, balanceCache] = await Promise.all([
      ordersRepo.getAll(),
      customersRepo.getAll().catch(() => []),
      ledgerCache.getAll().catch(() => []),
    ]);
    order = allOrders.find((o) => o.order_id === orderId);
  } catch (e) {
    logger.error(`salesWorkflowView.detail: read failed: ${e.message}`);
    await editOrSend(bot, chatId, messageId,
      `❌ Couldn't read order: ${e.message}`,
      { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  if (!order) {
    await editOrSend(bot, chatId, messageId,
      `❌ Order \`${orderId}\` not found.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '⬅ Back to list', callback_data: 'swv:list' },
      ]] } });
    return;
  }

  const cust = await findCustomerByOrderName(order.customer, customers);
  const bal = await lookupLedgerBalance(cust, balanceCache);
  const tier = cust?.category || 'Standard';

  // Find that customer's 3 most recent other orders (excluding this one)
  // so admin can spot patterns ("they keep ordering this design") fast.
  const otherOrders = allOrders
    .filter((o) => o.customer === order.customer && o.order_id !== order.order_id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 3);

  const statusBadge = ({
    pending_accept: '⏳ Pending acceptance',
    accepted: '✅ Accepted',
    delivered: '🗂 Delivered',
  })[order.status] || `· ${order.status}`;

  const lines = [
    `📋 *Order \`${order.order_id}\`*`, '',
    `📝 ${escapeMd(order.design)}${order.shade ? ` · Shade \`${escapeMd(order.shade)}\`` : ''} · ${escapeMd(order.quantity)}`,
    '',
    `👤 *Customer:* ${escapeMd(order.customer)}`,
  ];
  if (cust) {
    if (cust.phone) lines.push(`   📞 ${escapeMd(cust.phone)}`);
    lines.push(`   🏷 Tier: *${escapeMd(tier)}*${cust.credit_limit ? ' · Credit limit: ' + fmtMoney(cust.credit_limit) : ''}`);
    if (bal != null) lines.push(`   💰 Ledger: *${fmtMoney(bal)}* ${bal >= 0 ? 'credit' : 'debit'}`);
    if (cust.payment_terms) lines.push(`   📝 Terms: ${escapeMd(cust.payment_terms)}`);
  } else {
    lines.push('   _Not yet in the Customers sheet — add via Add Customer._');
  }
  lines.push('');
  lines.push(`👷 *Salesperson:* ${escapeMd(order.salesperson_name)}`);
  lines.push(`💵 *Payment:* ${escapeMd(order.payment_status)}`);
  lines.push(`📅 *Scheduled:* ${fmtDate(order.scheduled_date)}`);
  lines.push('');
  lines.push(`*Status:* ${statusBadge}`);
  if (order.created_at)   lines.push(`   _created ${fmtDate(order.created_at)}_`);
  if (order.accepted_at)  lines.push(`   _accepted ${fmtDate(order.accepted_at)}_`);
  if (order.delivered_at) lines.push(`   _delivered ${fmtDate(order.delivered_at)}_`);

  if (otherOrders.length) {
    lines.push('', `🗂 *Recent orders from this customer*`);
    for (const o of otherOrders) {
      lines.push(`   \`${o.order_id}\` · ${escapeMd(o.design)} · ${escapeMd(o.quantity)} · ${o.status}`);
    }
  }

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '⬅ Back to list',  callback_data: 'swv:list' },
      { text: '🏠 Menu',          callback_data: 'act:__back__' },
    ]] },
  });
}

/** Single callback entry point used by telegramController. */
async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('swv:')) return false;
  try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) { /* noop */ }
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (data === 'swv:list') {
    await showSalesWorkflow(bot, chatId, userId, messageId);
    return true;
  }
  if (data.startsWith('swv:d:')) {
    const orderId = data.slice('swv:d:'.length);
    await showOrderDetail(bot, chatId, userId, messageId, orderId);
    return true;
  }
  return false;
}

module.exports = {
  showSalesWorkflow,
  showOrderDetail,
  handleCallback,
};
