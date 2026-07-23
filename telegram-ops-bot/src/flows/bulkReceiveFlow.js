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
// FILE-C1: shared archive (local + best-effort Drive) so CSV/XLSX uploads
// get the same human-readable Drive filename and clickable sheet URL as
// photo OCR uploads. Falls back to local-only when Drive isn't configured.
const driveBackup = require('../services/vision/driveBackup');
const usersRepository = require('../repositories/usersRepository');

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

const { cancelRow } = require('../utils/flowKit').rowsFor('br');

/**
 * UX-C1: re-render the anchored flow card with an error message embedded
 * and retry/cancel buttons. Replaces plain `sendMessage` error paths that
 * would land at the bottom of the chat with no inline keyboard, forcing
 * the user to scroll up to find the original flow card.
 */
async function renderError(bot, chatId, userId, errorText) {
  const session = sessionStore.get(userId);
  if (!session) {
    await bot.sendMessage(chatId, errorText, { parse_mode: 'Markdown' });
    return;
  }
  const rows = [
    [{ text: '🔄 Try another file', callback_data: 'br:retry' }],
    [{ text: '⬅ Back to PO', callback_data: 'br:back_po' }],
    cancelRow(),
  ];
  await render(bot, chatId, userId, `⚠️ ${errorText}`, rows);
}

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
    // UX-C1: every error in await_file re-renders the anchored card with
    // a retry/cancel keyboard instead of dropping a bare error at the
    // bottom of the chat with no tappable controls.
    await renderError(bot, chatId, userId,
      `Only .csv and .xlsx accepted (got .${ext}).\nPlease upload the right format.`);
    return true;
  }
  if (doc.file_size && doc.file_size > MAX_FILE_BYTES) {
    await renderError(bot, chatId, userId,
      `File too large (${Math.round(doc.file_size / 1024)} KB > ${MAX_FILE_BYTES / 1024} KB).\nSplit it up.`);
    return true;
  }

  // Download bytes from Telegram
  let buffer;
  try {
    const fetched = await downloadTelegramFile(bot, doc.file_id);
    buffer = fetched.buffer;
  } catch (e) {
    logger.error(`bulkReceiveFlow.handleDocument fetch: ${e.message}`);
    await renderError(bot, chatId, userId, `Could not fetch your file: ${e.message}`);
    return true;
  }

  // Parse + validate
  const parseResult = await parseBuffer(buffer, ext);
  if (!parseResult.ok) {
    await renderError(bot, chatId, userId, `${parseResult.error}\nFix and re-upload, or tap Cancel.`);
    return true;
  }

  const allowedWarehouses = await listAllowedWarehouses();
  const verdict = bulkValidator.validate(parseResult, {
    maxRows: bulkValidator.MAX_ROWS_DEFAULT,
    allowedWarehouses,
  });

  if (!verdict.ok) {
    // formatErrorsForChat already includes the warning glyph; renderError
    // adds its own. Strip the leading sigil to avoid the double "⚠️ ⚠️".
    const body = formatErrorsForChat(verdict.errors).replace(/^⚠️\s*/, '');
    await renderError(bot, chatId, userId, body);
    return true;
  }

  // File-level constraint: a single GRN = a single warehouse + supplier
  // delivery. Mixed-warehouse files would force us to split into multiple
  // GRNs, which the v1 flow doesn't support — surface the error early.
  if (verdict.summary.warehouses.length > 1) {
    await renderError(bot, chatId, userId,
      `File mixes ${verdict.summary.warehouses.length} warehouses: ${verdict.summary.warehouses.join(', ')}.\nSplit into one file per warehouse.`);
    return true;
  }
  if (verdict.summary.suppliers.length > 1) {
    await renderError(bot, chatId, userId,
      `File mixes ${verdict.summary.suppliers.length} suppliers: ${verdict.summary.suppliers.join(', ')}.\nUse one supplier per upload.`);
    return true;
  }

  // Idempotency — check before archiving so a duplicate gets a clean
  // error and doesn't leave a stray file behind.
  const hash = bulkValidator.fileHash(buffer);
  try {
    const dup = await goodsReceiptsRepo.getByFileHash(hash);
    if (dup) {
      await renderError(bot, chatId, userId,
        `This file was already imported as \`${dup.grn_id}\` on ${dup.received_at.split('T')[0]}.\n_Hash:_ \`${hash}\``);
      return true;
    }
  } catch (e) {
    logger.warn(`bulkReceiveFlow: getByFileHash failed (continuing): ${e.message}`);
  }

  // FILE-C1: archive locally AND best-effort to Drive, with a human-
  // readable Drive filename built from uploader + date + original name
  // + 8-char hash. Even if approval is denied, the file stays on disk
  // for forensics, and the Drive row + file_hash + ApprovalQueue tell
  // the full story end-to-end. Local archive still uses the hash-based
  // path internally — it's a cache, not a human-browsable surface.
  let uploaderName = msg.from.first_name || `user-${userId}`;
  try {
    const u = await usersRepository.findByUserId(userId);
    if (u && u.name) uploaderName = u.name;
  } catch (_) { /* repo absent in dev */ }

  const mime = (ext === 'xlsx')
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv';
  let archive;
  try {
    archive = await driveBackup.archiveFile(buffer, mime, {
      uploader: uploaderName,
      originalName: fileName,
      kind: 'bulk',
    });
  } catch (e) {
    logger.warn(`bulkReceiveFlow: archive failed (continuing local-only): ${e.message}`);
    // Hard-fall-back to a hash path so the rest of the flow has a path
    // to record. Drive metadata stays unset.
    archive = { hash, localPath: '', readableName: '', drive: null };
  }
  // Belt-and-suspenders: ensure the local copy exists even if archiveFile
  // somehow returned an empty path (e.g. in tests with stubbed deps).
  let archivedPath = archive.localPath || '';
  if (!archivedPath) {
    try {
      if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      archivedPath = path.join(UPLOADS_DIR, `${hash}.${ext}`);
      fs.writeFileSync(archivedPath, buffer);
    } catch (e) {
      logger.warn(`bulkReceiveFlow: fallback local archive failed (continuing): ${e.message}`);
    }
  }

  // Update session and show preview
  session.fileName = fileName;
  session.fileExt = ext;
  session.fileHash = hash;
  session.fileSize = buffer.length;
  session.archivedPath = archivedPath;
  // FILE-C1: Drive metadata is the *human-facing* surface; we forward
  // it into the approval payload so the GoodsReceipts row gets a
  // clickable source_url and we can stamp the Drive file description
  // post-approval with the GRN id.
  session.driveLink = archive.drive?.webViewLink || '';
  session.driveFileId = archive.drive?.id || '';
  session.sourceFilename = archive.readableName || '';
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
  // ARRIVAL-BATCH C1 — operator must tag the incoming stock with a container
  // (arrival batch) label, e.g. "July26", so the Supply/Bundle pickers can
  // scope by it. Shown here and required before submit.
  lines.push(`*Container:* ${session.arrivalBatch ? `\`${session.arrivalBatch}\`` : '_— pick below —_'}`);
  lines.push('');
  // "bale-uid", not "bale_uid": a raw underscore inside this _italic_ line
  // gives Telegram an odd underscore count → 400 can't-parse-entities → the
  // whole container card fails to send (found live 13-Jul, byte offset 528).
  lines.push(`_${s.totalThans} thans across ${s.totalBales} bale${s.totalBales === 1 ? '' : 's'} will be appended to Inventory with fresh bale-uid + addedAt per row._`);
  if (session.po_id && session.po_id !== '__skip__') {
    lines.splice(1, 0, `*PO:*        \`${session.po_id}\``);
  }

  const rows = [];
  // Existing containers (with available stock) as one-tap chips, plus a
  // "type new" escape hatch for a brand-new arrival like "July26".
  let existing = [];
  try {
    existing = await inventoryRepository.getArrivalBatches();
  } catch (_) { existing = []; }
  const chipRow = [];
  for (const c of existing.slice(0, 4)) {
    if (c.batch === inventoryRepository.UNLABELLED_BATCH) continue;
    const mark = session.arrivalBatch === c.batch ? '✅ ' : '🚢 ';
    chipRow.push({ text: `${mark}${c.label}`, callback_data: `br:ct:${c.batch}` });
    if (chipRow.length === 2) { rows.push(chipRow.splice(0, 2)); }
  }
  if (chipRow.length) rows.push(chipRow);
  rows.push([{ text: '✏️ Type new container', callback_data: 'br:ct_new' }]);
  if (session.arrivalBatch) {
    rows.push([{ text: '✅ Submit for approval', callback_data: 'br:submit' }]);
  } else {
    lines.push('');
    lines.push('⚠️ _Pick or type a container before submitting._');
  }
  rows.push([{ text: '🔄 Re-upload different file', callback_data: 'br:retry' }]);
  rows.push(cancelRow());
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

  const mappedBales = session.bales.map((b) => ({
    packageNo: b.packageNo,
    thanNo: b.thanNo,
    design: b.design, shade: b.shade, color: b.color,
    yards: b.yards,
    netMtrs: b.netMtrs || 0, netWeight: b.netWeight || 0,
    notes: b.notes,
    // BULK-INDENT — supplier indent + CS number ride through to the
    // Inventory columns so container uploads match hand-entered rows.
    indent: b.indent || '', csNo: b.csNo || '',
  }));

  // PL-1 — a whole-container upload cannot ride inside the ApprovalQueue's
  // ActionJSON cell (~50k char cap). Above the threshold the rows are staged
  // to disk and the approval carries a sha256-verified reference instead.
  // If the bot redeploys before approval the executor fails CLOSED with a
  // clear "re-upload" message — nothing partial is ever written.
  const STAGE_THRESHOLD = 400;
  let balesField = { bales: mappedBales };
  if (mappedBales.length > STAGE_THRESHOLD) {
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const payload = JSON.stringify(mappedBales);
    const sha = crypto.createHash('sha256').update(payload).digest('hex');
    const dir = path.join(__dirname, '../../data/uploads');
    fs.mkdirSync(dir, { recursive: true });
    const stagedPath = path.join(dir, `pl-${sha.slice(0, 16)}.json`);
    fs.writeFileSync(stagedPath, payload);
    balesField = { bales: [], balesStagedPath: stagedPath, stagedSha256: sha, stagedCount: mappedBales.length };
  }

  const aj = {
    action: 'bulk_receive_goods',
    warehouse: session.summary.warehouses[0] || '',
    supplier: session.summary.suppliers[0] || '',
    po_id: session.po_id && session.po_id !== '__skip__' ? session.po_id : '',
    ...balesField,
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
    // FILE-C1: Drive surface — webViewLink lands in GoodsReceipts.source_url,
    // readableName lands in GoodsReceipts.source_filename, driveFileId is
    // used post-approval to stamp the Drive file with the GRN id.
    sourceUrl: session.driveLink || '',
    sourceFilename: session.sourceFilename || '',
    driveFileId: session.driveFileId || '',
    dateReceived: new Date().toISOString().split('T')[0],
    productType: 'fabric',
    // ARRIVAL-BATCH C1 — container label stamped on every appended bale row.
    arrivalBatch: session.arrivalBatch || '',
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
  // APU-1: per-design breakdown + provenance for the approving admins.
  const summary =
    `📤 Bulk Receive — ${aj.warehouse} · ${aj.totalBales} bales / ${aj.totalThans} thans · ${fmtQty(aj.totalYards, { maxFraction: 2 })} yds`
    + ` · ${aj.source}${aj.po_id ? ' · PO ' + aj.po_id : ''}`
    + require('../services/approvalCards').buildReceiveDetail(aj);
  await approvalEvents.notifyAdminsApprovalRequest(
    bot, requestId, await require('../services/approvalCards').resolveUserLabel(userId), summary, risk.reason, excludeId);

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

  // Never fail silently: the ACK above already cleared the spinner, so any
  // unreported throw below looks like a dead button to the operator.
  try {
    return await _dispatch(bot, callbackQuery, data, userId, chatId, messageId);
  } catch (err) {
    logger.error(`[bulkReceiveFlow] ${data} failed: ${err.message}`);
    try {
      await bot.sendMessage(chatId, `🚫 That action failed (${err.message}). If this repeats, re-upload the file.`);
    } catch (_) { /* chat unreachable */ }
    return true;
  }
}

async function _dispatch(bot, callbackQuery, data, userId, chatId, messageId) {
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
  if (!session || session.type !== 'bulk_receive_flow') {
    // In-memory session lost (TTL, or the bot restarted/redeployed between
    // the preview and this tap). Silence here cost the owner three upload
    // attempts on 13-Jul — say it out loud instead.
    await bot.sendMessage(chatId,
      '⌛ This upload session has expired (or the bot restarted since the preview). ' +
      'Nothing was submitted. Please re-upload the file and submit again.');
    return true;
  }

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
  if (data.startsWith('br:ct:')) {
    session.arrivalBatch = data.slice('br:ct:'.length);
    if (session.step === 'await_container') session.step = 'await_submit';
    sessionStore.set(userId, session);
    await showPreviewStep(bot, chatId, userId);
    return true;
  }
  if (data === 'br:ct_new') {
    session.step = 'await_container';
    sessionStore.set(userId, session);
    await render(bot, chatId, userId,
      '🚢 *New container*\n\nType the container / arrival-batch label for this stock (e.g. `July26`).',
      [[{ text: '⬅ Back', callback_data: 'br:ct_back' }], cancelRow()]);
    return true;
  }
  if (data === 'br:ct_back') {
    session.step = 'await_submit';
    sessionStore.set(userId, session);
    await showPreviewStep(bot, chatId, userId);
    return true;
  }
  if (data === 'br:submit') {
    if (!session.arrivalBatch) {
      await showPreviewStep(bot, chatId, userId);
      return true;
    }
    await submit(bot, chatId, userId);
    return true;
  }
  return false;
}

/**
 * ARRIVAL-BATCH C1 — capture the free-typed container label during the
 * `await_container` step. Returns true when the message was consumed.
 */
async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'bulk_receive_flow' || session.step !== 'await_container') return false;
  const raw = String(msg.text || '').trim();
  // Keep labels short, single-line, and free of markdown/callback hazards.
  const label = raw.replace(/[`*_\[\]()\n\r|]/g, '').trim().slice(0, 24);
  if (!label) {
    await render(bot, chatId, userId,
      '🚢 *New container*\n\n⚠️ _That doesn\'t look like a valid label._ Type something like `July26`.',
      [[{ text: '⬅ Back', callback_data: 'br:ct_back' }], cancelRow()]);
    return true;
  }
  session.arrivalBatch = label;
  session.step = 'await_submit';
  sessionStore.set(userId, session);
  await showPreviewStep(bot, chatId, userId);
  return true;
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
  handleText,
  sendTemplate,
  _internals: { parseBuffer, listAllowedWarehouses, formatErrorsForChat, UPLOADS_DIR, MAX_FILE_BYTES },
};
