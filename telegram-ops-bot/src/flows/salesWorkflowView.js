/**
 * 🚚 Pending Supply (T3 Sales Workflow view, extended by SUPQ-1) — the
 * admin's goods-owed queue.
 *
 * Read-only. Three kinds of "promised but not delivered", all derived at
 * read time (BUSINESS_RULES §10 — no new sheets):
 *   - Orders not yet accepted / accepted-in-flight (the Orders sheet, the
 *     only store with a real undelivered lifecycle), joined with the
 *     customer's contact info and credit position;
 *   - Supply requests still in the approval pipeline (pending
 *     ApprovalQueue rows, action = supply_request, any stage), shown with
 *     the stage in human words and who currently holds it.
 * An approved SALE is delivered by construction (stock flips sold at
 * approval; no dispatch state exists) and never appears here. Money is
 * deliberately absent beyond the existing ledger-balance line — customer
 * money views live on the website (§15b, owner 22-Aug-2026).
 *
 * Visibility: admin-only. Routed from `act:sales_workflow_view` in
 * the controller; this module gates again via `isAdmin` so it's
 * safe to require from anywhere.
 *
 * Callback namespace: `swv:*`
 *   swv:list                — re-render the grouped list
 *   swv:d:<orderId>         — open the detail card for that order
 *   swv:s:<requestId>       — open the detail card for a supply request
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

/* ── SUPQ-1: supply requests still in the approval pipeline ────────────────
 * The stage rides actionJSON (sheet Status stays 'pending' through every
 * intermediate stage), so the queue must parse each pending row's JSON.   */

const STAGE_LABELS = {
  dispatch_review: 'awaiting dispatch check',
  admin_review: 'awaiting admin approval',
  admin_repick: 'admin re-picking warehouse boy',
  dispatch_acceptance: 'awaiting %s',
};

/**
 * Reduce pending ApprovalQueue rows to render-ready supply-pipeline items.
 * Pure — unit-tested with fixture rows. Unknown/missing stages read as
 * admin_review (that is where a dispatchSkipped request actually sits).
 * @param {Array<{requestId:string,user:string,actionJSON:object,createdAt:string}>} pendingRows
 */
function supplyPipeline(pendingRows) {
  const items = [];
  for (const r of pendingRows || []) {
    const aj = r.actionJSON || {};
    if (aj.action !== 'supply_request') continue;
    const stage = STAGE_LABELS[aj.stage] ? aj.stage : 'admin_review';
    const assigned = (aj.assignedDispatch && aj.assignedDispatch.name) || '';
    const stageLabel = stage === 'dispatch_acceptance'
      ? STAGE_LABELS[stage].replace('%s', assigned || 'warehouse boy')
      : STAGE_LABELS[stage];
    const holder = stage === 'dispatch_review' ? 'Dispatch pool'
      : stage === 'dispatch_acceptance' ? (assigned || 'assigned warehouse boy')
        : 'Admins';
    const cart = Array.isArray(aj.cart) ? aj.cart : [];
    const bales = cart.reduce((n, l) => n + (Number(l.quantity) || 0), 0);
    items.push({
      requestId: r.requestId,
      requester: r.user,
      customer: aj.customer || '—',
      warehouse: aj.warehouse || '—',
      salesperson: aj.salesperson || '',
      bales,
      cart,
      stage,
      stageLabel,
      holder,
      createdAt: r.createdAt || '',
      stamps: {
        confirmedByDispatch: aj.confirmedByDispatch || null,
        approvedByAdmin: aj.approvedByAdmin || null,
        assignedDispatch: aj.assignedDispatch || null,
        dispatchDecline: aj.dispatchDecline || null,
      },
    });
  }
  // Oldest first — the queue exists so old promises stay visible.
  items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return items;
}

/**
 * Render the grouped list. Admins only. Reads three sheets in parallel
 * (Orders, Customers, LedgerBalanceCache) so the page renders in one
 * round-trip's wait.
 */
async function showSalesWorkflow(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await editOrSend(bot, chatId, messageId,
      '🔒 Pending Supply is admin-only.',
      { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }

  let orders, customers, balanceCache, pendingApprovals;
  try {
    [orders, customers, balanceCache, pendingApprovals] = await Promise.all([
      ordersRepo.getAll(),
      customersRepo.getAll().catch(() => []),
      ledgerCache.getAll().catch(() => []),
      // SUPQ-1 — null (not []) marks a failed read so the section can say
      // "couldn't read" instead of a false "none in pipeline".
      require('../repositories/approvalQueueRepository').getAllPending().catch(() => null),
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

  const pipeline = supplyPipeline(pendingApprovals || []);

  const totalOpen = pending.length + accepted.length + pipeline.length;
  const lines = [`🚚 *Pending Supply${totalOpen ? ` — ${totalOpen} open` : ''}*`, ''];
  const rows = [];

  if (!totalOpen && !delivered.length && pendingApprovals !== null) {
    lines.push('✅ _Nothing owed — no open orders, nothing in the supply pipeline._');
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

  // --- SUPQ-1: supply requests still in the approval pipeline --------------
  if (pendingApprovals === null) {
    lines.push('🛂 *Supply requests* — ⚠️ _could not read the queue just now._', '');
  } else {
    lines.push(`🛂 *Supply requests in pipeline* (${pipeline.length})`);
    if (!pipeline.length) {
      lines.push('   _none_', '');
    } else {
      for (const it of pipeline) {
        const days = pendingDays(it.createdAt);
        const ageHint = days != null ? ` · ${days}d waiting` : '';
        lines.push(`• \`${it.requestId}\` · ${escapeMd(it.customer)} · ${it.bales}B · ${escapeMd(it.warehouse)}`);
        lines.push(`   ⏳ ${escapeMd(it.stageLabel)} · 👤 ${escapeMd(it.holder)}${ageHint}`);
        rows.push([{
          text: `🛂 ${truncate(it.customer + ' · ' + it.stageLabel, 38)}`,
          callback_data: `swv:s:${it.requestId}`,
        }]);
      }
      lines.push('');
    }
  }

  // --- Recently delivered tail --------------------------------------------
  if (delivered.length) {
    lines.push(`🗂 *Recently delivered (last ${RECENT_DELIVERED_LIMIT})*`);
    for (const o of delivered) {
      lines.push(`• \`${o.order_id}\` · ${escapeMd(o.design)} · ${escapeMd(o.customer)} · delivered ${fmtDate(o.delivered_at)}`);
    }
  }

  rows.push(listNavRow());

  // Edit the anchored card in place when the text fits — sendLong ALWAYS
  // sends a new message, so 🔄 Refresh and '⬅ Back to list' used to stack a
  // fresh copy each tap and leave dead keyboards above.
  const body = lines.join('\n');
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  if (messageId && body.length <= 4000) {
    await editOrSend(bot, chatId, messageId, body, opts);
    return;
  }
  await sendLong(bot, chatId, body, opts);
}

/**
 * Render a detail card for one order. Admin-gated. Pulls customer and
 * ledger info, plus the customer's most recent 3 other orders so admin
 * has context without leaving the card.
 */
async function showOrderDetail(bot, chatId, userId, messageId, orderId) {
  if (!auth.isAdmin(userId)) {
    await editOrSend(bot, chatId, messageId,
      '🔒 Pending Supply is admin-only.',
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

/**
 * SUPQ-1 — detail card for one in-pipeline supply request: the cart, who
 * asked, who holds it now, and the stage trail so the admin can see where
 * a promise has been sitting. Admin-gated like everything else here.
 */
async function showSupplyRequestDetail(bot, chatId, userId, messageId, requestId) {
  if (!auth.isAdmin(userId)) {
    await editOrSend(bot, chatId, messageId,
      '🔒 Pending Supply is admin-only.',
      { reply_markup: { inline_keyboard: [navFooterRow()] } });
    return;
  }
  let item = null;
  let readFailed = false;
  try {
    const rows = await require('../repositories/approvalQueueRepository').getAllPending();
    item = supplyPipeline(rows).find((it) => it.requestId === requestId) || null;
  } catch (e) {
    logger.error(`salesWorkflowView.supplyDetail: read failed: ${e.message}`);
    readFailed = true;
  }
  if (readFailed || !item) {
    await editOrSend(bot, chatId, messageId,
      readFailed
        ? '⚠️ Could not read the supply request just now — try again.'
        : '✅ This supply request has left the pipeline (approved, rejected, or withdrawn since the list was drawn).',
      { reply_markup: { inline_keyboard: [[
        { text: '⬅ Back to list', callback_data: 'swv:list' },
        { text: '🏠 Menu', callback_data: 'act:__back__' },
      ]] } });
    return;
  }

  const days = pendingDays(item.createdAt);
  const lines = [
    `🛂 *Supply request \`${item.requestId}\`*`, '',
    `👤 *Customer:* ${escapeMd(item.customer)}`,
    `🏭 *Warehouse:* ${escapeMd(item.warehouse)}`,
  ];
  if (item.salesperson) lines.push(`👷 *Salesperson:* ${escapeMd(item.salesperson)}`);
  lines.push('');
  lines.push(`📦 *Goods* (${item.bales}B total)`);
  for (const l of item.cart) {
    lines.push(`   • ${escapeMd(l.design)}${l.shadeName || l.shade ? ' / ' + escapeMd(l.shadeName || l.shade) : ''} × ${escapeMd(String(l.quantity))}B`);
  }
  lines.push('');
  lines.push(`⏳ *Stage:* ${escapeMd(item.stageLabel)} · 👤 ${escapeMd(item.holder)}`);
  if (item.createdAt) lines.push(`   _raised ${fmtDate(item.createdAt)}${days != null ? ` · ${days}d ago` : ''}_`);
  const st = item.stamps;
  if (st.confirmedByDispatch) lines.push(`   _dispatch check ✅ ${escapeMd(st.confirmedByDispatch.name || '')}_`);
  if (st.approvedByAdmin) lines.push('   _admin approved ✅_');
  if (st.assignedDispatch) lines.push(`   _assigned to ${escapeMd(st.assignedDispatch.name || '')}_`);
  if (st.dispatchDecline) lines.push(`   _declined once by ${escapeMd(st.dispatchDecline.name || '')}: ${escapeMd(st.dispatchDecline.reason || '')}_`);
  lines.push('');
  lines.push('_Decisions stay in the 🛂 Approvals inbox — this card only shows where it stands._');

  await editOrSend(bot, chatId, messageId, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '⬅ Back to list', callback_data: 'swv:list' },
      { text: '🏠 Menu', callback_data: 'act:__back__' },
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
  if (data.startsWith('swv:s:')) {
    const requestId = data.slice('swv:s:'.length);
    await showSupplyRequestDetail(bot, chatId, userId, messageId, requestId);
    return true;
  }
  return false;
}

module.exports = {
  showSalesWorkflow,
  showOrderDetail,
  showSupplyRequestDetail,
  handleCallback,
  _internals: { supplyPipeline, STAGE_LABELS },
};
