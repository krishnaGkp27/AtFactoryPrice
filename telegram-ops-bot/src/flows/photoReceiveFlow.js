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
const goodsReceiptsRepo = require('../repositories/goodsReceiptsRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const approvalEvents = require('../events/approvalEvents');
const auditLogRepository = require('../repositories/auditLogRepository');
const idGenerator = require('../utils/idGenerator');
const riskEvaluate = require('../risk/evaluate');
const auth = require('../middlewares/auth');
const { downloadTelegramFile } = require('../utils/telegramFiles');
const vision = require('../services/vision');
const driveBackup = require('../services/vision/driveBackup');
const usersRepository = require('../repositories/usersRepository');
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

const { cancelRow } = require('../utils/flowKit').rowsFor('pr');

/**
 * UX-C1: re-render the anchored flow card with an error notice embedded
 * and a retry/cancel keyboard. Replaces plain `sendMessage(chatId, text)`
 * calls that left the user with no tappable controls — those messages
 * would land at the bottom of the chat with no inline keyboard, forcing
 * the user to scroll up to find the original flow card.
 *
 * Use when the flow stays in its current step on error (typical for
 * `await_file` and `await_review` failures); the inline keyboard mirrors
 * the step's normal back/cancel options so the user never loses context.
 */
async function renderError(bot, chatId, userId, errorText, opts = {}) {
  const session = sessionStore.get(userId);
  if (!session) {
    // Session gone — best-effort plain send so the user at least hears about it.
    await bot.sendMessage(chatId, errorText, { parse_mode: 'Markdown' });
    return;
  }
  const step = session.step || 'await_file';
  const rows = [];
  if (step === 'await_file') {
    rows.push([{ text: '🔄 Try another file', callback_data: 'pr:retry' }]);
    rows.push([{ text: '⬅ Back to PO', callback_data: 'pr:back_po' }]);
  } else if (step === 'await_review' || step === 'await_submit') {
    rows.push([{ text: '⬅ Back to review', callback_data: 'pr:back_review' }]);
    rows.push([{ text: '🔄 Re-upload', callback_data: 'pr:retry' }]);
  } else {
    rows.push([{ text: '🔄 Try again', callback_data: 'pr:retry' }]);
  }
  rows.push(cancelRow());
  // Compose the error onto the current header so the user keeps full
  // context. render() handles edit-or-resend and message-id anchoring.
  await render(bot, chatId, userId, `⚠️ ${errorText}`, rows);
}

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
    // UX-C1: re-render the anchored flow card with retry/cancel keyboard
    // instead of dropping a bare error at the bottom of the chat.
    await renderError(bot, chatId, userId,
      `Unsupported file type \`${mimeType || '?'}\`.\nSend a JPG / PNG / WebP / HEIC photo, or a PDF.`);
    return true;
  }

  // Download the bytes from Telegram.
  let buffer;
  try {
    const fetched = await downloadTelegramFile(bot, telegramFileId);
    buffer = fetched.buffer;
  } catch (e) {
    logger.error(`photoReceiveFlow.handleFile fetch: ${e.message}`);
    await renderError(bot, chatId, userId, `Could not fetch your file: ${e.message}`);
    return true;
  }

  // FILE-C1: archive locally + best-effort Drive backup, now with a
  // human-readable Drive filename built from the uploader name + the
  // original (Telegram-provided) filename + date + 8-char hash.
  //
  // Uploader name comes from the Users sheet — falls back to Telegram's
  // first_name then the user_id so we always have something readable.
  let uploaderName = msg.from.first_name || `user-${userId}`;
  try {
    const u = await usersRepository.findByUserId(userId);
    if (u && u.name) uploaderName = u.name;
  } catch (_) { /* repo absent in dev, fall back to Telegram first_name */ }

  let archive;
  try {
    archive = await driveBackup.archiveFile(buffer, mimeType, {
      uploader: uploaderName,
      originalName: fileName,
      kind: 'photo',
    });
  } catch (e) {
    logger.error(`photoReceiveFlow.archiveFile: ${e.message}`);
    await renderError(bot, chatId, userId, `Could not archive the upload: ${e.message}`);
    return true;
  }

  // Run OCR. Brief progress note — small enough that scrolling past it is
  // cheap, and the result render replaces the anchored card.
  await bot.sendMessage(chatId, '🔍 _Reading your slip…_', { parse_mode: 'Markdown' });
  const ocr = await vision.extractBales(buffer, mimeType);
  if (!ocr.ok) {
    await renderError(bot, chatId, userId,
      `OCR failed: ${ocr.error || 'unknown'}\nTry a sharper photo, or use 📤 Bulk Receive (CSV) instead.`);
    return true;
  }
  if (!ocr.bales.length) {
    await renderError(bot, chatId, userId,
      'OCR did not find any bale rows on this slip.\nTry a sharper photo or use 📤 Bulk Receive (CSV).');
    return true;
  }

  // Populate session and render the review card.
  session.fileName = fileName;
  session.fileMime = mimeType;
  session.fileHash = archive.hash;
  session.fileSize = buffer.length;
  session.localPath = archive.localPath || '';
  session.driveLink = archive.drive?.webViewLink || '';
  // FILE-C1: keep the Drive file id for post-approval description
  // enrichment + the readable name we'll write to GoodsReceipts.
  session.driveFileId = archive.drive?.id || '';
  session.sourceFilename = archive.readableName || '';
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

  // UX-C1: simple navigation back to the review card from an error
  // re-render. Used by renderError() when submit-time validation fails.
  if (data === 'pr:back_review') {
    session.step = 'await_review';
    sessionStore.set(userId, session);
    await showReviewStep(bot, chatId, userId);
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
    const idx = parseInt(editMatch[1], 10);
    if (!session.rows[idx]) return true;
    session.editingRowIdx = idx;
    session.editingField = null;
    session._editSnapshot = { ...session.rows[idx], editedFields: session.rows[idx].editedFields.slice() };
    session.step = 'await_edit';
    sessionStore.set(userId, session);
    await showEditStep(bot, chatId, userId);
    return true;
  }

  const fieldMatch = data.match(/^pr:edit_field:(\d+):([a-z]+)$/);
  if (fieldMatch) {
    const idx = parseInt(fieldMatch[1], 10);
    const field = fieldMatch[2];
    if (!session.rows[idx]) return true;
    if (!EDITABLE_FIELDS.includes(field)) return true;
    session.editingRowIdx = idx;
    session.editingField = field;
    sessionStore.set(userId, session);
    const cur = session.rows[idx][field];
    const meta = FIELD_META[field];
    await bot.sendMessage(chatId,
      `*Set new value for ${meta.label}* (row ${idx + 1})\n`
      + `Current: ${cur === '' || cur == null ? '_(none)_' : `\`${cur}\``}\n`
      + (meta.hint ? `_${meta.hint}_\n` : '')
      + `Send /cancel to abort.`,
      { parse_mode: 'Markdown' });
    return true;
  }

  const editSaveMatch = data.match(/^pr:edit_save:(\d+)$/);
  if (editSaveMatch) {
    const idx = parseInt(editSaveMatch[1], 10);
    if (!session.rows[idx]) return true;
    const r = session.rows[idx];
    r.state = r.editedFields.length ? 'edited' : 'accepted';
    session.editingRowIdx = null;
    session.editingField = null;
    delete session._editSnapshot;
    session.step = 'await_review';
    sessionStore.set(userId, session);
    await showReviewStep(bot, chatId, userId);
    return true;
  }

  const editCancelMatch = data.match(/^pr:edit_cancel:(\d+)$/);
  if (editCancelMatch) {
    const idx = parseInt(editCancelMatch[1], 10);
    if (session.rows[idx] && session._editSnapshot) {
      session.rows[idx] = session._editSnapshot;
    }
    session.editingRowIdx = null;
    session.editingField = null;
    delete session._editSnapshot;
    session.step = 'await_review';
    sessionStore.set(userId, session);
    await showReviewStep(bot, chatId, userId);
    return true;
  }

  if (data === 'pr:submit') {
    if (!canSubmit(session.rows)) {
      await bot.answerCallbackQuery(query.id, { text: 'Decide every row before submitting.' });
      return true;
    }
    await submit(bot, chatId, userId);
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
// Step 4 — Per-row edit subflow (P5-C4)
// ---------------------------------------------------------------------------

const EDITABLE_FIELDS = ['packageNo', 'thanNo', 'design', 'shade', 'yards', 'netMtrs', 'netWeight'];

const FIELD_META = {
  packageNo: { label: 'PackageNo',  type: 'string', hint: 'Max 32 chars. The number printed on the bale.' },
  thanNo:    { label: 'ThanNo',     type: 'int',    hint: 'Positive integer 1–999.' },
  design:    { label: 'Design',     type: 'string', hint: 'Max 80 chars. E.g. "Beige Crepe".' },
  shade:     { label: 'Shade',      type: 'string', hint: 'Max 80 chars. E.g. "B-12". Send "-" to clear.' },
  yards:     { label: 'Yards',      type: 'positive_number', hint: 'Numeric > 0.' },
  netMtrs:   { label: 'NetMtrs',    type: 'non_negative_number', hint: 'Numeric ≥ 0. Send "-" to clear.' },
  netWeight: { label: 'NetWeight',  type: 'non_negative_number', hint: 'Numeric ≥ 0. Send "-" to clear.' },
};

function fmtRowField(r, field) {
  const v = r[field];
  if (v == null || v === '' || v === 0 && field !== 'thanNo' && field !== 'yards') return '_(none)_';
  return `\`${v}\``;
}

async function showEditStep(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.editingRowIdx == null) return;
  const idx = session.editingRowIdx;
  const r = session.rows[idx];
  if (!r) return;
  const conf = Math.round(r.confidence * 100);
  const lines = [
    `*✏ Editing row ${idx + 1}* — OCR confidence ${conf}%${r.lowConfidence ? ' 🔴' : ''}`,
    '',
    `PackageNo: ${fmtRowField(r, 'packageNo')}`,
    `ThanNo:    ${fmtRowField(r, 'thanNo')}`,
    `Design:    ${fmtRowField(r, 'design')}`,
    `Shade:     ${fmtRowField(r, 'shade')}`,
    `Yards:     ${fmtRowField(r, 'yards')}`,
    `NetMtrs:   ${fmtRowField(r, 'netMtrs')}`,
    `NetWeight: ${fmtRowField(r, 'netWeight')}`,
  ];
  if (r.editedFields.length) {
    lines.push('');
    lines.push(`_Edited so far: ${r.editedFields.join(', ')}_`);
  }
  // Field-edit buttons — two per row for compactness
  const fieldButtons = [];
  for (let i = 0; i < EDITABLE_FIELDS.length; i += 2) {
    const row = [];
    const a = EDITABLE_FIELDS[i];
    row.push({ text: `✏ ${FIELD_META[a].label}`, callback_data: `pr:edit_field:${idx}:${a}` });
    const b = EDITABLE_FIELDS[i + 1];
    if (b) row.push({ text: `✏ ${FIELD_META[b].label}`, callback_data: `pr:edit_field:${idx}:${b}` });
    fieldButtons.push(row);
  }
  const actionButtons = [
    [
      { text: `✅ Save row ${idx + 1}`, callback_data: `pr:edit_save:${idx}` },
      { text: `❌ Skip row ${idx + 1}`, callback_data: `pr:row_skip:${idx}` },
    ],
    [{ text: '↩ Discard edits + back', callback_data: `pr:edit_cancel:${idx}` }],
  ];
  await render(bot, chatId, userId, lines.join('\n'), [...fieldButtons, ...actionButtons]);
}

/**
 * Coerce + validate a text input against a field's type spec.
 *
 * Returns `{ ok: true, value }` on success or `{ ok: false, error }`
 * on validation failure. Caller renders the error to the user.
 *
 * Sentinel `-` clears optional fields (Shade, NetMtrs, NetWeight) so
 * the operator can undo an OCR-introduced value without inventing a
 * cryptic delete UI.
 */
function coerceFieldValue(field, raw) {
  const meta = FIELD_META[field];
  if (!meta) return { ok: false, error: `Unknown field ${field}.` };
  const s = (raw || '').trim();
  if (!s) return { ok: false, error: `${meta.label} can't be empty.` };

  if (s === '-' && ['shade', 'netMtrs', 'netWeight'].includes(field)) {
    return { ok: true, value: field === 'shade' ? '' : 0 };
  }

  if (meta.type === 'string') {
    if (s.length > 80) return { ok: false, error: `${meta.label} too long (max 80 chars).` };
    if (field === 'packageNo' && s.length > 32) return { ok: false, error: 'PackageNo too long (max 32 chars).' };
    return { ok: true, value: s };
  }
  if (meta.type === 'int') {
    const n = parseInt(s, 10);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `${meta.label} must be a positive integer.` };
    if (field === 'thanNo' && n > 999) return { ok: false, error: 'ThanNo must be 1–999.' };
    return { ok: true, value: n };
  }
  if (meta.type === 'positive_number') {
    const n = parseFloat(s);
    if (!isFinite(n) || n <= 0) return { ok: false, error: `${meta.label} must be a positive number.` };
    return { ok: true, value: n };
  }
  if (meta.type === 'non_negative_number') {
    const n = parseFloat(s);
    if (!isFinite(n) || n < 0) return { ok: false, error: `${meta.label} must be ≥ 0.` };
    return { ok: true, value: n };
  }
  return { ok: false, error: `Unknown field type ${meta.type}.` };
}

/**
 * Called by the controller (handleMessage) when a text message arrives
 * while a `photo_receive_flow` session is active in `await_edit` step
 * with an editingField set.
 *
 * Returns true if the text was consumed.
 */
async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'photo_receive_flow') return false;
  if (session.step !== 'await_edit') return false;
  if (session.editingField == null) return false;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (/^\/cancel\b/i.test(text)) {
    session.editingField = null;
    sessionStore.set(userId, session);
    await bot.sendMessage(chatId, 'Edit cancelled.');
    await showEditStep(bot, chatId, userId);
    return true;
  }

  const idx = session.editingRowIdx;
  const field = session.editingField;
  const verdict = coerceFieldValue(field, text);
  if (!verdict.ok) {
    await bot.sendMessage(chatId, `⚠️ ${verdict.error}\nTry again, or send /cancel.`);
    return true;
  }
  const r = session.rows[idx];
  if (!r) return true;
  r[field] = verdict.value;
  if (!r.editedFields.includes(field)) r.editedFields.push(field);
  // Editing yards on a low-confidence row clears the lowConfidence flag
  // for UX purposes — the admin has now vetted it.
  if (r.lowConfidence) r.lowConfidence = false;
  session.editingField = null;
  sessionStore.set(userId, session);
  await bot.sendMessage(chatId,
    `✅ ${FIELD_META[field].label} updated. Tap another field or *Save*.`,
    { parse_mode: 'Markdown' });
  await showEditStep(bot, chatId, userId);
  return true;
}

// ---------------------------------------------------------------------------
// Step 5 — Submit (bridges into bulk_receive_goods)
// ---------------------------------------------------------------------------

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'photo_receive_flow') return;

  // Collect accepted + edited rows; build a payload that looks IDENTICAL
  // to a bulk-CSV submit so the existing service handler doesn't need
  // a separate branch.
  const accepted = session.rows.filter((r) => r.state === 'accepted' || r.state === 'edited');
  if (!accepted.length) {
    // UX-C1: keep the review card visible with retry/cancel attached.
    await renderError(bot, chatId, userId,
      'No accepted rows to submit. Decide each row first (Accept / Edit / Skip).');
    return;
  }

  // Run through the bulk validator one more time — same uniformity +
  // uniqueness rules as the CSV path. The OCR review already enforces
  // per-row sanity, but the file-level invariants (one warehouse,
  // (PackageNo, ThanNo) unique, per-bale Design+Shade uniformity) need
  // a second pass.
  const allowed = await listAllowedWarehouses();
  // Synthesize the structure bulkValidator.validate expects:
  // rows keyed by lowercased headers, with _rowNum for error addressing.
  const synthetic = {
    ok: true,
    headers: ['packageno', 'thanno', 'design', 'shade', 'yards', 'netmtrs', 'netweight',
              'warehouse', 'supplier', 'notes'],
    rows: accepted.map((r, i) => ({
      _rowNum: r.idx + 1,
      packageno: r.packageNo, thanno: String(r.thanNo),
      design: r.design, shade: r.shade,
      yards: String(r.yards),
      netmtrs: r.netMtrs ? String(r.netMtrs) : '',
      netweight: r.netWeight ? String(r.netWeight) : '',
      // Warehouse + supplier are FILE-level for OCR — we infer them
      // from the bot's currently-default warehouse / supplier choice.
      // For v1 we attach the *first* registered warehouse if there's
      // exactly one and let the validator catch missing/mismatched.
      warehouse: r._warehouse || (allowed && allowed.length === 1 ? allowed[0] : ''),
      supplier: r._supplier || '',
      notes: r.notes || '',
    })),
  };
  const verdict = bulkValidator.validate(synthetic, {
    allowedWarehouses: allowed,
    maxRows: bulkValidator.MAX_ROWS_DEFAULT,
  });
  if (!verdict.ok) {
    // UX-C1: re-render the anchored card with the error list + Back/Cancel
    // so the user keeps their place after spending minutes reviewing rows.
    const head = `*${verdict.errors.length} validation error${verdict.errors.length === 1 ? '' : 's'}:*\n`;
    const body = verdict.errors.slice(0, 10).map((e) =>
      `• Row ${e.row || '?'}${e.column ? ` · ${e.column}` : ''}: ${e.message}`
    ).join('\n');
    const more = verdict.errors.length > 10 ? `\n_…and ${verdict.errors.length - 10} more._` : '';
    await renderError(bot, chatId, userId, head + body + more
      + '\n\nReview the rows, edit as needed, or skip the bad ones before submitting.');
    return;
  }

  // Idempotency — same image already imported?
  try {
    const dup = await goodsReceiptsRepo.getByFileHash(session.fileHash);
    if (dup) {
      // UX-C1: idempotency block — keep anchored card with retry/cancel.
      await renderError(bot, chatId, userId,
        `This photo was already imported as \`${dup.grn_id}\` on ${(dup.received_at || '').split('T')[0]}.\n_Hash:_ \`${session.fileHash}\``);
      return;
    }
  } catch (e) {
    logger.warn(`photoReceiveFlow: getByFileHash failed (continuing): ${e.message}`);
  }

  const sourceTag = `ocr_vision_${session.ocrProvider || 'stub'}`;
  const aj = {
    action: 'bulk_receive_goods',          // bridge into existing handler
    warehouse: verdict.summary.warehouses[0] || '',
    supplier: verdict.summary.suppliers[0] || '',
    po_id: session.po_id && session.po_id !== '__skip__' ? session.po_id : '',
    bales: verdict.bales.map((b) => ({
      packageNo: b.packageNo,
      thanNo: b.thanNo,
      design: b.design, shade: b.shade, color: b.color || '',
      yards: b.yards,
      netMtrs: b.netMtrs || 0, netWeight: b.netWeight || 0,
      notes: b.notes || '',
    })),
    totalBales: verdict.summary.totalBales,
    totalThans: verdict.summary.totalThans,
    totalYards: verdict.summary.totalYards,
    totalNetMtrs: verdict.summary.totalNetMtrs,
    totalNetWeight: verdict.summary.totalNetWeight,
    source: sourceTag,                     // 'ocr_vision_stub' | 'ocr_vision_openai' | ...
    fileHash: session.fileHash,
    fileName: session.fileName,
    fileSize: session.fileSize || 0,
    archivedPath: session.localPath || '',
    driveLink: session.driveLink || '',
    // FILE-C1: surface Drive metadata to the persistence layer so the
    // GoodsReceipts row gets source_url + source_filename and the
    // post-approval description-stamping step can find the Drive file.
    sourceUrl: session.driveLink || '',
    sourceFilename: session.sourceFilename || '',
    driveFileId: session.driveFileId || '',
    ocrProvider: session.ocrProvider,
    ocrConfidence: session.ocrConfidence,
    ocrRawText: (session.rawText || '').slice(0, 2000), // cap to keep approval row small
    editedRows: accepted.filter((r) => r.editedFields.length).map((r) => ({
      idx: r.idx, fields: r.editedFields.slice(),
    })),
    dateReceived: new Date().toISOString().split('T')[0],
    productType: 'fabric',
  };

  const risk = await riskEvaluate.evaluate({ action: 'bulk_receive_goods', userId });
  const requestId = idGenerator.requestId();
  await approvalQueueRepository.append({
    requestId, user: userId, actionJSON: aj,
    riskReason: risk.reason || 'dual_admin_required', status: 'pending',
  });
  await auditLogRepository.append('approval_queued', {
    requestId, reason: risk.reason, source: aj.source, fileHash: aj.fileHash,
    bales: aj.totalBales, thans: aj.totalThans, edited: aj.editedRows.length,
  }, userId);

  const isAdm = auth.isAdmin(userId);
  const approverLabel = isAdm ? '2nd admin' : 'admin';
  const excludeId = isAdm ? userId : undefined;
  // APU-1: dual-admin container upload — approvers now see the per-design
  // breakdown, OCR confidence, file hash and source link, not one line.
  const summary =
    `📷 Photo Receive — ${aj.warehouse} · ${aj.totalBales} bales / ${aj.totalThans} thans · `
    + `${fmtQty(aj.totalYards, { maxFraction: 2 })} yds · ${aj.source}`
    + `${aj.po_id ? ' · PO ' + aj.po_id : ''}`
    + `${aj.editedRows.length ? ` · ${aj.editedRows.length} edited` : ''}`
    + require('../services/approvalCards').buildReceiveDetail(aj);
  await approvalEvents.notifyAdminsApprovalRequest(
    bot, requestId, await require('../services/approvalCards').resolveUserLabel(userId), summary, risk.reason, excludeId);

  session.step = 'submitted';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `⏳ Submitted for ${approverLabel} approval.\nRequest: \`${requestId}\`\nHash: \`${aj.fileHash}\``,
    [[{ text: '📷 Upload another', callback_data: 'act:photo_receive_goods' }],
     [{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
  sessionStore.clear(userId);
}

// ---------------------------------------------------------------------------
// Reference data — warehouses (kept identical to bulkReceiveFlow for parity)
// ---------------------------------------------------------------------------

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

module.exports = {
  start,
  handleCallback,
  handleFile,
  handleText,
  submit,
  showPoStep,
  showAwaitFileStep,
  showReviewStep,
  showEditStep,
  // Test-friendly internals
  reviewProgress,
  canSubmit,
  rowSummary,
  rowButtons,
  acceptAllOk,
  setRowState,
  coerceFieldValue,
  listAllowedWarehouses,
  EDITABLE_FIELDS,
  FIELD_META,
};
