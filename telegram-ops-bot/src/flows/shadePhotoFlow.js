'use strict';

/**
 * shadePhotoFlow — SHP-1 🎨 Shade Photos: the owner's tap-first door for
 * adding one GARMENT photo per shade of a design (specs/SHP-1_SHADE_PHOTOS.md).
 *
 *   design (✓ = has shade photos) → container (only when the design has
 *   more than one) → shade list (✓ = has a photo) → "send the picture for
 *   2 - Dark Brown" → preview with ✅ Use it / 🔁 Retake / ⏭ Skip → auto-
 *   advances to the next shade without a photo → ✅ Done submits ONE
 *   approval card for the whole batch.
 *
 * Approval rides the existing single-admin `design_asset_upload` queue with
 * `kind: 'shade'` in the actionJSON — no new action code (rule 3). The
 * uploader cannot approve their own.
 *
 * QUALITY (owner: "no compromise with the quality at all, at any place"):
 *   - the prompt asks for the picture as a FILE — a Telegram "photo" is
 *     compressed before the bot ever sees it; a document is the original;
 *   - originals go to Drive untouched; the stamped copy is rendered at
 *     native resolution (imageOverlay.stampNative);
 *   - on ✅ Use it the stamped copy is ALSO sent back as a document, so its
 *     file_id is cached and the full-quality form stays serveable even if
 *     Drive is down (BKP-1 is unresolved).
 *
 * Callback namespace `shp:`:
 *   shp:d:<i>      pick design i (page-relative)     shp:pg:<n>   design page n
 *   shp:b:<i>      pick container i ('g' = generic)  shp:s:<i>    pick shade i
 *   shp:next       next shade without a photo        shp:use:<i>  keep the preview
 *   shp:retake:<i> send another                      shp:skip:<i> skip this shade
 *   shp:done       submit the batch                  shp:back / shp:cancel / shp:noop
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor, guardSession, chunk, mdEscape } = require('../utils/flowKit');
const designAssetsRepo = require('../repositories/designAssetsRepository');
const shadeAssets = require('../services/designShadeAssetsService');
const imageOverlay = require('../utils/imageOverlay');
const logger = require('../utils/logger');
const config = require('../config');

const SESSION_TYPE = 'shade_photo_flow';
const TTL_MS = 30 * 60 * 1000;
const DESIGNS_PER_PAGE = 24;
const PER_ROW = 3;
// Telegram refuses a photo upload over 10 MB or with width+height > 10000.
const PHOTO_MAX_BYTES = 9 * 1024 * 1024;
const PHOTO_MAX_DIM_SUM = 10000;

const render = makeRenderer({ titlePrefix: '🎨 *Shade Photos*\n\n' });
const { cancelRow, menuRow } = rowsFor('shp');

/* Stamped bytes waiting for ✅ Use it — never in the session store (it is
 * serialised into memory dumps and janitor sweeps). Keyed userId|shadeIdx,
 * swept with the session's own TTL. */
const _buffers = new Map();
function bufKey(userId, idx) { return `${userId}|${idx}`; }
function keepBuffer(userId, idx, buffer) { _buffers.set(bufKey(userId, idx), { buffer, at: Date.now() }); }
function takeBuffer(userId, idx) { const k = bufKey(userId, idx); const v = _buffers.get(k); _buffers.delete(k); return v ? v.buffer : null; }
function dropBuffers(userId) { for (const k of [..._buffers.keys()]) if (k.startsWith(`${userId}|`)) _buffers.delete(k); }
function sweepBuffers(now = Date.now()) { for (const [k, v] of _buffers) if (now - v.at > TTL_MS) _buffers.delete(k); }

function fmtBytes(n) {
  if (!n) return '';
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
const cmpNum = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });

/* ── screens ─────────────────────────────────────────────────────────── */

async function start(bot, chatId, userId, messageId = null) {
  sweepBuffers();
  dropBuffers(userId);
  const old = sessionStore.get(userId);
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'design', ttlMs: TTL_MS,
    flowMessageId: messageId || (old && old.flowMessageId) || null,
    _page: 0, _staged: {}, _skipped: {}, _previewIds: [],
  });
  await showDesigns(bot, chatId, userId);
}

async function showDesigns(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let designs = [];
  try {
    const active = await designAssetsRepo.list('active');
    designs = [...new Set(active.map((r) => String(r.design || '').trim()).filter(Boolean))].sort(cmpNum);
  } catch (e) {
    logger.warn(`shadePhotoFlow.showDesigns: ${e.message}`);
  }
  if (!designs.length) {
    await render(bot, chatId, userId,
      'No design has a catalogue photo yet. Upload one via 📷 *Upload Product Photo* first — its shade tabs are what the shade photos hang on.',
      [menuRow()]);
    return;
  }
  // ✓ = at least one active shade photo (any container).
  let withPhotos = new Set();
  try {
    const rows = await require('../repositories/designShadeAssetsRepository').list('active');
    withPhotos = new Set(rows.map((r) => String(r.design).toUpperCase()));
  } catch (_) { /* no marks */ }
  const pages = Math.max(1, Math.ceil(designs.length / DESIGNS_PER_PAGE));
  const page = Math.min(Math.max(0, session._page || 0), pages - 1);
  const slice = designs.slice(page * DESIGNS_PER_PAGE, (page + 1) * DESIGNS_PER_PAGE);
  session.step = 'design';
  session._page = page;
  session._designs = slice;
  sessionStore.set(userId, session);
  const chips = slice.map((d, i) => ({
    text: `${withPhotos.has(d.toUpperCase()) ? '✓ ' : ''}${d}`, callback_data: `shp:d:${i}`,
  }));
  const rows = chunk(chips, PER_ROW);
  if (pages > 1) {
    rows.push([
      { text: page > 0 ? '⬅' : ' ', callback_data: page > 0 ? `shp:pg:${page - 1}` : 'shp:noop' },
      { text: `${page + 1}/${pages}`, callback_data: 'shp:noop' },
      { text: page < pages - 1 ? '➡' : ' ', callback_data: page < pages - 1 ? `shp:pg:${page + 1}` : 'shp:noop' },
    ]);
  }
  rows.push(menuRow());
  await render(bot, chatId, userId,
    'Pick the design. One garment picture per shade — it shows the moment a shade is selected.\n_(✓ = already has shade photos)_', rows);
}

/** Container step — only when the design's catalogue has more than one. */
async function pickDesign(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const design = (session._designs || [])[idx];
  if (!design) return;
  session.design = design;
  session._staged = {}; session._skipped = {}; dropBuffers(userId);
  let batches = [];
  try {
    const active = (await designAssetsRepo.list('active')).filter((r) => String(r.design).toUpperCase() === design.toUpperCase());
    batches = [...new Set(active.map((r) => String(r.arrivalBatch || '').trim()))];
  } catch (_) { batches = ['']; }
  if (batches.length <= 1) {
    session.arrivalBatch = batches[0] || '';
    sessionStore.set(userId, session);
    await showShades(bot, chatId, userId);
    return;
  }
  session.step = 'batch';
  session._batches = batches;
  sessionStore.set(userId, session);
  const rows = batches.map((b, i) => [{ text: b ? `📦 ${b}` : '🌐 Generic (all containers)', callback_data: `shp:b:${i}` }]);
  rows.push([{ text: '⬅ Designs', callback_data: 'shp:back' }], cancelRow());
  await render(bot, chatId, userId,
    `*${mdEscape(design)}* has a catalogue photo per container, and shade tabs can differ per shipment. Which container are these garment pictures for?`, rows);
}

async function showShades(bot, chatId, userId, note = '') {
  const session = sessionStore.get(userId);
  if (!session || !session.design) return;
  let shades = [];
  try {
    const asset = await designAssetsRepo.findActive(session.design, session.arrivalBatch);
    shades = (asset && asset.shades) || [];
  } catch (_) { shades = []; }
  if (!shades.length) {
    await render(bot, chatId, userId,
      `*${mdEscape(session.design)}* has no shade tabs recorded. Add the shade names in 🖼️ *Manage Product Photos* first, then come back.`,
      [[{ text: '⬅ Designs', callback_data: 'shp:back' }], menuRow()]);
    session.step = 'design'; sessionStore.set(userId, session);
    return;
  }
  let have = new Map();
  try { have = await shadeAssets.activeShadeMap(session.design, session.arrivalBatch); } catch (_) { /* none */ }
  session.step = 'shades';
  session._shades = shades.map((s) => ({
    number: String(s.number), name: String(s.name || '').trim(), has: have.has(String(s.number)),
  }));
  sessionStore.set(userId, session);
  const staged = session._staged || {};
  const stagedCount = Object.keys(staged).length;
  const rows = session._shades.map((s, i) => {
    const mark = staged[i] ? '🆕 ' : (s.has ? '✓ ' : '');
    return [{ text: `${mark}${s.number} - ${s.name || 'Shade ' + s.number}`, callback_data: `shp:s:${i}` }];
  });
  const missing = nextMissing(session);
  if (missing !== -1) rows.push([{ text: '📷 Add next missing', callback_data: 'shp:next' }]);
  if (stagedCount) rows.push([{ text: `✅ Done — send ${stagedCount} for approval`, callback_data: 'shp:done' }]);
  rows.push([{ text: '⬅ Designs', callback_data: 'shp:back' }], cancelRow());
  const where = session.arrivalBatch ? ` · 📦 ${mdEscape(session.arrivalBatch)}` : '';
  await render(bot, chatId, userId,
    `*${mdEscape(session.design)}*${where}\n${note ? `${note}\n` : ''}Tap a shade to add its garment picture.\n_(✓ = has a photo · 🆕 = added now, waiting for ✅ Done)_`, rows);
}

/** Index of the first shade with neither a live photo nor a staged/skipped one; -1 when none. */
function nextMissing(session) {
  const shades = session._shades || [];
  for (let i = 0; i < shades.length; i += 1) {
    if (shades[i].has) continue;
    if ((session._staged || {})[i]) continue;
    if ((session._skipped || {})[i]) continue;
    return i;
  }
  return -1;
}

async function promptPhoto(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const s = (session._shades || [])[idx];
  if (!s) return;
  session.step = 'photo';
  session.shadeIdx = idx;
  sessionStore.set(userId, session);
  const replacing = s.has ? '\n_(this shade already has a photo — the new one replaces it on approval)_' : '';
  await render(bot, chatId, userId,
    `*${mdEscape(session.design)} · shade ${s.number} - ${mdEscape(s.name || '')}*\n\n`
    + 'Send the garment picture for this shade.\n\n'
    + '📎 For full quality send it as a *File* (📎 → File), not as a photo — Telegram compresses photos.'
    + replacing,
    [[{ text: '⏭ Skip this shade', callback_data: `shp:skip:${idx}` }], [{ text: '⬅ Shades', callback_data: 'shp:back' }], cancelRow()]);
}

/* ── file intake ─────────────────────────────────────────────────────── */

/**
 * Photo OR document from the uploader while the prompt is up. Returns true
 * when consumed. Called from the controller's handleFileMessage.
 */
async function handleFile(bot, chatId, userId, msg) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || session.step !== 'photo') return false;
  const idx = session.shadeIdx;
  const s = (session._shades || [])[idx];
  if (!s) return false;

  let fileId = ''; let kind = 'photo'; let mime = 'image/jpeg';
  if (msg.document) {
    mime = String(msg.document.mime_type || '').toLowerCase();
    if (!/^image\//.test(mime)) {
      await bot.sendMessage(chatId, '⚠️ Send an image file (JPG, PNG or WEBP).');
      return true;
    }
    fileId = msg.document.file_id; kind = 'document';
  } else if (Array.isArray(msg.photo) && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else {
    return false;
  }

  await render(bot, chatId, userId, `⏳ Processing *${mdEscape(session.design)} · #${s.number}* — stamping at full resolution…`, [cancelRow()]);
  let dl;
  try {
    dl = await require('../utils/telegramFiles').downloadTelegramFile(bot, fileId);
  } catch (e) {
    logger.warn(`shadePhotoFlow: download failed — ${e.message}`);
    await promptPhoto(bot, chatId, userId, idx);
    await bot.sendMessage(chatId, `⚠️ Could not download that picture (${e.message}). Telegram lets a bot fetch files up to 20 MB — send it again, or a smaller file.`);
    return true;
  }
  let staged;
  try {
    staged = await shadeAssets.stage({
      design: session.design, shadeNo: s.number, shadeName: s.name, arrivalBatch: session.arrivalBatch,
      sourceBuffer: dl.buffer, sourceFileId: fileId, sourceKind: kind, sourceMime: mime, uploadedBy: userId,
    });
  } catch (e) {
    logger.error(`shadePhotoFlow: stage failed — ${e.message}`);
    await promptPhoto(bot, chatId, userId, idx);
    await bot.sendMessage(chatId, `⚠️ Could not process that picture: ${e.message}`);
    return true;
  }

  // Preview. The photo form is Telegram-compressed by definition; a file
  // Telegram would refuse as a photo (>10 MB / >10000 px summed) gets a
  // viewing copy — the stored bytes are untouched either way.
  let previewBytes = staged.labeledBuffer;
  if (previewBytes.length > PHOTO_MAX_BYTES || (staged.width + staged.height) > PHOTO_MAX_DIM_SUM) {
    try { previewBytes = await imageOverlay.normalizePhoto(staged.labeledBuffer); } catch (_) { /* try as-is */ }
  }
  const quality = kind === 'document'
    ? '✅ full quality (sent as file)'
    : '⚠️ sent as photo — Telegram compressed it. Send as *File* for full quality.';
  const caption = `🎨 *${mdEscape(session.design)} · #${s.number} ${mdEscape(s.name || '')}*\n📐 ${staged.width}×${staged.height} · ${fmtBytes(staged.bytes)}\n${quality}`;
  let preview = null;
  try {
    preview = await bot.sendPhoto(chatId, previewBytes, {
      caption, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Use it', callback_data: `shp:use:${idx}` }, { text: '🔁 Retake', callback_data: `shp:retake:${idx}` }],
        [{ text: '⏭ Skip this shade', callback_data: `shp:skip:${idx}` }],
      ] },
    });
  } catch (e) {
    logger.warn(`shadePhotoFlow: preview send failed — ${e.message}`);
    await promptPhoto(bot, chatId, userId, idx);
    await bot.sendMessage(chatId, `⚠️ Could not show the preview (${e.message}). Send the picture again.`);
    return true;
  }
  const photoFileId = preview && preview.photo && preview.photo.length ? preview.photo[preview.photo.length - 1].file_id : '';
  keepBuffer(userId, idx, staged.labeledBuffer);
  const s2 = sessionStore.get(userId);
  if (!s2) return true;
  s2.step = 'confirm';
  s2._pending = {
    idx,
    previewMessageId: preview && preview.message_id,
    staged: { ...staged, labeledBuffer: undefined, telegramFileId: photoFileId },
  };
  s2._previewIds = [...(s2._previewIds || []), preview && preview.message_id].filter(Boolean);
  sessionStore.set(userId, s2);
  return true;
}

/* ── decisions ───────────────────────────────────────────────────────── */

async function freezePreview(bot, chatId, messageId, label) {
  if (!messageId) return;
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: label, callback_data: 'shp:noop' }]] },
      { chat_id: chatId, message_id: messageId });
  } catch (_) { /* gone */ }
}

async function useIt(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session || !session._pending || session._pending.idx !== idx) return;
  const p = session._pending;
  const staged = p.staged;
  const s = (session._shades || [])[idx];
  // Full-quality copy kept inside Telegram too — the document form's
  // file_id makes 🔍 Full-quality picture instant and Drive-independent.
  const buffer = takeBuffer(userId, idx);
  if (buffer) {
    try {
      const sent = await bot.sendDocument(chatId, buffer, {
        caption: `📎 ${staged.design} · #${staged.shadeNo} — full-quality copy kept (${staged.width}×${staged.height})`,
        disable_notification: true,
      }, { filename: `${staged.design.replace(/[^A-Za-z0-9._-]+/g, '_')}_shade_${staged.shadeNo}.${staged.labeledMime === 'image/png' ? 'png' : 'jpg'}`, contentType: staged.labeledMime || 'image/jpeg' });
      if (sent && sent.document && sent.document.file_id) staged.telegramDocFileId = sent.document.file_id;
      if (sent && sent.message_id) session._previewIds.push(sent.message_id);
    } catch (e) {
      logger.warn(`shadePhotoFlow.useIt: document copy failed — ${e.message}`);
    }
  }
  session._staged[idx] = staged;
  delete session._skipped[idx];
  session._pending = null;
  sessionStore.set(userId, session);
  await freezePreview(bot, chatId, p.previewMessageId, `✅ ${s ? `${s.number} - ${s.name}` : 'kept'}`);
  await advance(bot, chatId, userId);
}

async function retake(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const p = session._pending;
  takeBuffer(userId, idx);
  if (p && p.idx === idx) { await freezePreview(bot, chatId, p.previewMessageId, '🔁 replaced'); session._pending = null; }
  delete session._staged[idx];
  sessionStore.set(userId, session);
  await promptPhoto(bot, chatId, userId, idx);
}

async function skip(bot, chatId, userId, idx) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const p = session._pending;
  takeBuffer(userId, idx);
  if (p && p.idx === idx) { await freezePreview(bot, chatId, p.previewMessageId, '⏭ skipped'); session._pending = null; }
  delete session._staged[idx];
  session._skipped[idx] = true;
  sessionStore.set(userId, session);
  await advance(bot, chatId, userId);
}

/** After a decision: next shade without a photo, else the list with ✅ Done. */
async function advance(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const next = nextMissing(session);
  if (next !== -1) { await promptPhoto(bot, chatId, userId, next); return; }
  const n = Object.keys(session._staged || {}).length;
  await showShades(bot, chatId, userId, n ? `Every shade has a picture. Tap *✅ Done* to send ${n} for approval.` : '');
}

/* ── submit ──────────────────────────────────────────────────────────── */

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const list = Object.keys(session._staged || {}).map((k) => session._staged[k]).filter(Boolean)
    .sort((a, b) => cmpNum(a.shadeNo, b.shadeNo));
  if (!list.length) { await showShades(bot, chatId, userId, 'Nothing added yet.'); return; }
  const requestId = require('crypto').randomUUID();
  try {
    await shadeAssets.persistPending(list, requestId);
  } catch (e) {
    logger.error(`shadePhotoFlow.submit: persistPending failed — ${e.message}`);
    await render(bot, chatId, userId, `⚠️ Could not save the shade photos: ${mdEscape(e.message)}`, [[{ text: '🔁 Try again', callback_data: 'shp:done' }], cancelRow()]);
    return;
  }
  const shades = list.map((s) => ({ number: s.shadeNo, name: s.shadeName }));
  const approvalQueueRepository = require('../repositories/approvalQueueRepository');
  await approvalQueueRepository.append({
    requestId, user: userId,
    actionJSON: {
      action: 'design_asset_upload', kind: 'shade',
      design: session.design, arrivalBatch: session.arrivalBatch || '',
      shadeCount: shades.length, shades, uploaderUserId: userId,
    },
    riskReason: 'Shade photos must be approved before they appear to customers, marketers and sales.',
    status: 'pending',
  });
  try {
    await require('../repositories/auditLogRepository').append('approval_queued',
      { requestId, action: 'design_asset_upload', kind: 'shade', design: session.design, shades: shades.length }, userId);
  } catch (_) { /* audit is best-effort */ }

  const approvalCards = require('../services/approvalCards');
  const userLabel = await approvalCards.resolveUserLabel(userId, bot);
  const isAdm = (config.access.adminIds || []).includes(String(userId));
  const listLine = shades.map((s) => `${s.number} ${s.name}`.trim()).join(', ');
  const summary = `Shade photos: ${session.design}${session.arrivalBatch ? ` · ${session.arrivalBatch}` : ''} — ${shades.length} shade(s): ${listLine}`;
  const first = list.find((s) => s.telegramFileId);
  try {
    await require('../events/approvalEvents').notifyAdminsApprovalRequest(
      bot, requestId, userLabel, summary,
      'Shade photos must be approved before they appear to customers, marketers and sales.',
      isAdm ? userId : undefined,
      first ? { previewPhoto: first.telegramFileId, previewCaption: `🎨 *${mdEscape(session.design)}* · #${first.shadeNo} ${mdEscape(first.shadeName)} — first of ${shades.length}` } : {},
    );
  } catch (e) {
    logger.warn(`shadePhotoFlow.submit: notify failed — ${e.message}`);
  }
  dropBuffers(userId);
  const design = session.design;
  sessionStore.clear(userId);
  await bot.sendMessage(chatId,
    `✅ *Sent for approval*\n\n${mdEscape(design)} — ${shades.length} shade photo(s): ${mdEscape(listLine)}\nRequest: \`${requestId}\`\n\n⏳ Waiting for ${isAdm ? 'a second admin' : 'an admin'}. They go live the moment it is approved.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [menuRow()] } });
}

/* ── dispatcher ──────────────────────────────────────────────────────── */

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('shp:')) return false;
  const rest = data.slice(4);
  if (rest === 'noop') { try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ } return true; }
  const g = await guardSession(bot, query, SESSION_TYPE, { expiredText: '⏳ The Shade Photos session expired — open 🎨 Shade Photos again.' });
  if (!g) return true;
  const { session, chatId, userId } = g;

  if (rest === 'cancel') {
    dropBuffers(userId);
    sessionStore.clear(userId);
    await require('../utils/telegramUI').editOrSend(bot, chatId, session.flowMessageId, '❌ Shade Photos cancelled. Nothing was sent.',
      { reply_markup: { inline_keyboard: [menuRow()] } });
    return true;
  }
  if (rest === 'back') {
    if (session.step === 'photo' || session.step === 'confirm' || session.step === 'shades') {
      if (session.step === 'shades' || session.step === 'batch') { await showDesigns(bot, chatId, userId); return true; }
      if (session._pending) { takeBuffer(userId, session._pending.idx); session._pending = null; sessionStore.set(userId, session); }
      await showShades(bot, chatId, userId);
      return true;
    }
    await showDesigns(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('pg:')) { session._page = parseInt(rest.slice(3), 10) || 0; sessionStore.set(userId, session); await showDesigns(bot, chatId, userId); return true; }
  if (rest.startsWith('d:')) { await pickDesign(bot, chatId, userId, parseInt(rest.slice(2), 10)); return true; }
  if (rest.startsWith('b:')) {
    const i = parseInt(rest.slice(2), 10);
    session.arrivalBatch = (session._batches || [])[i] || '';
    sessionStore.set(userId, session);
    await showShades(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('s:')) { await promptPhoto(bot, chatId, userId, parseInt(rest.slice(2), 10)); return true; }
  if (rest === 'next') {
    const n = nextMissing(session);
    if (n === -1) await showShades(bot, chatId, userId, 'Every shade has a picture.');
    else await promptPhoto(bot, chatId, userId, n);
    return true;
  }
  if (rest.startsWith('use:')) { await useIt(bot, chatId, userId, parseInt(rest.slice(4), 10)); return true; }
  if (rest.startsWith('retake:')) { await retake(bot, chatId, userId, parseInt(rest.slice(7), 10)); return true; }
  if (rest.startsWith('skip:')) { await skip(bot, chatId, userId, parseInt(rest.slice(5), 10)); return true; }
  if (rest === 'done') { await submit(bot, chatId, userId); return true; }
  return true;
}

module.exports = { SESSION_TYPE, start, handleCallback, handleFile, _internals: { nextMissing, sweepBuffers } };
