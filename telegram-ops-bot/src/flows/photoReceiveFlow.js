/**
 * Photo Receive Goods flow — P5-C3.
 *
 * Abdul (inventory manager) photos a packaging slip on his phone or
 * sends a PDF; the bot runs OCR (via src/services/vision), then shows
 * the admin a per-row review card so each extracted than can be
 * Accepted / Edited / Skipped before the batch is submitted through
 * the existing dual-admin `bulk_receive_goods` approval (same path as
 * the CSV bulk upload — OCR is purely a capture mechanism).
 *
 * Steps:
 *   1. PO link (optional)        — pick a PO or skip
 *   2. File upload (image/PDF)   — send as Telegram photo or document
 *   3. OCR + review              — per-row ✅/✏/❌ until every row decided
 *   4. Submit                    — bridge into bulk_receive_goods (C4)
 *   5. Approval queue            — dual-admin (requester != approver)
 *   6. Persist on approval       — service handler (inventoryService)
 *
 * Why reuse `bulk_receive_goods` action: photo-extracted rows write to
 * the same Inventory / GoodsReceipts / Stock_Ledger tables, with the
 * same append-only contract and dual-admin gate. Only the `source` tag
 * differs (`ocr_vision_<provider>` vs `bulk_csv`).
 *
 * Session shape (`type: 'photo_receive_flow'`):
 *   {
 *     step: 'await_po' | 'await_file' | 'await_review' | 'await_edit'
 *           | 'await_submit' | 'submitted',
 *     flowMessageId: number,
 *     po_id: string,                     '' | po_id | '__skip__'
 *
 *     fileName: string,
 *     fileMime: string,
 *     fileHash: string,                  SHA-256 first-16-hex of bytes
 *     fileSize: number,
 *     localPath: string,                 data/ocr/<hash>.<ext>
 *     driveLink: string,                 webViewLink or ''
 *
 *     ocrProvider: string,               'stub' | 'openai' | ...
 *     ocrConfidence: number,             0..1
 *     rawText: string,                   raw OCR dump for audit
 *     warnings: string[],
 *
 *     rows: Array<ReviewRow>,
 *     editingRowIdx: number | null,
 *     editingField: string | null,
 *
 *     startedAt: ISO,
 *   }
 *
 * ReviewRow shape:
 *   {
 *     idx: number,                       0-based, stable index in session.rows
 *     packageNo, thanNo, design, shade,
 *     yards, netMtrs, netWeight,
 *     supplier, notes,
 *     confidence: number,
 *     lowConfidence: boolean,
 *     state: 'pending' | 'accepted' | 'skipped' | 'edited',
 *     editedFields: string[],            audit trail of admin overrides
 *   }
 *
 * Callback namespace `pr:*`
 *   pr:po:<po_id>       pin a PO
 *   pr:po_skip          proceed without a PO
 *   pr:back_po          return to PO step
 *   pr:row_accept:<n>   accept row <n>          (low-conf rows blocked)
 *   pr:row_skip:<n>     skip row <n>
 *   pr:row_edit:<n>     open edit subflow for row <n>   (C4)
 *   pr:row_undo:<n>     revert row <n> to pending
 *   pr:accept_all       accept all non-low-confidence pending rows
 *   pr:retry            discard OCR result, re-upload
 *   pr:submit           submit accepted rows for approval   (C4)
 *   pr:cancel           abandon flow
 *
 * Notes for the C4 follow-up:
 *   - The edit subflow (`pr:row_edit:<n>`) currently shows a placeholder
 *     "coming in C4" message. The handler hook exists so the controller
 *     wire-up done here doesn't need to change.
 *   - `submit()` walks accepted rows, runs them through the bulk
 *     validator (same uniformity + uniqueness rules from P2.5-C5), and
 *     queues a `bulk_receive_goods` request. Until C4 lands the button
 *     is rendered disabled-with-tooltip.
 */

'use strict';

const sessionStore = require('../utils/sessionStore');
const procurementOrdersRepo = require('../repositories/procurementOrdersRepository');
const settingsRepository = require('../repositories/settingsRepository');
const { downloadTelegramFile } = require('../utils/telegramFiles');
const vision = require('../services/vision');
const driveBackup = require('../services/vision/driveBackup');
const bulkValidator = require('../utils/bulkRowValidator');
const { fmtQty } = require('../utils/format');
const logger = require('../utils/logger');

const ACCEPTED_MIMES = vision.SUPPORTED_MIMES;
const MAX_VISIBLE_ROWS = 10; // pagination kicks in beyond this — v1 caps OCR to single delivery slips

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const ICONS = { pending: '⏳', accepted: '✅', skipped: '❌', edited: '✏️' };

function header(session) {
  const lines = ['📷 *Photo Receive Goods*'];
  if (session.po_id && session.po_id !== '__skip__') lines.push(`✓ PO: \`${session.po_id}\``);
  else if (session.po_id === '__skip__') lines.push('✓ PO: _none_');
  if (session.fileName) {
    const sizeKb = session.fileSize ? `${Math.round(session.fileSize / 1024)} KB` : '';
    lines.push(`✓ File: \`${session.fileName}\` ${sizeKb}`);
  }
  if (session.ocrProvider) {
    const conf = Math.round((session.ocrConfidence || 0) * 100);
    lines.push(`✓ OCR: \`${session.ocrProvider}\` (overall ${conf}%)`);
  }
  if (session.driveLink) lines.push(`✓ Drive: ${session.driveLink}`);
  return lines.join('\n');
}

async function render(bot, chatId, userId, prompt, rows) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const text = (header(session) + '\n\n' + prompt).trim();
  const opts = { parse_mode: 'Markdown', disable_web_page_preview: true,
                 reply_markup: { inline_keyboard: rows } };
  const mid = session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (_) { /* fall through */ }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  session.flowMessageId = sent.message_id;
  sessionStore.set(userId, session);
}

function cancelRow() { return [{ text: '❌ Cancel', callback_data: 'pr:cancel' }]; }

// ---------------------------------------------------------------------------
// Step 1 — Optional PO linkage
// ---------------------------------------------------------------------------

async function start(bot, chatId, userId, messageId = null) {
  sessionStore.set(userId, {
    type: 'photo_receive_flow',
    step: 'await_po',
    flowMessageId: messageId || null,
    po_id: '',
    rows: [],
    editingRowIdx: null,
    editingField: null,
    startedAt: new Date().toISOString(),
  });
  await showPoStep(bot, chatId, userId);
}

async function showPoStep(bot, chatId, userId) {
  let openPOs = [];
  try { openPOs = await procurementOrdersRepo.getOpen(); } catch (_) { /* repo absent in dev */ }
  const rows = [];
  for (const po of openPOs.slice(0, 8)) {
    rows.push([{ text: `📋 ${po.po_id} · ${po.supplier || 'no supplier'}`, callback_data: `pr:po:${po.po_id}` }]);
  }
  rows.push([{ text: '⏭ Skip (no PO)', callback_data: 'pr:po_skip' }]);
  rows.push(cancelRow());
  const prompt = openPOs.length
    ? 'Link this photo upload to an open *Procurement Order* (optional):'
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
  const prompt = [
    '*Send the packaging slip as a photo or PDF.*',
    '',
    'Accepted: 📷 JPG / PNG / WebP / HEIC, or 📄 PDF',
    '',
    'You can take it directly with your phone — the bot OCRs every visible bale / than line.',
    '_Each extracted row gets your ✅ / ✏ / ❌ before anything is submitted._',
  ].join('\n');
  await render(bot, chatId, userId, prompt, [
    [{ text: '⬅ Back to PO', callback_data: 'pr:back_po' }],
    cancelRow(),
  ]);
}

// ---------------------------------------------------------------------------
// Document / photo received — run OCR and route into review
// ---------------------------------------------------------------------------

/**
 * Called by the controller when a Telegram photo *or* document arrives
 * while a `photo_receive_flow` session is active in step 'await_file'.
 *
 * Returns true if the file was consumed.
 */
async function handleFile(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'photo_receive_flow') return false;
  if (session.step !== 'await_file') return false;
  const chatId = msg.chat.id;

  // Resolve telegram file_id + mime from either photo or document.
  let telegramFileId = null;
  let mimeType = '';
  let fileName = '';
  if (msg.photo && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    telegramFileId = largest.file_id;
    mimeType = 'image/jpeg';
    fileName = `tg-photo-${Date.now()}.jpg`;
  } else if (msg.document) {
    telegramFileId = msg.document.file_id;
    mimeType = (msg.document.mime_type || '').toLowerCase();
    fileName = msg.document.file_name || `tg-doc-${Date.now()}`;
    // Fall back to extension sniffing if Telegram didn't set mime_type.
    if (!ACCEPTED_MIMES.includes(mimeType)) {
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      const sniff = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                      webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' }[ext];
      if (sniff) mimeType = sniff;
    }
  } else {
    return false;
  }

  if (!ACCEPTED_MIMES.includes(mimeType)) {
    await bot.sendMessage(chatId,
      `⚠️ Unsupported file type \`${mimeType || '?'}\`.\nSend a JPG / PNG / WebP / HEIC photo, or a PDF.`,
      { parse_mode: 'Markdown' });
    return true;
  }

  // Download the bytes from Telegram.
  let buffer;
  try {
    const fetched = await downloadTelegramFile(bot, telegramFileId);
    buffer = fetched.buffer;
  } catch (e) {
    logger.error(`photoReceiveFlow.handleFile fetch: ${e.message}`);
    await bot.sendMessage(chatId, `⚠️ Could not fetch your file: ${e.message}`);
    return true;
  }

  // Archive locally + best-effort Drive backup.
  let archive;
  try {
    archive = await driveBackup.archiveImage(buffer, mimeType, { filename: fileName });
  } catch (e) {
    logger.error(`photoReceiveFlow.archiveImage: ${e.message}`);
    await bot.sendMessage(chatId, `⚠️ Could not archive the upload: ${e.message}`);
    return true;
  }

  // Run OCR.
  await bot.sendMessage(chatId, '🔍 _Reading your slip…_', { parse_mode: 'Markdown' });
  const ocr = await vision.extractBales(buffer, mimeType);
  if (!ocr.ok) {
    await bot.sendMessage(chatId,
      `⚠️ OCR failed: ${ocr.error || 'unknown'}\nTap Cancel and try a sharper photo, or use 📤 Bulk Receive (CSV) instead.`);
    return true;
  }
  if (!ocr.bales.length) {
    await bot.sendMessage(chatId,
      '⚠️ OCR did not find any bale rows on this slip. Try a sharper photo or use 📤 Bulk Receive (CSV).');
    return true;
  }

  // Populate session and render the review card.
  session.fileName = fileName;
  session.fileMime = mimeType;
  session.fileHash = archive.hash;
  session.fileSize = buffer.length;
  session.localPath = archive.localPath || '';
  session.driveLink = archive.drive?.webViewLink || '';
  session.ocrProvider = ocr.provider;
  session.ocrConfidence = ocr.overallConfidence;
  session.rawText = ocr.rawText;
  session.warnings = ocr.warnings || [];
  session.rows = ocr.bales.map((b, idx) => ({
    idx,
    packageNo: b.packageNo, thanNo: b.thanNo,
    design: b.design, shade: b.shade,
    yards: b.yards, netMtrs: b.netMtrs, netWeight: b.netWeight,
    supplier: b.supplier || '', notes: b.notes || '',
    confidence: b.confidence,
    lowConfidence: b.lowConfidence,
    state: 'pending',
    editedFields: [],
  }));
  session.step = 'await_review';
  sessionStore.set(userId, session);

  await showReviewStep(bot, chatId, userId);
  return true;
}

// ---------------------------------------------------------------------------
// Step 3 — Per-row review card
// ---------------------------------------------------------------------------

function rowSummary(r) {
  const yd = fmtQty(r.yards, { maxFraction: 1 });
  const conf = Math.round(r.confidence * 100);
  const lowFlag = r.lowConfidence ? ' 🔴' : '';
  const stateIcon = ICONS[r.state] || '⏳';
  const editedFlag = r.editedFields.length ? ' ✏' : '';
  const shadeStr = r.shade ? ` ${r.shade}` : '';
  return `${stateIcon} ${r.idx + 1}. ${r.packageNo}-T${r.thanNo}  ${r.design}${shadeStr}  ${yd} yds  (${conf}%)${lowFlag}${editedFlag}`;
}

function rowButtons(r) {
  const n = r.idx;
  if (r.state === 'accepted' || r.state === 'skipped' || r.state === 'edited') {
    return [{ text: `↩ Undo ${n + 1}`, callback_data: `pr:row_undo:${n}` }];
  }
  // Low-confidence rows MUST be edited before they can be accepted —
  // hide the ✅ button entirely so the operator has to engage with them.
  if (r.lowConfidence) {
    return [
      { text: `✏ Edit ${n + 1}`, callback_data: `pr:row_edit:${n}` },
      { text: `❌ Skip ${n + 1}`, callback_data: `pr:row_skip:${n}` },
    ];
  }
  return [
    { text: `✅ ${n + 1}`, callback_data: `pr:row_accept:${n}` },
    { text: `✏ ${n + 1}`, callback_data: `pr:row_edit:${n}` },
    { text: `❌ ${n + 1}`, callback_data: `pr:row_skip:${n}` },
  ];
}

function reviewProgress(rows) {
  const total = rows.length;
  const accepted = rows.filter((r) => r.state === 'accepted' || r.state === 'edited').length;
  const skipped = rows.filter((r) => r.state === 'skipped').length;
  const pending = rows.filter((r) => r.state === 'pending').length;
  const lowOpen = rows.filter((r) => r.state === 'pending' && r.lowConfidence).length;
  return { total, accepted, skipped, pending, lowOpen };
}

function canSubmit(rows) {
  const p = reviewProgress(rows);
  // Need: zero pending rows AND at least one accepted (or edited).
  return p.pending === 0 && p.accepted > 0;
}

async function showReviewStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const rows = session.rows.slice(0, MAX_VISIBLE_ROWS);
  const overflow = session.rows.length - rows.length;
  const p = reviewProgress(session.rows);

  const lines = ['*Review extracted rows*'];
  if (session.warnings.length) {
    lines.push('');
    for (const w of session.warnings.slice(0, 3)) lines.push(`⚠️ _${w}_`);
  }
  lines.push('');
  for (const r of rows) lines.push(rowSummary(r));
  if (overflow > 0) lines.push(`_…and ${overflow} more (cap is ${MAX_VISIBLE_ROWS} in v1)._`);
  lines.push('');
  lines.push(`*Decided:* ${p.accepted + p.skipped}/${p.total}  ·  *Pending:* ${p.pending}  ·  *Low-conf open:* ${p.lowOpen}`);

  const kb = rows.map((r) => rowButtons(r));
  // Mass actions:
  kb.push([
    { text: '✅ Accept all OK rows', callback_data: 'pr:accept_all' },
    { text: '🔄 Re-upload', callback_data: 'pr:retry' },
  ]);
  kb.push([
    { text: canSubmit(session.rows) ? '▶ Submit for approval' : `▶ Submit (decide ${p.pending} more)`,
      callback_data: canSubmit(session.rows) ? 'pr:submit' : 'pr:noop' },
  ]);
  kb.push(cancelRow());

  await render(bot, chatId, userId, lines.join('\n'), kb);
}

// ---------------------------------------------------------------------------
// Per-row state transitions
// ---------------------------------------------------------------------------

function setRowState(session, idx, state) {
  const r = session.rows[idx];
  if (!r) return false;
  r.state = state;
  return true;
}

function acceptAllOk(session) {
  let changed = 0;
  for (const r of session.rows) {
    if (r.state === 'pending' && !r.lowConfidence) {
      r.state = 'accepted';
      changed += 1;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Callback dispatcher
// ---------------------------------------------------------------------------

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('pr:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'photo_receive_flow') return false;

  // ack the tap so Telegram doesn't show the loading spinner forever
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  if (data === 'pr:cancel') {
    sessionStore.clear(userId);
    await bot.sendMessage(chatId, '❌ Photo Receive cancelled.');
    return true;
  }

  if (data === 'pr:back_po') {
    session.step = 'await_po';
    sessionStore.set(userId, session);
    await showPoStep(bot, chatId, userId);
    return true;
  }

  if (data === 'pr:po_skip') {
    session.po_id = '__skip__';
    sessionStore.set(userId, session);
    await showAwaitFileStep(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('pr:po:')) {
    session.po_id = data.slice('pr:po:'.length);
    sessionStore.set(userId, session);
    await showAwaitFileStep(bot, chatId, userId);
    return true;
  }

  if (data === 'pr:retry') {
    // Clear OCR result and re-prompt for a file.
    session.rows = [];
    session.fileHash = '';
    session.fileName = '';
    session.ocrProvider = '';
    session.ocrConfidence = 0;
    session.step = 'await_file';
    sessionStore.set(userId, session);
    await showAwaitFileStep(bot, chatId, userId);
    return true;
  }

  if (data === 'pr:accept_all') {
    const n = acceptAllOk(session);
    sessionStore.set(userId, session);
    await showReviewStep(bot, chatId, userId);
    await bot.sendMessage(chatId, `✅ Accepted ${n} non-low-confidence row${n === 1 ? '' : 's'}.`);
    return true;
  }

  const acceptMatch = data.match(/^pr:row_accept:(\d+)$/);
  if (acceptMatch) {
    const idx = parseInt(acceptMatch[1], 10);
    const r = session.rows[idx];
    if (r && r.lowConfidence && r.state === 'pending') {
      await bot.answerCallbackQuery(query.id, { text: 'Low-confidence row — edit it first.' });
      return true;
    }
    setRowState(session, idx, 'accepted');
    sessionStore.set(userId, session);
    await showReviewStep(bot, chatId, userId);
    return true;
  }

  const skipMatch = data.match(/^pr:row_skip:(\d+)$/);
  if (skipMatch) {
    setRowState(session, parseInt(skipMatch[1], 10), 'skipped');
    sessionStore.set(userId, session);
    await showReviewStep(bot, chatId, userId);
    return true;
  }

  const undoMatch = data.match(/^pr:row_undo:(\d+)$/);
  if (undoMatch) {
    const idx = parseInt(undoMatch[1], 10);
    const r = session.rows[idx];
    if (r) {
      r.state = 'pending';
      r.editedFields = [];   // also clear any edits
      sessionStore.set(userId, session);
      await showReviewStep(bot, chatId, userId);
    }
    return true;
  }

  const editMatch = data.match(/^pr:row_edit:(\d+)$/);
  if (editMatch) {
    // C4 will implement the field-by-field edit subflow. For now,
    // tell the operator clearly so they don't think the bot is broken.
    await bot.sendMessage(chatId,
      '✏ _Edit subflow lands in P5-C4 (next commit)._\n'
      + 'For now: tap ❌ Skip on this row and use 📤 Bulk Receive (CSV) for any low-confidence rows.',
      { parse_mode: 'Markdown' });
    return true;
  }

  if (data === 'pr:submit') {
    // C4 will bridge into bulk_receive_goods. For now, show what would
    // be submitted so the review-UI iteration loop with the user is
    // unblocked.
    if (!canSubmit(session.rows)) {
      await bot.sendMessage(chatId, '⚠️ Decide every row before submitting.');
      return true;
    }
    const accepted = session.rows.filter((r) => r.state === 'accepted' || r.state === 'edited');
    await bot.sendMessage(chatId,
      `▶ _Submit bridge lands in P5-C4 (next commit)._\n`
      + `Would submit ${accepted.length} accepted row${accepted.length === 1 ? '' : 's'} `
      + `as a \`bulk_receive_goods\` request, source=\`ocr_vision_${session.ocrProvider}\`, `
      + `hash=\`${session.fileHash}\`.`,
      { parse_mode: 'Markdown' });
    return true;
  }

  if (data === 'pr:noop') {
    // The disabled-submit button maps here — silently re-render so the
    // operator sees the live "decide N more" count update.
    await showReviewStep(bot, chatId, userId);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Reference data — warehouses (kept identical to bulkReceiveFlow for parity)
// ---------------------------------------------------------------------------

async function listAllowedWarehouses() {
  try {
    const rows = await settingsRepository.getAll();
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const raw = String(map.get('WAREHOUSES') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return raw.length ? raw : null;
  } catch (e) {
    logger.warn(`photoReceiveFlow.listAllowedWarehouses: ${e.message}`);
    return null;
  }
}

module.exports = {
  start,
  handleCallback,
  handleFile,
  showPoStep,
  showAwaitFileStep,
  showReviewStep,
  // Test-friendly internals
  reviewProgress,
  canSubmit,
  rowSummary,
  rowButtons,
  acceptAllOk,
  setRowState,
  listAllowedWarehouses,
};
