/**
 * Strict Add-stock-via-CSV flow (TCSI-2).
 *
 * Sits ALONGSIDE upstream's Bulk Receive Goods (P2.5) — does NOT replace it.
 * Coexistence:
 *   - "Add stock" (this flow)    → strict R1/R2 inventory conflict block
 *   - "📤 Bulk Receive (CSV/XLSX)" (upstream) → unchanged, lenient model
 *
 * Stages (admin-only):
 *   1. start                       → render warehouse picker
 *   2. addstock:wh:<wh>            → save warehouse, prompt for CSV upload
 *   3. addstock:wh:NEW             → prompt for typed name → re-enters stage 2
 *   4. handleDocument              → download, parse via upstream csvParser,
 *                                    inject warehouse if CSV omits it,
 *                                    reject if CSV warehouse mismatches picked,
 *                                    validate via upstream bulkValidator,
 *                                    run R1/R2 inventory scan,
 *                                    block-and-report OR hand off to upstream
 *                                    submit() by mutating session to type
 *                                    'bulk_receive_flow' + step 'await_submit'
 *                                    and emitting a `br:submit` button.
 *   5. addstock:retry              → re-prompt for CSV (warehouse preserved)
 *   6. addstock:cancel             → clear session
 *
 * Why hand-off (vs duplicate submit logic): the upstream `submit()` handles
 * dual-admin approval queueing, audit logging, and approver notifications.
 * Once our session is the right shape and we emit `br:submit`, the existing
 * `bulkReceiveFlow.handleCallback` picks it up naturally. Zero duplication.
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const inventoryRepository = require('../repositories/inventoryRepository');
const auth = require('../middlewares/auth');
const auditLogRepository = require('../repositories/auditLogRepository');
const goodsReceiptsRepo = require('../repositories/goodsReceiptsRepository');
const settingsRepository = require('../repositories/settingsRepository');
const stockImportService = require('../services/stockImportService');
const { parseCsv } = require('../utils/csvParser');
const bulkValidator = require('../utils/bulkRowValidator');
const { downloadTelegramFile } = require('../utils/telegramFiles');
const { fmtQty } = require('../utils/format');
const logger = require('../utils/logger');

const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_WAREHOUSE_NAME_LEN = 40;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// PL-1: .xlsx accepted for DIRECT supplier packing-list uploads (auto-detected
// layout); a non-packing-list .xlsx is still pointed at Bulk Receive.
const ACCEPTED_EXTS = new Set(['csv', 'xlsx']);
// PL-1: whole-container uploads far exceed the 500-row CSV cap; the approval
// payload is staged to disk above STAGE threshold (see bulkReceiveFlow).
const PL_MAX_ROWS = 6000;

const SESSION_AWAIT_WAREHOUSE   = 'add_stock:awaiting_warehouse';
const SESSION_AWAIT_NEW_WH_NAME = 'add_stock:awaiting_new_warehouse_name';
const SESSION_AWAIT_FILE        = 'add_stock:awaiting_file';
const SESSION_CONFLICT_BLOCKED  = 'add_stock:conflict_blocked';

// ─── public surface ────────────────────────────────────────────────────────

async function start({ bot, chatId, userId }) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId,
      '🔒 *Add stock* is admin-only.\n\n' +
      'Ask an admin to add for you, OR use *📤 Bulk Receive (CSV/XLSX)* ' +
      'from the Stock menu (open to all employees, dual-admin gated).',
      { parse_mode: 'Markdown' });
    return;
  }
  // Never fail silently — the mode tap was already ACKed by the controller,
  // so an unreported throw here looks like a dead bot to the operator.
  try {
    await _renderWarehousePicker(bot, chatId, userId);
  } catch (err) {
    logger?.error?.(`[addStockFlow] start failed: ${err.message}`);
    try {
      await bot.sendMessage(chatId, `🚫 Add stock could not open (${err.message}). Type "Add stock" or tap the tile to retry.`);
    } catch (_) { /* chat unreachable — nothing more we can do */ }
  }
}

async function handleCallback(bot, callbackQuery) {
  const data = (callbackQuery.data || '').trim();
  if (!data.startsWith('addstock:')) return false;

  const chatId = callbackQuery.message.chat.id;
  const userId = String(callbackQuery.from.id);

  if (!auth.isAdmin(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Admin-only.', show_alert: true });
    return true;
  }

  try {
    if (data === 'addstock:cancel') {
      sessionStore.clear(userId);
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Cancelled.' });
      await _editToPlainText(bot, callbackQuery.message, '❌ Add-stock cancelled. No stock was added.');
      return true;
    }

    if (data === 'addstock:retry') {
      const session = sessionStore.get(userId);
      const warehouse = session?.warehouse;
      if (!warehouse) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Type "Add stock" to restart.', show_alert: true });
        return true;
      }
      _setSession(userId, { type: SESSION_AWAIT_FILE, warehouse });
      await bot.answerCallbackQuery(callbackQuery.id);
      await _promptForFile(bot, chatId, warehouse);
      return true;
    }

    if (data === 'addstock:wh:NEW') {
      _setSession(userId, { type: SESSION_AWAIT_NEW_WH_NAME });
      await bot.answerCallbackQuery(callbackQuery.id);
      await _editToPlainText(bot, callbackQuery.message,
        `🏭 Type the new warehouse name (max ${MAX_WAREHOUSE_NAME_LEN} chars):`);
      return true;
    }

    // Index-based pick (current cards). The name list was stored in the
    // session by the picker; expiry means the indexes are meaningless.
    if (data.startsWith('addstock:whi:')) {
      const session = sessionStore.get(userId);
      const idx = parseInt(data.slice('addstock:whi:'.length), 10);
      const warehouse = session && Array.isArray(session.warehouses) ? session.warehouses[idx] : null;
      if (!warehouse) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Type "Add stock" to restart.', show_alert: true });
        return true;
      }
      _setSession(userId, { type: SESSION_AWAIT_FILE, warehouse });
      await bot.answerCallbackQuery(callbackQuery.id, { text: `→ ${warehouse}` });
      await _editToPlainText(bot, callbackQuery.message, `🏭 Target warehouse: *${warehouse}*`, { parse_mode: 'Markdown' });
      await _promptForFile(bot, chatId, warehouse);
      return true;
    }

    // Legacy name-based pick (cards sent before the whi: upgrade).
    if (data.startsWith('addstock:wh:')) {
      const warehouse = data.slice('addstock:wh:'.length);
      _setSession(userId, { type: SESSION_AWAIT_FILE, warehouse });
      await bot.answerCallbackQuery(callbackQuery.id, { text: `→ ${warehouse}` });
      await _editToPlainText(bot, callbackQuery.message, `🏭 Target warehouse: *${warehouse}*`, { parse_mode: 'Markdown' });
      await _promptForFile(bot, chatId, warehouse);
      return true;
    }
  } catch (err) {
    logger?.error?.(`[addStockFlow] callback error: ${err.message}`);
    try { await bot.answerCallbackQuery(callbackQuery.id, { text: 'Error. Type "Add stock" to restart.', show_alert: true }); } catch (_) {}
    sessionStore.clear(userId);
    return true;
  }
  return false;
}

/**
 * Called from telegramController.handleFileMessage when a document arrives
 * during an active add_stock:awaiting_file session.
 */
async function handleDocument({ bot, chatId, userId, msg, session }) {
  if (!session || session.type !== SESSION_AWAIT_FILE) return false;

  const doc = msg.document;
  if (!doc) {
    await bot.sendMessage(chatId, '📎 Please send a *.csv file* as a document attachment (not as text or photo).',
      { parse_mode: 'Markdown', reply_markup: _retryKeyboard() });
    return true;
  }

  const fileName = (doc.file_name || 'upload').trim();
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (!ACCEPTED_EXTS.has(ext)) {
    await bot.sendMessage(chatId,
      `🚫 Only .csv or .xlsx accepted (got .${ext || 'unknown'}).`,
      { parse_mode: 'Markdown', reply_markup: _retryKeyboard() });
    return true;
  }
  if (doc.file_size && doc.file_size > MAX_FILE_BYTES) {
    await bot.sendMessage(chatId,
      `🚫 File too large (${Math.round(doc.file_size / 1024)} KB > ${MAX_FILE_BYTES / 1024} KB).`,
      { reply_markup: _retryKeyboard() });
    return true;
  }

  await bot.sendMessage(chatId, '⏳ Parsing file…');

  let buffer;
  try {
    const fetched = await downloadTelegramFile(bot, doc.file_id);
    buffer = fetched.buffer;
  } catch (err) {
    logger?.error?.(`[addStockFlow] download failed: ${err.message}`);
    await bot.sendMessage(chatId, `🚫 Could not download the file: ${err.message}`,
      { reply_markup: _retryKeyboard() });
    return true;
  }

  // File-hash idempotency — match upstream behaviour so the same file
  // can't be imported twice across either flow.
  const hash = bulkValidator.fileHash(buffer);
  try {
    const dup = await goodsReceiptsRepo.getByFileHash(hash);
    if (dup) {
      await bot.sendMessage(chatId,
        `🚫 This file was already imported as \`${dup.grn_id}\` on ${(dup.received_at || '').split('T')[0]}.\n` +
        `_Hash:_ \`${hash}\``,
        { parse_mode: 'Markdown', reply_markup: _retryKeyboard() });
      return true;
    }
  } catch (e) {
    logger?.warn?.(`[addStockFlow] file_hash dedup read failed (continuing): ${e.message}`);
  }

  // PL-1: an .xlsx is only accepted when it IS a recognizable supplier
  // packing list — the bot converts it to than rows itself. Any other
  // xlsx keeps the historical pointer to Bulk Receive.
  let parsed;
  let plSummary = null;
  if (ext === 'xlsx') {
    let detected = null;
    let pl = null;
    try {
      const XLSX = require('xlsx');
      const plImport = require('../services/packingListImportService');
      detected = plImport.detect(XLSX.read(buffer, { type: 'buffer' }));
      if (detected) pl = plImport.transform(detected);
    } catch (err) {
      logger?.error?.(`[addStockFlow] packing-list parse failed: ${err.message}`);
    }
    if (!pl) {
      await bot.sendMessage(chatId,
        '🚫 This .xlsx is not a recognizable supplier packing list.\n' +
        'For plain tables use *📤 Bulk Receive (CSV/XLSX)* or the CSV template.',
        { parse_mode: 'Markdown', reply_markup: _retryKeyboard() });
      return true;
    }
    if (!pl.thans.length) {
      await bot.sendMessage(chatId, '🚫 Packing list recognized but contains no sellable bales.',
        { parse_mode: 'Markdown', reply_markup: _retryKeyboard() });
      return true;
    }
    plSummary = pl.summary;
    parsed = {
      ok: true,
      headers: ['packageno', 'thanno', 'design', 'shade', 'yards', 'indent', 'csno', 'supplier'],
      rows: pl.thans.map((t, i) => ({
        packageno: t.packageNo, thanno: String(t.thanNo), design: t.design,
        shade: t.shade, yards: String(t.yards), indent: t.indent, csno: t.csNo,
        supplier: pl.supplier || '', _rowNum: i + 2,
      })),
    };
  } else {
    // Parse with upstream parser (handles BOM, quoted fields, etc.).
    parsed = parseCsv(buffer.toString('utf8'));
    if (!parsed.ok) {
      await bot.sendMessage(chatId, `🚫 Could not parse: ${parsed.error}\nFix and re-upload.`,
        { reply_markup: _retryKeyboard() });
      return true;
    }
  }

  // Inject the picked warehouse into rows that omit it, OR reject mismatches.
  const injected = _enforceWarehouseColumn(parsed, session.warehouse);
  if (injected.mismatches.length) {
    const sample = injected.mismatches.slice(0, 10)
      .map((m) => `  • Row ${m.row}: \`${m.found}\``).join('\n');
    const moreNote = injected.mismatches.length > 10 ? `\n  _…and ${injected.mismatches.length - 10} more_` : '';
    await bot.sendMessage(chatId,
      `🚫 *Warehouse mismatch* — you picked *${session.warehouse}* but the CSV has different warehouse(s):\n\n${sample}${moreNote}\n\n` +
      'Either fix the CSV to use only the picked warehouse, or restart with the right warehouse.',
      { parse_mode: 'Markdown', reply_markup: _retryKeyboard() });
    return true;
  }

  // Validate via upstream validator (PackageNo+ThanNo uniqueness, per-bale
  // uniformity, header presence, row count, etc).
  const allowedWarehouses = await _listAllowedWarehouses();
  // Include the picked warehouse in the allow-list so a brand-new one
  // typed by admin passes the registered-warehouse check.
  const allowed = Array.from(new Set([...allowedWarehouses, session.warehouse]));
  const verdict = bulkValidator.validate(injected.parsed, {
    // PL-1: a whole container in one file legitimately exceeds the CSV cap.
    maxRows: plSummary ? PL_MAX_ROWS : bulkValidator.MAX_ROWS_DEFAULT,
    allowedWarehouses: allowed,
  });

  if (!verdict.ok) {
    await bot.sendMessage(chatId, _formatValidatorErrors(verdict.errors),
      { parse_mode: 'Markdown', reply_markup: _retryKeyboard() });
    return true;
  }

  // Single-warehouse check (defence in depth — we already injected, but in
  // case of any drift the validator's summary tells the truth).
  if (verdict.summary.warehouses.length !== 1
      || !_eqCi(verdict.summary.warehouses[0], session.warehouse)) {
    await bot.sendMessage(chatId,
      `🚫 Internal warehouse mismatch — expected only *${session.warehouse}*, found: ${verdict.summary.warehouses.join(', ')}.`,
      { parse_mode: 'Markdown', reply_markup: _retryKeyboard() });
    return true;
  }
  if (verdict.summary.suppliers.length > 1) {
    await bot.sendMessage(chatId,
      `🚫 File mixes ${verdict.summary.suppliers.length} suppliers: ${verdict.summary.suppliers.join(', ')}.\nUse one supplier per upload.`,
      { parse_mode: 'Markdown', reply_markup: _retryKeyboard() });
    return true;
  }

  // STRICT R1+R2 inventory scan.
  let existing;
  try {
    existing = await stockImportService.getInventorySnapshot();
  } catch (err) {
    logger?.error?.(`[addStockFlow] inventory snapshot failed: ${err.message}`);
    await bot.sendMessage(chatId, `🚫 Could not read existing inventory: ${err.message}`,
      { reply_markup: _retryKeyboard() });
    return true;
  }

  const scan = stockImportService.detectInventoryConflicts(
    session.warehouse, verdict.bales, existing);

  if (!scan.ok) {
    _setSession(userId, { type: SESSION_CONFLICT_BLOCKED, warehouse: session.warehouse });
    await _auditOutcome(userId, 'conflict_blocked', {
      warehouse: session.warehouse,
      rowCount: verdict.summary.totalThans,
      r1: scan.r1.length, r2: scan.r2.length,
    });
    await bot.sendMessage(chatId, _formatConflictReport(session.warehouse, scan, verdict.summary),
      { parse_mode: 'Markdown', reply_markup: _retryKeyboard() });
    return true;
  }

  // Clean — mutate session into the upstream bulk_receive_flow shape so the
  // existing `br:submit` callback path can complete the dual-admin queue.
  // We deliberately skip Drive archive in v1 (deferred enhancement); the
  // file hash is still recorded for idempotency.
  sessionStore.set(userId, {
    type: 'bulk_receive_flow',
    step: 'await_submit',
    flowMessageId: null,
    po_id: '__skip__',
    fileName,
    fileExt: ext,
    fileHash: hash,
    fileSize: buffer.length,
    archivedPath: '',
    driveLink: '',
    driveFileId: '',
    sourceFilename: '',
    summary: verdict.summary,
    bales: verdict.bales,
    startedAt: new Date().toISOString(),
    ttlMs: SESSION_TTL_MS,
    // Marker so the audit log can show this came through the strict flow.
    _strict: { source: plSummary ? 'packing_list' : 'add_stock', conflictScanPassed: true },
  });

  await _auditOutcome(userId, 'preview_ready', {
    warehouse: session.warehouse,
    baleCount: verdict.summary.totalBales,
    thanCount: verdict.summary.totalThans,
    totalYards: verdict.summary.totalYards,
    crossWarehouseNotes: scan.crossWarehouseBaleNotes.length,
  });

  const previewText = (plSummary ? _formatPlBlock(plSummary) + '\n\n' : '')
    + _formatPreview(session.warehouse, verdict.summary, scan.crossWarehouseBaleNotes, hash);
  await bot.sendMessage(chatId, previewText,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        // 'br:submit' is upstream's existing callback — picked up by
        // bulkReceiveFlow.handleCallback to queue the dual-admin approval.
        [{ text: '✅ Submit for approval', callback_data: 'br:submit' }],
        [{ text: '🔄 Re-upload different file', callback_data: 'addstock:retry' }],
        [{ text: '❌ Cancel', callback_data: 'br:cancel' }],
      ] },
    });
  return true;
}

/**
 * Handle text replies during the typing-new-warehouse step OR reminders
 * during awaiting-file / conflict-blocked stages.
 */
async function handleTextMessage({ bot, chatId, userId, text, session }) {
  if (!session) return false;

  if (session.type === SESSION_AWAIT_NEW_WH_NAME) {
    const name = (text || '').trim().replace(/\s+/g, ' ');
    if (!name) {
      await bot.sendMessage(chatId, '🏭 Type the new warehouse name (or tap Cancel).',
        { reply_markup: _cancelOnlyKeyboard() });
      return true;
    }
    if (name.length > MAX_WAREHOUSE_NAME_LEN) {
      await bot.sendMessage(chatId,
        `🚫 Warehouse name too long (${name.length} chars). Max ${MAX_WAREHOUSE_NAME_LEN}. Try a shorter name:`,
        { reply_markup: _cancelOnlyKeyboard() });
      return true;
    }
    _setSession(userId, { type: SESSION_AWAIT_FILE, warehouse: name });
    await bot.sendMessage(chatId, `🏭 Target warehouse: *${name}* (new)`, { parse_mode: 'Markdown' });
    await _promptForFile(bot, chatId, name);
    return true;
  }

  if (session.type === SESSION_AWAIT_FILE) {
    await bot.sendMessage(chatId,
      `📎 Waiting for a .csv file for *${session.warehouse}*. Send it as a document attachment, or tap Cancel.`,
      { parse_mode: 'Markdown', reply_markup: _cancelOnlyKeyboard() });
    return true;
  }

  if (session.type === SESSION_CONFLICT_BLOCKED) {
    await bot.sendMessage(chatId,
      'Last upload was blocked by conflicts. Tap 🔄 Try again to re-upload, or ❌ Cancel.',
      { reply_markup: _retryKeyboard() });
    return true;
  }

  return false;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function _setSession(userId, data) {
  sessionStore.set(userId, { ...data, ttlMs: SESSION_TTL_MS, step: data.type });
}

function _eqCi(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }

async function _listAllowedWarehouses() {
  try {
    const fromInv = await inventoryRepository.getWarehouses();
    const fromSet = await settingsRepository.getAll();
    const extra = ((fromSet || {}).WAREHOUSE_LIST || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    return Array.from(new Set([...(fromInv || []), ...extra])).sort();
  } catch (_) {
    return [];
  }
}

/**
 * If CSV rows omit a Warehouse column or value, inject the picked warehouse.
 * If they have a Warehouse column with a value that doesn't match the picked
 * one, collect the mismatch (we'll reject before validation).
 */
function _enforceWarehouseColumn(parsed, pickedWarehouse) {
  const headers = parsed.headers || [];
  const rows = parsed.rows || [];
  const hasWhCol = headers.includes('warehouse');
  const mismatches = [];

  const newHeaders = hasWhCol ? headers : [...headers, 'warehouse'];
  const newRows = rows.map((row) => {
    const v = (row.warehouse || '').toString().trim();
    if (!v) {
      return { ...row, warehouse: pickedWarehouse };
    }
    if (!_eqCi(v, pickedWarehouse)) {
      mismatches.push({ row: row._rowNum, found: v });
    }
    return row;
  });

  return {
    parsed: { ok: true, headers: newHeaders, rows: newRows },
    mismatches,
  };
}

async function _renderWarehousePicker(bot, chatId, userId) {
  // WH-C2: list the MERGED registry (Inventory-derived ∪ Settings
  // WAREHOUSE_LIST) — a freshly registered warehouse has no stock rows yet,
  // so the Inventory-only list hid it (owner hit this with IDUMOTA store:
  // registered via dual-admin add_warehouse, invisible in this picker).
  // _listAllowedWarehouses is the same source the validator trusts.
  let warehouses = [];
  try {
    warehouses = await _listAllowedWarehouses();
  } catch (err) {
    logger?.error?.(`[addStockFlow] warehouse list failed: ${err.message}`);
  }

  // Index-based callbacks: a warehouse name > 52 chars would push raw
  // `addstock:wh:<name>` past Telegram's 64-byte callback_data cap, which
  // rejects the ENTIRE message (silent dead picker). Indexes are immune;
  // the name list rides in the session. Legacy wh:<name> taps still work.
  const rows = [];
  for (let i = 0; i < warehouses.length; i += 2) {
    const chunk = warehouses.slice(i, i + 2).map((w, j) => ({
      text: `🏭 ${w}`,
      callback_data: `addstock:whi:${i + j}`,
    }));
    rows.push(chunk);
  }
  rows.push([{ text: '➕ New warehouse', callback_data: 'addstock:wh:NEW' }]);
  rows.push([{ text: '❌ Cancel',        callback_data: 'addstock:cancel' }]);

  _setSession(userId, { type: SESSION_AWAIT_WAREHOUSE, warehouses });
  const text = '🏭 *Add stock — which warehouse?*\n\n' +
    'Strict mode: this flow blocks duplicate bale # or design # in the chosen warehouse.\n' +
    'For the lenient model (batch-aware via bale-uid) use *📤 Bulk Receive (CSV/XLSX)* from the Stock menu.';
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } });
  } catch (err) {
    // Markdown or keyboard rejected — degrade to plain text, never silence.
    logger?.warn?.(`[addStockFlow] picker send failed (${err.message}); retrying plain`);
    await bot.sendMessage(chatId, text.replace(/\*/g, ''), { reply_markup: { inline_keyboard: rows } });
  }
}

async function _promptForFile(bot, chatId, warehouse) {
  await bot.sendMessage(chatId,
    `📎 *Send the inventory CSV* as a file attachment now.\n\n` +
    `*Target:* ${warehouse}\n\n` +
    '*One row = one than.* A bale with N thans uses N consecutive rows sharing the same `PackageNo`.\n\n' +
    'Required columns: `PackageNo`, `ThanNo`, `Design`, `Yards`\n' +
    'Optional: `Shade`, `Supplier`, `NetMtrs`, `NetWeight`, `Notes`, `Color`, `Warehouse` _(auto-set to ' + warehouse + ' if omitted)_',
    { parse_mode: 'Markdown', reply_markup: _cancelOnlyKeyboard() });
}

function _cancelOnlyKeyboard() {
  return { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'addstock:cancel' }]] };
}

function _retryKeyboard() {
  return { inline_keyboard: [[
    { text: '🔄 Try again', callback_data: 'addstock:retry' },
    { text: '❌ Cancel',    callback_data: 'addstock:cancel' },
  ]] };
}

async function _editToPlainText(bot, message, text, opts = {}) {
  try {
    await bot.editMessageText(text, {
      chat_id: message.chat.id, message_id: message.message_id,
      reply_markup: { inline_keyboard: [] },
      ...opts,
    });
  } catch (_) {
    await bot.sendMessage(message.chat.id, text, opts);
  }
}

function _formatValidatorErrors(errors) {
  const head = `🚫 *File rejected — ${errors.length} error${errors.length === 1 ? '' : 's'}:*\n`;
  const shown = errors.slice(0, 15).map((e) => {
    const where = e.row ? `Row ${e.row}` : 'File';
    const col = e.column ? ` · ${e.column}` : '';
    return `  • ${where}${col}: ${e.message}`;
  }).join('\n');
  const more = errors.length > 15 ? `\n  _…and ${errors.length - 15} more — fix above first._` : '';
  return head + shown + more + '\n\nFix and re-upload.';
}

/**
 * PL-1 — short owner-facing summary of what the packing list converts to,
 * shown ABOVE the standard strict preview.
 */
function _formatPlBlock(pl) {
  const lines = [
    '📦 *Packing list recognized — converted automatically*',
    `New packages: *${fmtQty(pl.bales)} bales / ${fmtQty(pl.thans)} thans / ${fmtQty(pl.yards, { maxFraction: 2 })} yards*`,
    `Designs (${pl.designs.length}): ${pl.designs.slice(0, 6).join(', ')}${pl.designs.length > 6 ? '…' : ''}`,
  ];
  if (pl.indents.length) lines.push(`Indents: ${pl.indents.join(', ')}`);
  if (pl.excluded.length) {
    lines.push(`Excluded (not for sale): ${pl.excluded.map((e) => e.carton).join(', ')}`);
  }
  if (pl.thanCountFix.length) {
    lines.push(`⚠️ Than-count corrections (yardage cells trusted): ${pl.thanCountFix.length} bale(s)`);
  }
  if (pl.yardMismatch.length) {
    lines.push(`⚠️ Yard-total mismatches (cell sums used): ${pl.yardMismatch.length}`);
  }
  if (pl.dupCartons.length) {
    lines.push(`⚠️ Duplicate cartons in file (first kept): ${pl.dupCartons.join(', ')}`);
  }
  if (pl.noYardCells.length) {
    lines.push(`⚠️ Skipped, no yardage cells: ${pl.noYardCells.join(', ')}`);
  }
  return lines.join('\n');
}

function _formatConflictReport(warehouse, scan, summary) {
  const parts = [`🚫 *Import blocked* — conflicts found in ${summary.totalBales} bale(s) / ${summary.totalThans} than(s)\n`];

  if (scan.r1.length) {
    parts.push(`*Rule R1: Bale # already exists in ${warehouse}* (${scan.r1.length})`);
    for (const c of scan.r1.slice(0, 15)) {
      parts.push(`  • Bale \`${c.packageNo}\` (row ${c.csvLine}) — already in ${warehouse} as ` +
        `design \`${c.existing.design}\`/shade \`${c.existing.shade}\`` +
        (c.existing.dateReceived ? ` (rcvd ${c.existing.dateReceived})` : '') +
        ` — ${c.existing.availableThans}/${c.existing.totalThans} thans available`);
    }
    if (scan.r1.length > 15) parts.push(`  _…and ${scan.r1.length - 15} more_`);
    parts.push('');
  }

  if (scan.r2.length) {
    parts.push(`*Rule R2: Design already exists in ${warehouse}* (${scan.r2.length})`);
    for (const c of scan.r2.slice(0, 15)) {
      parts.push(`  • Design \`${c.design}\` (row ${c.csvLine}) — ${c.existing.baleCount} bale(s) ` +
        `(${c.existing.availableThans}/${c.existing.totalThans} thans available, rcvd ${c.existing.dateRange})`);
    }
    if (scan.r2.length > 15) parts.push(`  _…and ${scan.r2.length - 15} more_`);
    parts.push('');
  }

  parts.push('*Nothing was added.* Please:');
  parts.push('  1. Verify the CSV against existing ' + warehouse + ' stock');
  parts.push('  2. Fix the duplicates / typos');
  parts.push('  3. Re-upload');
  return parts.join('\n');
}

function _formatPreview(warehouse, s, crossNotes, hash) {
  const lines = [
    '✅ *Conflict scan passed — review and submit*',
    '',
    `*Warehouse:* ${warehouse}`,
    `*Supplier:*  ${s.suppliers[0] || '_none_'}`,
    `*Designs:*   ${s.designs.length} (${s.designs.slice(0, 4).join(', ')}${s.designs.length > 4 ? '…' : ''})`,
    `*Bales:*     ${fmtQty(s.totalBales)}`,
    `*Thans:*     ${fmtQty(s.totalThans)}`,
    `*Yards:*     ${fmtQty(s.totalYards, { maxFraction: 2 })}`,
  ];
  if (s.totalNetMtrs > 0) lines.push(`*Net m:*      ${fmtQty(s.totalNetMtrs, { maxFraction: 2 })}`);
  if (s.totalNetWeight > 0) lines.push(`*Net kg:*     ${fmtQty(s.totalNetWeight, { maxFraction: 2 })}`);
  lines.push(`*Hash:*      \`${hash}\``);

  if (crossNotes && crossNotes.length) {
    lines.push('');
    lines.push(`ℹ️ ${crossNotes.length} bale #(s) also exist in *other* warehouses (treated as separate physical bales — not a conflict):`);
    for (const n of crossNotes.slice(0, 8)) {
      lines.push(`  • Bale \`${n.packageNo}\` also in: ${n.existingWarehouses.join(', ')}`);
    }
    if (crossNotes.length > 8) lines.push(`  _…and ${crossNotes.length - 8} more_`);
  }

  lines.push('');
  lines.push(`_${s.totalThans} thans across ${s.totalBales} bale${s.totalBales === 1 ? '' : 's'} will be appended on dual-admin approval._`);
  return lines.join('\n');
}

async function _auditOutcome(userId, outcome, meta) {
  try {
    await auditLogRepository.append('add_stock', { outcome, ...meta }, userId);
  } catch (_) { /* non-fatal */ }
}

module.exports = {
  start,
  handleCallback,
  handleDocument,
  handleTextMessage,
  _internals: {
    _enforceWarehouseColumn,
    SESSION_AWAIT_FILE,
    SESSION_AWAIT_NEW_WH_NAME,
    MAX_WAREHOUSE_NAME_LEN,
  },
};
