'use strict';

/**
 * src/flows/unitDisplayFlow.js — WAREHOUSE DISPLAY UNITS (TV-2).
 *
 * Admin/manager flow to flip how a warehouse's stock counts appear on the
 * supply screens (bales ⇄ thans, the TV-1 Settings key) WITHOUT editing
 * the Settings sheet by hand. Every switch is queued as a
 * `set_unit_display` approval and only applied once an admin (other than
 * an admin requester) approves — the standard ALWAYS_APPROVAL pipeline.
 *
 *   1. pick     — tappable warehouse list with each one's current mode.
 *   2. confirm  — "switch <wh> from X to Y?" card → queue the approval.
 *
 * Requesters: admins and managers. Approver: any admin ≠ requester
 * (requester exclusion is automatic in notifyAdminsApprovalRequest).
 *
 * Callback namespace `udf:*`:
 *   udf:wh:<idx>   pick warehouse (index into session._whs)
 *   udf:req        queue the switch for approval
 *   udf:back       back to the warehouse list
 *   udf:cancel     close the flow
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const usersRepository = require('../repositories/usersRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const unitDisplayService = require('../services/unitDisplayService');
const approvalEvents = require('../events/approvalEvents');
const auth = require('../middlewares/auth');
const idGenerator = require('../utils/idGenerator');
const logger = require('../utils/logger');

const SESSION_TYPE = 'unit_display_flow';
const ACTION = 'set_unit_display';
const RISK_REASON = 'Warehouse display-unit switches require admin approval.';

/* ───────────────────────── helpers ───────────────────────── */

function closeRow() {
  return [{ text: '❌ Close', callback_data: 'udf:cancel' }];
}

// Anchored edit-else-send renderer — shared flowKit implementation.
const render = makeRenderer();

/**
 * TV-2 gate: admins and (active) managers may request a switch.
 * @param {string} userId Telegram user id
 * @returns {Promise<boolean>}
 */
async function canRequest(userId) {
  if (auth.isAdmin(String(userId))) return true;
  try {
    const user = await usersRepository.findByUserId(String(userId));
    return !!(user && user.status === 'active' && String(user.role || '').toLowerCase() === 'manager');
  } catch (_) {
    return false;
  }
}

/* ───────────────────────── screens ───────────────────────── */

async function renderWarehousePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const warehouses = await inventoryRepository.getWarehouses();
  if (!warehouses.length) {
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      '📐 *Warehouse Display Units*\n\n_No warehouses found in inventory._',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }
  const thanSet = await unitDisplayService.getThanVisibilityWarehouses();
  session._whs = warehouses;
  session.step = 'pick';
  sessionStore.set(userId, session);

  const rows = warehouses.map((w, i) => {
    const isThans = thanSet.has(String(w).trim().toLowerCase());
    return [{ text: `${isThans ? '🧵' : '📦'} ${w} — ${isThans ? 'thans' : 'bales'}`, callback_data: `udf:wh:${i}` }];
  });
  rows.push(closeRow());
  await render(bot, chatId, userId,
    '📐 *Warehouse Display Units*\n\nHow stock counts appear on supply screens.\nTap a warehouse to switch its display unit:',
    rows);
}

async function renderConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.target) return;
  const { warehouse, from, to } = session.target;
  await render(bot, chatId, userId,
    `📐 *${warehouse}*\n\nCurrent display: *${from.toUpperCase()}*\nSwitch to: *${to.toUpperCase()}*\n\n⚠️ _Needs approval from an admin before it takes effect._`,
    [
      [{ text: `✅ Request switch to ${to}`, callback_data: 'udf:req' }],
      [{ text: '⬅ Back', callback_data: 'udf:back' }],
      closeRow(),
    ]);
}

async function submitRequest(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.target) return;
  const { warehouse, from, to } = session.target;

  // Duplicate guard: one pending switch per warehouse at a time.
  const pending = await approvalQueueRepository.getAllPending();
  const dup = pending.find((p) => p.actionJSON
    && p.actionJSON.action === ACTION
    && String(p.actionJSON.warehouse || '').trim().toLowerCase() === warehouse.trim().toLowerCase());
  if (dup) {
    await render(bot, chatId, userId,
      `⚠️ A display-unit switch for *${warehouse}* is already awaiting approval (\`${dup.requestId}\`).`,
      [[{ text: '⬅ Back', callback_data: 'udf:back' }], closeRow()]);
    return;
  }

  const requestId = idGenerator.requestId();
  try {
    await approvalQueueRepository.append({
      requestId, user: String(userId),
      actionJSON: { action: ACTION, warehouse, mode: to },
      riskReason: RISK_REASON, status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, action: ACTION, warehouse, mode: to }, String(userId));
    const isAdm = auth.isAdmin(String(userId));
    const excludeId = isAdm ? String(userId) : undefined;
    const summary = `📐 Display units: *${warehouse}* ${from} → *${to}*`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, String(userId), summary, RISK_REASON, excludeId);
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      `⏳ *Submitted for admin approval*\n\n*${warehouse}*: ${from} → *${to}*\nRequest: \`${requestId}\`\n\n_You'll be notified when an admin approves or rejects._`,
      [[{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]]);
  } catch (e) {
    logger.error(`unitDisplayFlow: submit failed: ${e.message}`);
    await render(bot, chatId, userId,
      `⚠️ Could not queue the request: ${e.message}`,
      [[{ text: '⬅ Back', callback_data: 'udf:back' }], closeRow()]);
  }
}

/* ───────────────────────── entry + dispatcher ───────────────────────── */

/**
 * Start the Warehouse Display Units flow.
 * @param {object} bot Telegram bot instance.
 * @param {number|string} chatId Chat id.
 * @param {string} userId Telegram user id.
 * @param {number|null} messageId Optional message id to edit in place.
 * @returns {Promise<void>}
 */
async function start(bot, chatId, userId, messageId) {
  if (!(await canRequest(userId))) {
    await bot.sendMessage(chatId, '📐 Display-unit switches can be requested by admins and managers only.');
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE,
    step: 'pick',
    flowMessageId: messageId || null,
    _whs: [],
    target: null,
  });
  await renderWarehousePicker(bot, chatId, userId);
}

/**
 * Handle a `udf:*` callback.
 * @param {object} bot Telegram bot instance.
 * @param {object} query Telegram callback query.
 * @returns {Promise<boolean>} true when handled.
 */
async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('udf:')) return false;
  const chatId = query.message && query.message.chat && query.message.chat.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  if (!session || session.type !== SESSION_TYPE) {
    await bot.sendMessage(chatId, '📐 This flow has expired — open Display Units again from the menu.');
    return true;
  }

  if (data === 'udf:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '📐 Closed.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return true;
  }

  if (data === 'udf:back') {
    session.target = null;
    sessionStore.set(userId, session);
    await renderWarehousePicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('udf:wh:')) {
    const i = parseInt(data.slice('udf:wh:'.length), 10);
    const warehouse = (session._whs || [])[i];
    if (!warehouse) return true;
    const isThans = await unitDisplayService.isThanVisibilityWarehouse(warehouse);
    session.target = { warehouse, from: isThans ? 'thans' : 'bales', to: isThans ? 'bales' : 'thans' };
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await renderConfirm(bot, chatId, userId);
    return true;
  }

  if (data === 'udf:req') {
    await submitRequest(bot, chatId, userId);
    return true;
  }

  return false;
}

module.exports = {
  start,
  handleCallback,
  _internals: { canRequest, renderWarehousePicker, renderConfirm, submitRequest, SESSION_TYPE, ACTION },
};
