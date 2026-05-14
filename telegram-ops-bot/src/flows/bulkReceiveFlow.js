/**
 * Bulk Receive Goods flow — P2.5.
 *
 * Abdul (inventory manager) uploads a CSV or XLSX of incoming bales; the
 * bot parses, validates, previews, then queues a dual-admin approval.
 * On approval the bales are appended to Inventory with fresh bale_uid +
 * addedAt (composite key from P1), and a single GoodsReceipts header is
 * written with `source='bulk_csv'|'bulk_xlsx'` and `file_hash` so the
 * same file can't be imported twice.
 *
 * Steps:
 *   1. PO link (optional)    — pick a PO or skip
 *   2. File upload            — send CSV/XLSX as a Telegram document
 *   3. Preview + Submit       — bot shows summary, user confirms
 *   4. Approval queue         — dual-admin (requester != approver)
 *   5. Persist on approval    — service handler (inventoryService)
 *
 * Session shape (`type: 'bulk_receive_flow'`):
 *   {
 *     step: 'await_po' | 'await_file' | 'await_submit' | 'submitted',
 *     flowMessageId: number,
 *     po_id: string,
 *     fileName: string,
 *     fileExt: 'csv' | 'xlsx',
 *     fileHash: string,
 *     archivedPath: string,         // local data/uploads/<hash>.<ext>
 *     summary: { totalBales, totalYards, designs, warehouses, suppliers },
 *     bales: Array<NormalisedBale>,
 *     startedAt: ISO,
 *   }
 *
 * Callback namespace `br:*`
 *   br:po:<po_id>     pin a PO
 *   br:po_skip        proceed without a PO
 *   br:submit         submit for dual-admin approval
 *   br:retry          discard parsed file, prompt for re-upload
 *   br:cancel         abandon flow
 */

'use strict';

const fs = require('fs');
const path = require('path');

const sessionStore = require('../utils/sessionStore');
const auth = require('../middlewares/auth');
const config = require('../config');
const idGenerator = require('../utils/idGenerator');
const riskEvaluate = require('../risk/evaluate');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const approvalEvents = require('../events/approvalEvents');
const auditLogRepository = require('../repositories/auditLogRepository');
const goodsReceiptsRepo = require('../repositories/goodsReceiptsRepository');
const procurementOrdersRepo = require('../repositories/procurementOrdersRepository');
const settingsRepository = require('../repositories/settingsRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const { downloadTelegramFile } = require('../utils/telegramFiles');
const { parseCsv } = require('../utils/csvParser');
const { parseXlsx, isAvailable: xlsxAvailable } = require('../utils/xlsxParser');
const bulkValidator = require('../utils/bulkRowValidator');
const { editOrSend } = require('../utils/telegramUI');
const { fmtQty } = require('../utils/format');
const logger = require('../utils/logger');

const UPLOADS_DIR = path.resolve(process.cwd(), 'data', 'uploads');
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB hard cap; 500 rows fits easily
const ACCEPTED_EXTS = new Set(['csv', 'xlsx']);

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function header(session) {
  const lines = ['📤 *Bulk Receive Goods*'];
  if (session.po_id) lines.push(`✓ PO: \`${session.po_id}\``);
  else if (session.po_id === '__skip__') lines.push('✓ PO: _none_');
  if (session.fileName) lines.push(`✓ File: \`${session.fileName}\``);
  if (session.summary) {
    const s = session.summary;
    lines.push(`✓ ${s.totalBales} bales · ${s.totalThans} thans · ${fmtQty(s.totalYards, { maxFraction: 2 })} yards`);
  }
  return lines.join('\n');
}

async function render(bot, chatId, userId, prompt, rows) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = (header(session) + '\n\n' + prompt).trim();
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const mid = session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (_) { /* fall through to send */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  session.flowMessageId = sent.message_id;
  sessionStore.set(userId, session);
}

function cancelRow() { return [{ text: '❌ Cancel', callback_data: 'br:cancel' }]; }

// ---------------------------------------------------------------------------
// Step 1 — Optional PO linkage
// ---------------------------------------------------------------------------

async function start(bot, chatId, userId, messageId = null) {
  sessionStore.set(userId, {
    type: 'bulk_receive_flow', step: 'await_po',
    flowMessageId: messageId || null,
    po_id: '',
    startedAt: new Date().toISOString(),
  });
  await showPoStep(bot, chatId, userId);
}

async function showPoStep(bot, chatId, userId) {
  let openPOs = [];
  try { openPOs = await procurementOrdersRepo.getOpen(); } catch (_) { /* repo absent in dev */ }
  const rows = [];
  for (const po of openPOs.slice(0, 8)) {
    rows.push([{ text: `📋 ${po.po_id} · ${po.supplier || 'no supplier'}`, callback_data: `br:po:${po.po_id}` }]);
  }
  rows.push([{ text: '⏭ Skip (no PO)', callback_data: 'br:po_skip' }]);
  rows.push(cancelRow());
  const prompt = openPOs.length
    ? 'Link this upload to an open *Procurement Order* (optional):'
    : '_No open Procurement Orders._ This upload will be a standalone receipt.';
  await render(bot, chatId, userId, prompt, rows);
}

// ---------------------------------------------------------------------------
// Step 2 — File upload prompt
// ---------------------------------------------------------------------------

async function showAwaitFileStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'await_file';
  sessionStore.set(userId, session);
  const xlsxNote = xlsxAvailable() ? '' : '\n_(.xlsx temporarily unavailable — use .csv)_';
  const prompt = [
    '*Send the file as a document (.csv or .xlsx).*',
    '',
    '*One row = one than.* Bales with N thans use N rows sharing the same PackageNo.',
    '',
    'Required columns: `PackageNo`, `ThanNo`, `Design`, `Yards`, `Warehouse`',
    'Optional: `Shade`, `Supplier`, `NetMtrs`, `NetWeight`, `Notes`, `Color`',
    `Max ${bulkValidator.MAX_ROWS_DEFAULT} rows.${xlsxNote}`,
    '',
    '_Type /bulkformat for a template._',
  ].join('\n');
  await render(bot, chatId, userId, prompt, [
    [{ text: '⬅ Back to PO', callback_data: 'br:back_po' }],
    cancelRow(),
  ]);
}

// ---------------------------------------------------------------------------
// Document received — the real work happens here
// ---------------------------------------------------------------------------

/**
 * Called by the controller when a Telegram document arrives while a
 * bulk-receive session is active.
 *
 * Returns true if the document was consumed by this flow, false to let
 * other handlers try (e.g. receipt OCR for non-bulk-receive contexts).
 */
async function handleDocument(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'bulk_receive_flow') return false;
  if (session.step !== 'await_file') return false;

  const chatId = msg.chat.id;
  const doc = msg.document;
  if (!doc) return false;

  // Filename + extension
  const fileName = (doc.file_name || 'upload').trim();
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (!ACCEPTED_EXTS.has(ext)) {
    await bot.sendMessage(chatId,
      `⚠️ Only .csv and .xlsx accepted (got .${ext}).\nPlease upload the right format.`);
    return true;
  }
  if (doc.file_size && doc.file_size > MAX_FILE_BYTES) {
    await bot.sendMessage(chatId,
      `⚠️ File too large (${Math.round(doc.file_size / 1024)} KB > ${MAX_FILE_BYTES / 1024} KB).\nSplit it up.`);
    return true;
  }

  // Download bytes from Telegram
  let buffer;
  try {
    const fetched = await downloadTelegramFile(bot, doc.file_id);
    buffer = fetched.buffer;
  } catch (e) {
    logger.error(`bulkReceiveFlow.handleDocument fetch: ${e.message}`);
    await bot.sendMessage(chatId, `⚠️ Could not fetch your file: ${e.message}`);
    return true;
  }

  // Parse + validate
  const parseResult = await parseBuffer(buffer, ext);
  if (!parseResult.ok) {
    await bot.sendMessage(chatId, `⚠️ ${parseResult.error}\nFix and re-upload, or tap Cancel.`);
    return true;
  }

  const allowedWarehouses = await listAllowedWarehouses();
  const verdict = bulkValidator.validate(parseResult, {
    maxRows: bulkValidator.MAX_ROWS_DEFAULT,
    allowedWarehouses,
  });

  if (!verdict.ok) {
    await bot.sendMessage(chatId, formatErrorsForChat(verdict.errors), { parse_mode: 'Markdown' });
    return true;
  }

  // File-level constraint: a single GRN = a single warehouse + supplier
  // delivery. Mixed-warehouse files would force us to split into multiple
  // GRNs, which the v1 flow doesn't support — surface the error early.
  if (verdict.summary.warehouses.length > 1) {
    await bot.sendMessage(chatId,
      `⚠️ File mixes ${verdict.summary.warehouses.length} warehouses: ${verdict.summary.warehouses.join(', ')}.\nSplit into one file per warehouse.`);
    return true;
  }
  if (verdict.summary.suppliers.length > 1) {
    await bot.sendMessage(chatId,
      `⚠️ File mixes ${verdict.summary.suppliers.length} suppliers: ${verdict.summary.suppliers.join(', ')}.\nUse one supplier per upload.`);
    return true;
  }

  // Idempotency — check before archiving so a duplicate gets a clean
  // error and doesn't leave a stray file behind.
  const hash = bulkValidator.fileHash(buffer);
  try {
    const dup = await goodsReceiptsRepo.getByFileHash(hash);
    if (dup) {
      await bot.sendMessage(chatId,
        `⚠️ This file was already imported as \`${dup.grn_id}\` on ${dup.received_at.split('T')[0]}.\n_Hash:_ \`${hash}\``,
        { parse_mode: 'Markdown' });
      return true;
    }
  } catch (e) {
    logger.warn(`bulkReceiveFlow: getByFileHash failed (continuing): ${e.message}`);
  }

  // Archive to local disk. We keep the file even if approval is denied —
  // disk is cheap and the file_hash + ApprovalQueue row tell the full
  // story for forensics.
  let archivedPath = '';
  try {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    archivedPath = path.join(UPLOADS_DIR, `${hash}.${ext}`);
    fs.writeFileSync(archivedPath, buffer);
  } catch (e) {
    logger.warn(`bulkReceiveFlow: archive write failed (continuing): ${e.message}`);
  }

  // Update session and show preview
  session.fileName = fileName;
  session.fileExt = ext;
  session.fileHash = hash;
  session.fileSize = buffer.length;
  session.archivedPath = archivedPath;
  session.summary = verdict.summary;
  session.bales = verdict.bales;
  session.step = 'await_submit';
  sessionStore.set(userId, session);

  await showPreviewStep(bot, chatId, userId);
  return true;
}

async function showPreviewStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const s = session.summary;
  const lines = [
    '*Review and submit*',
    '',
    `*Warehouse:* ${s.warehouses[0] || '—'}`,
    `*Supplier:*  ${s.suppliers[0] || '_none_'}`,
    `*Designs:*   ${s.designs.length} (${s.designs.slice(0, 4).join(', ')}${s.designs.length > 4 ? '…' : ''})`,
    `*Bales:*     ${s.totalBales}`,
    `*Thans:*     ${s.totalThans}`,
    `*Yards:*     ${fmtQty(s.totalYards, { maxFraction: 2 })}`,
  ];
  if (s.totalNetMtrs > 0) lines.push(`*Net m:*      ${fmtQty(s.totalNetMtrs, { maxFraction: 2 })}`);
  if (s.totalNetWeight > 0) lines.push(`*Net kg:*     ${fmtQty(s.totalNetWeight, { maxFraction: 2 })}`);
  lines.push(`*Hash:*      \`${session.fileHash}\``);
  lines.push('');
  lines.push(`_${s.totalThans} thans across ${s.totalBales} bale${s.totalBales === 1 ? '' : 's'} will be appended to Inventory with fresh bale_uid + addedAt per row._`);
  if (session.po_id && session.po_id !== '__skip__') {
    lines.splice(1, 0, `*PO:*        \`${session.po_id}\``);
  }
  const rows = [
    [{ text: '✅ Submit for approval', callback_data: 'br:submit' }],
    [{ text: '🔄 Re-upload different file', callback_data: 'br:retry' }],
    cancelRow(),
  ];
  await render(bot, chatId, userId, lines.join('\n'), rows);
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'bulk_receive_flow') return;
  if (!session.summary || !session.bales || !session.bales.length) {
    await render(bot, chatId, userId, '⚠️ Nothing to submit — re-upload the file.',
      [[{ text: '⬅ Back', callback_data: 'br:retry' }], cancelRow()]);
    return;
  }

  const aj = {
    action: 'bulk_receive_goods',
    warehouse: session.summary.warehouses[0] || '',
    supplier: session.summary.suppliers[0] || '',
    po_id: session.po_id && session.po_id !== '__skip__' ? session.po_id : '',
    bales: session.bales.map((b) => ({
      packageNo: b.packageNo,
      thanNo: b.thanNo,
      design: b.design, shade: b.shade, color: b.color,
      yards: b.yards,
      netMtrs: b.netMtrs || 0, netWeight: b.netWeight || 0,
      notes: b.notes,
    })),
    totalBales: session.summary.totalBales,
    totalThans: session.summary.totalThans,
    totalYards: session.summary.totalYards,
    totalNetMtrs: session.summary.totalNetMtrs,
    totalNetWeight: session.summary.totalNetWeight,
    source: session.fileExt === 'xlsx' ? 'bulk_xlsx' : 'bulk_csv',
    fileHash: session.fileHash,
    fileName: session.fileName,
    fileSize: session.fileSize || 0,
    archivedPath: session.archivedPath || '',
    dateReceived: new Date().toISOString().split('T')[0],
    productType: 'fabric',
  };

  // ALWAYS_APPROVAL_ACTIONS — risk.evaluate returns 'approval_required'
  // for both admins and employees; the approval queue + requireApproval
  // path enforces requester != approver.
  const risk = await riskEvaluate.evaluate({ action: 'bulk_receive_goods', userId });
  const requestId = idGenerator.requestId();
  await approvalQueueRepository.append({
    requestId, user: userId, actionJSON: aj, riskReason: risk.reason || 'dual_admin_required', status: 'pending',
  });
  await auditLogRepository.append('approval_queued', {
    requestId, reason: risk.reason, source: aj.source, fileHash: aj.fileHash, bales: aj.totalBales,
  }, userId);

  const isAdm = auth.isAdmin(userId);
  const approverLabel = isAdm ? '2nd admin' : 'admin';
  const excludeId = isAdm ? userId : undefined;
  const summary =
    `📤 Bulk Receive — ${aj.warehouse} · ${aj.totalBales} bales / ${aj.totalThans} thans · ${fmtQty(aj.totalYards, { maxFraction: 2 })} yds`
    + ` · ${aj.source}${aj.po_id ? ' · PO ' + aj.po_id : ''}`;
  await approvalEvents.notifyAdminsApprovalRequest(
    bot, requestId, String(userId), summary, risk.reason, excludeId);

  session.step = 'submitted';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `⏳ Submitted for ${approverLabel} approval.\nRequest: \`${requestId}\`\nHash: \`${aj.fileHash}\``,
    [[{ text: '📤 Upload another', callback_data: 'br:more' }], [{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
  sessionStore.clear(userId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function parseBuffer(buffer, ext) {
  if (ext === 'csv') {
    return parseCsv(buffer.toString('utf8'));
  }
  if (ext === 'xlsx') {
    return parseXlsx(buffer);
  }
  return { ok: false, error: `Unsupported extension .${ext}` };
}

async function listAllowedWarehouses() {
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

function formatErrorsForChat(errors) {
  const head = `⚠️ *File rejected — ${errors.length} error${errors.length === 1 ? '' : 's'}:*\n`;
  const shown = errors.slice(0, 15).map((e) => {
    const where = e.row ? `Row ${e.row}` : 'File';
    const col = e.column ? ` · ${e.column}` : '';
    return `• ${where}${col}: ${e.message}`;
  }).join('\n');
  const more = errors.length > 15 ? `\n_…and ${errors.length - 15} more — fix above first._` : '';
  return head + shown + more + '\n\nFix and re-upload, or tap Cancel.';
}

// ---------------------------------------------------------------------------
// Callback dispatcher
// ---------------------------------------------------------------------------

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith('br:')) return false;
  try { await bot.answerCallbackQuery(callbackQuery.id); } catch (_) { /* noop */ }
  const userId = String(callbackQuery.from.id);
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (data === 'br:cancel') {
    sessionStore.clear(userId);
    await editOrSend(bot, chatId, messageId, '❌ Cancelled.', {});
    return true;
  }
  if (data === 'br:more') {
    await start(bot, chatId, userId, messageId);
    return true;
  }

  const session = sessionStore.get(userId);
  if (!session || session.type !== 'bulk_receive_flow') return false;

  if (data.startsWith('br:po:')) {
    session.po_id = data.slice('br:po:'.length);
    sessionStore.set(userId, session);
    await showAwaitFileStep(bot, chatId, userId);
    return true;
  }
  if (data === 'br:po_skip') {
    session.po_id = '__skip__';
    sessionStore.set(userId, session);
    await showAwaitFileStep(bot, chatId, userId);
    return true;
  }
  if (data === 'br:back_po') {
    session.step = 'await_po';
    sessionStore.set(userId, session);
    await showPoStep(bot, chatId, userId);
    return true;
  }
  if (data === 'br:retry') {
    session.fileName = ''; session.fileExt = ''; session.fileHash = '';
    session.archivedPath = ''; session.summary = null; session.bales = null;
    session.step = 'await_file';
    sessionStore.set(userId, session);
    await showAwaitFileStep(bot, chatId, userId);
    return true;
  }
  if (data === 'br:submit') {
    await submit(bot, chatId, userId);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// `/bulkformat` — return a CSV template Abdul can copy into Excel/Sheets.
// ---------------------------------------------------------------------------

async function sendTemplate(bot, chatId) {
  const csv = [
    'PackageNo,ThanNo,Design,Shade,Yards,NetMtrs,NetWeight,Warehouse,Supplier,Notes',
    '9001,1,Beige Crepe,B-12,50,45.7,18.5,Kano,SupplierA,',
    '9001,2,Beige Crepe,B-12,48,43.8,17.9,Kano,SupplierA,',
    '9001,3,Beige Crepe,B-12,52,47.5,19.2,Kano,SupplierA,',
    '9001,4,Beige Crepe,B-12,50,45.7,18.5,Kano,SupplierA,',
    '9001,5,Beige Crepe,B-12,49,44.8,18.2,Kano,SupplierA,',
  ].join('\n');
  const text = [
    '*Bulk Receive template*',
    '',
    '*One row = one than.* Each bale (PackageNo) lists 1..N thans on consecutive rows.',
    '',
    'Required: `PackageNo`, `ThanNo`, `Design`, `Yards`, `Warehouse`',
    'Optional: `Shade`, `Supplier`, `NetMtrs`, `NetWeight`, `Notes`, `Color`',
    `Max ${bulkValidator.MAX_ROWS_DEFAULT} rows · single warehouse + supplier per file · (PackageNo, ThanNo) unique within file.`,
    '',
    'Sample — one bale, 5 thans:',
    '```',
    csv,
    '```',
    '',
    'Full template + samples: `telegram-ops-bot/docs/samples/`',
  ].join('\n');
  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

module.exports = {
  start,
  handleCallback,
  handleDocument,
  sendTemplate,
  _internals: { parseBuffer, listAllowedWarehouses, formatErrorsForChat, UPLOADS_DIR, MAX_FILE_BYTES },
};
