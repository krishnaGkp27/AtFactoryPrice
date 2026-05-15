/**
 * Standalone Add-Warehouse flow — WH-C1.
 *
 * Reaches the same dual-admin-gated `add_warehouse` action that's already
 * embedded inside the GRN flow's warehouse picker, but as a first-class
 * admin activity in its own right.
 *
 * Why a separate flow file (not extend goodsReceiptFlow):
 *   - Receive Goods owns the "create a warehouse mid-receive" intent.
 *     Wrapping that with a second top-level entry point would entangle
 *     two unrelated user intents in one state machine — confusing both
 *     for the user (back/cancel semantics differ) and for future devs
 *     reading the flow.
 *   - Standalone keeps it ~50 lines and makes the discovery surface
 *     trivially testable from smoke without spinning up the much larger
 *     GRN state machine.
 *
 * UX standard (UX-C1 / non-negotiable):
 *   - Single anchored card via editMessageText (no message stack).
 *   - Every step exposes Back AND Cancel.
 *   - Errors re-render the anchored card via renderError() — never a
 *     bare sendMessage that strands the user without a keyboard.
 *
 * Approval / persistence:
 *   - Same action name `add_warehouse` → same risk policy (in
 *     ALWAYS_APPROVAL_ACTIONS) → same approval queue → same service
 *     handler `inventoryService.executeApprovedAction`. Zero changes to
 *     those layers; this commit only adds a new entry door.
 *
 * Session shape (`type: 'wh_add_flow'`):
 *   {
 *     step: 'await_name' | 'await_confirm',
 *     flowMessageId: number,
 *     name: string,           // canonicalised, pending submit
 *     startedAt: ISO,
 *   }
 *
 * Callback namespace `wh:*`:
 *   wh:cancel        abandon flow
 *   wh:back          return to await_name from await_confirm
 *   wh:submit        send to approval queue
 *
 * Text input:
 *   handleText() picks up the next free-text message while step is
 *   `await_name`, canonicalises it, dedups against the merged
 *   warehouse list (Inventory ∪ WAREHOUSE_LIST), and either re-renders
 *   the card with an inline error (renderError) or advances to the
 *   confirm step.
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const idGenerator = require('../utils/idGenerator');
const riskEvaluate = require('../risk/evaluate');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const approvalEvents = require('../events/approvalEvents');
const auditLogRepository = require('../repositories/auditLogRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const settingsRepository = require('../repositories/settingsRepository');
const logger = require('../utils/logger');

const MAX_NAME_LEN = 50;
const MIN_NAME_LEN = 1;
// WH-C1: strict canonical naming. Letters, digits, spaces, and hyphens
// only. Excludes anything that could break a Sheets formula (`=`, `,`,
// `'`, `"`, etc.) or look-confusing punctuation. Validated after
// canonicalisation so internal whitespace collapse doesn't reject
// already-correct input.
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} -]{0,49}$/u;

/**
 * Canonicalise a free-text warehouse name to a deterministic form so
 * "kano  Main", "Kano main", and "KANO  MAIN" all collide on dedup.
 * Steps:
 *   1. Unicode NFC normalise.
 *   2. Trim leading/trailing whitespace.
 *   3. Collapse internal runs of whitespace to a single space.
 *   4. Title-Case every space-separated token (cap first letter,
 *      lower the rest) — preserves hyphenated names like "Kano-North".
 */
function canonicalizeWarehouseName(input) {
  if (input == null) return '';
  let s = String(input).normalize('NFC').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  s = s
    .split(' ')
    .map((tok) => tok.length
      ? tok[0].toLocaleUpperCase() + tok.slice(1).toLocaleLowerCase()
      : tok)
    .join(' ');
  return s;
}

/**
 * Merged warehouse list — Inventory-derived ∪ Settings.WAREHOUSE_LIST.
 *
 * Mirrors the helper used by every picker (bulkReceiveFlow,
 * photoReceiveFlow, goodsReceiptFlow). Centralised here so the dedup
 * check and any future Manage-Warehouses screen pull from the same
 * source of truth.
 *
 * Returns lowercase Set for cheap O(1) membership tests; callers that
 * need the display strings should hold the raw arrays themselves.
 */
async function listMergedWarehouses() {
  let fromInv = [];
  let fromSet = '';
  try { fromInv = await inventoryRepository.getWarehouses(); } catch (_) { /* repo absent in dev */ }
  try {
    const all = await settingsRepository.getAll();
    fromSet = (all && all.WAREHOUSE_LIST) || '';
  } catch (_) { /* settings absent in dev */ }
  const extra = fromSet.split(',').map((s) => s.trim()).filter(Boolean);
  const merged = Array.from(new Set([...(fromInv || []), ...extra])).sort();
  return {
    raw: merged,
    lower: new Set(merged.map((w) => w.toLowerCase())),
  };
}

/**
 * Render-in-place primitive. Edits the anchored card when one exists,
 * otherwise sends a fresh message and pins its id. Matches the
 * convention in photoReceiveFlow / bulkReceiveFlow.
 */
async function render(bot, chatId, userId, prompt, rows) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = `🏭 *Add Warehouse*\n\n${prompt}`;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const mid = session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (_) { /* message gone or identical — fall through */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  session.flowMessageId = sent.message_id;
  sessionStore.set(userId, session);
}

function cancelRow() { return [{ text: '❌ Cancel', callback_data: 'wh:cancel' }]; }

/**
 * UX-C1 policy: every error re-renders the anchored card with the
 * error text inline AND a step-appropriate retry/cancel keyboard, so
 * the user is never stranded at the bottom of the chat with no buttons.
 */
async function renderError(bot, chatId, userId, errorText) {
  const session = sessionStore.get(userId);
  if (!session) {
    await bot.sendMessage(chatId, errorText, { parse_mode: 'Markdown' });
    return;
  }
  const step = session.step || 'await_name';
  const rows = [];
  if (step === 'await_name') {
    rows.push([{ text: '🔄 Try again', callback_data: 'wh:retry' }]);
  } else {
    rows.push([{ text: '⬅ Back', callback_data: 'wh:back' }]);
  }
  rows.push(cancelRow());
  await render(bot, chatId, userId, `⚠️ ${errorText}`, rows);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, 'Admin only.');
    return;
  }
  sessionStore.set(userId, {
    type: 'wh_add_flow',
    step: 'await_name',
    flowMessageId: messageId || null,
    name: '',
    startedAt: new Date().toISOString(),
  });
  await render(bot, chatId, userId,
    'Type the *new warehouse name* (reply in chat).\n\n'
    + '_Rules:_\n'
    + `• 1–${MAX_NAME_LEN} characters\n`
    + '• Letters, digits, spaces, hyphens only\n'
    + '• Spaces are collapsed, names Title-Cased\n\n'
    + '_Will be queued for 2nd-admin approval — your submit cannot self-approve._',
    [cancelRow()],
  );
}

// ---------------------------------------------------------------------------
// Text input — applies to step `await_name`
// ---------------------------------------------------------------------------

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'wh_add_flow') return false;
  if (session.step !== 'await_name') return false;
  const raw = (msg.text || '').trim();
  if (raw.startsWith('/')) return false; // let commands like /menu pass through

  const chatId = msg.chat.id;
  const name = canonicalizeWarehouseName(raw);

  if (name.length < MIN_NAME_LEN) {
    await renderError(bot, chatId, userId, 'Name is empty after trimming. Please type a real name.');
    return true;
  }
  if (name.length > MAX_NAME_LEN) {
    await renderError(bot, chatId, userId, `Name is ${name.length} chars; max is ${MAX_NAME_LEN}.`);
    return true;
  }
  if (!NAME_RE.test(name)) {
    await renderError(bot, chatId, userId,
      'Only letters, digits, spaces, and hyphens are allowed.\nExamples: `Kano`, `Lagos Main`, `Aba-North`.');
    return true;
  }

  // Dedup against the MERGED list (Inventory-derived ∪ WAREHOUSE_LIST).
  // This catches the edge case where a name exists only as Inventory rows
  // but isn't in the settings CSV — the old check missed it.
  const { lower } = await listMergedWarehouses();
  if (lower.has(name.toLowerCase())) {
    await renderError(bot, chatId, userId,
      `Warehouse \`${name}\` already exists.\nPick a different name or cancel.`);
    return true;
  }

  session.name = name;
  session.step = 'await_confirm';
  sessionStore.set(userId, session);

  await render(bot, chatId, userId,
    `Confirm new warehouse:\n\n• Name: *${name}*\n\n_On submit: queued for 2nd-admin approval. Once approved, the name appears in every picker (Receive Goods, Bulk Receive, Photo Receive)._`,
    [
      [{ text: '✅ Submit for approval', callback_data: 'wh:submit' }],
      [{ text: '⬅ Back (change name)', callback_data: 'wh:back' }],
      cancelRow(),
    ],
  );
  return true;
}

// ---------------------------------------------------------------------------
// Callback dispatcher
// ---------------------------------------------------------------------------

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('wh:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'wh_add_flow') return false;

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  if (data === 'wh:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '❌ Cancelled.', []);
    return true;
  }

  if (data === 'wh:back' || data === 'wh:retry') {
    session.step = 'await_name';
    session.name = '';
    sessionStore.set(userId, session);
    await render(bot, chatId, userId,
      `Type the *new warehouse name* (reply in chat).\n_1–${MAX_NAME_LEN} chars · letters / digits / spaces / hyphens._`,
      [cancelRow()],
    );
    return true;
  }

  if (data === 'wh:submit') {
    if (!session.name) {
      await renderError(bot, chatId, userId, 'No name in session. Tap Back and type a name.');
      return true;
    }
    await submit(bot, chatId, userId);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Submit → approval queue
// ---------------------------------------------------------------------------

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'wh_add_flow') return;
  const name = session.name;
  const aj = { action: 'add_warehouse', name };
  const risk = await riskEvaluate.evaluate({ action: 'add_warehouse', userId });
  const requestId = idGenerator.requestId();
  await approvalQueueRepository.append({
    requestId, user: userId, actionJSON: aj,
    riskReason: risk.reason || 'dual_admin_required', status: 'pending',
  });
  await auditLogRepository.append('approval_queued', { requestId, reason: risk.reason, name }, userId);

  const isAdm = auth.isAdmin(userId);
  const excludeId = isAdm ? userId : undefined;
  await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, String(userId),
    `🏭 Add warehouse: ${name}`, risk.reason, excludeId);

  // UX-C1: render success card BEFORE clearing — same lesson as
  // procurementPlanView.submitNewPO. Otherwise the user gets silence.
  await render(bot, chatId, userId,
    `⏳ *Submitted for approval*\n\n• Warehouse: *${name}*\n• Request: \`${requestId}\`\n• Approver: 2nd admin (you cannot self-approve)\n\n_You'll get a notification when approved. The name will appear in every picker once it's in._`,
    [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]],
  );
  sessionStore.clear(userId);
  logger.info(`warehouseFlow.submit: queued add_warehouse name=${name} request=${requestId} by=${userId}`);
}

module.exports = {
  start,
  handleCallback,
  handleText,
  canonicalizeWarehouseName,
  listMergedWarehouses,
  // Internals exposed for smoke tests only.
  _NAME_RE: NAME_RE,
  _MAX_NAME_LEN: MAX_NAME_LEN,
};
