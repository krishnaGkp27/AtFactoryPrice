'use strict';

/**
 * shadePhotoPresenter — SHP-1: the one place a shade tap turns into a
 * picture on screen, shared by the salesperson (srf_) card and the
 * marketer (myp:) card.
 *
 * The mechanic: a Telegram photo message can change its PICTURE, caption
 * and buttons in place (editMessageMedia). Nothing in the codebase used it
 * before SHP-1 — every flow assumed a photo message was frozen and sent a
 * second message under it. Here the swatch page becomes the garment photo
 * on the shade tap and becomes the swatch page again on Back: one message,
 * no scrolling.
 *
 * Quality: Telegram recompresses anything sent as a photo, so every card
 * that shows a shade photo also offers 🔍 Full-quality picture, which
 * delivers the stored bytes as a DOCUMENT (nothing touches them).
 *
 * Settings: SHADE_PHOTOS_ENABLED (default 1). 0 = every surface behaves
 * exactly as before SHP-1 (no morph, no chip) — live in ≤60 s, no deploy.
 */

const settingsRepository = require('../repositories/settingsRepository');
const shadeAssets = require('./designShadeAssetsService');
const logger = require('../utils/logger');

async function isEnabled() {
  try {
    const s = await settingsRepository.getAll();
    const v = s.SHADE_PHOTOS_ENABLED;
    if (v === undefined || v === null || v === '') return true;
    return Number(v) !== 0;
  } catch (_) { return true; }
}

/** Resolve the photo form, or null (also null when the feature is off). */
async function resolveShadePhoto(design, shadeNo, arrivalBatch) {
  if (!design || shadeNo === undefined || shadeNo === null || String(shadeNo) === '') return null;
  if (!(await isEnabled())) return null;
  try {
    return await shadeAssets.getShadePhotoForSend(design, shadeNo, { arrivalBatch });
  } catch (e) {
    logger.warn(`shadePhotoPresenter.resolve(${design}#${shadeNo}): ${e.message}`);
    return null;
  }
}

/** The 🔍 chip a card adds when a shade photo exists. */
function fullQualityButton(callbackData) {
  return { text: '🔍 Full-quality picture', callback_data: callbackData };
}

/** Insert `row` before the last row (the back row) — the card's tail stays a back button. */
function withRowBeforeLast(rows, row) {
  const out = [...(rows || [])];
  if (!row) return out;
  if (!out.length) return [row];
  out.splice(out.length - 1, 0, row);
  return out;
}

/** A media value editMessageMedia can take: a file_id or an https URL (never a Buffer in this client). */
function editableMedia(asset) {
  if (!asset) return '';
  if (typeof asset.photo === 'string' && asset.photo) return asset.photo;
  const fid = asset.row && (asset.row.labeledDriveFileId || asset.row.rawDriveFileId);
  return fid ? shadeAssets._internals.toDirectDownloadUrl(fid) : '';
}

/**
 * Morph the photo message `messageId` into the shade's garment photo with
 * the caller's caption + rows. When no shade photo exists the picture is
 * kept and only the caption/buttons change (still one message).
 *
 * @returns {Promise<'photo'|'caption'|false>} what happened; false = caller must fall back
 */
async function morphToShade(bot, chatId, messageId, { design, shadeNo, arrivalBatch, caption, rows, fullQualityRow, parseMode = 'Markdown' }) {
  if (!messageId) return false;
  const asset = await resolveShadePhoto(design, shadeNo, arrivalBatch);
  const media = editableMedia(asset);
  if (asset && media) {
    const kb = { inline_keyboard: withRowBeforeLast(rows, fullQualityRow) };
    try {
      const res = await bot.editMessageMedia(
        { type: 'photo', media, caption, parse_mode: parseMode },
        { chat_id: chatId, message_id: messageId, reply_markup: kb },
      );
      if (asset.photoSource !== 'telegram_file_id' && res && res.photo && res.photo.length) {
        shadeAssets.cachePhotoFileId(asset.row.rowIndex, res.photo[res.photo.length - 1].file_id).catch(() => {});
      }
      return 'photo';
    } catch (e) {
      // A re-render of the same screen is a success, not a reason to
      // delete the card and send it again.
      if (isNotModified(e)) return 'photo';
      logger.warn(`shadePhotoPresenter.morphToShade(${design}#${shadeNo}): editMessageMedia failed — ${e.message}`);
      return false;
    }
  }
  try {
    await bot.editMessageCaption(caption, {
      chat_id: chatId, message_id: messageId, parse_mode: parseMode,
      reply_markup: { inline_keyboard: rows },
    });
    return 'caption';
  } catch (e) {
    if (isNotModified(e)) return 'caption';
    logger.warn(`shadePhotoPresenter.morphToShade(${design}#${shadeNo}): editMessageCaption failed — ${e.message}`);
    return false;
  }
}

function isNotModified(e) { return /not modified/i.test(String((e && e.message) || '')); }

/**
 * Morph the message back to a page photo (file_id / URL only).
 * @returns {Promise<boolean>}
 */
async function morphToPage(bot, chatId, messageId, { photo, caption, rows, parseMode = 'Markdown' }) {
  if (!messageId || typeof photo !== 'string' || !photo) return false;
  try {
    await bot.editMessageMedia(
      { type: 'photo', media: photo, caption, parse_mode: parseMode },
      { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } },
    );
    return true;
  } catch (e) {
    if (isNotModified(e)) return true;
    logger.warn(`shadePhotoPresenter.morphToPage: editMessageMedia failed — ${e.message}`);
    return false;
  }
}

/**
 * Deliver the full-quality bytes as a document. Says so plainly when the
 * shade has no full-quality copy (source was a compressed photo and Drive
 * is unreachable).
 * @returns {Promise<boolean>}
 */
async function sendFullQuality(bot, chatId, { design, shadeNo, shadeName, arrivalBatch }) {
  let asset = null;
  try {
    if (await isEnabled()) asset = await shadeAssets.getFullQualityForSend(design, shadeNo, { arrivalBatch });
  } catch (e) {
    logger.warn(`shadePhotoPresenter.sendFullQuality(${design}#${shadeNo}): ${e.message}`);
  }
  if (!asset) {
    await bot.sendMessage(chatId,
      `🔍 No full-quality copy for *${design}* shade *${shadeNo}* yet — upload it again as a *File* (📎 → File) so the original bytes are kept.`,
      { parse_mode: 'Markdown' });
    return false;
  }
  const r = asset.row;
  const size = r.bytes ? ` · ${(r.bytes / (1024 * 1024)).toFixed(1)} MB` : '';
  const dims = r.width && r.height ? ` · ${r.width}×${r.height}` : '';
  const caption = `🔍 *${design} · #${shadeNo}${shadeName ? ` ${shadeName}` : ''}* — full quality${dims}${size}`;
  try {
    const sent = await bot.sendDocument(chatId, asset.doc, { caption, parse_mode: 'Markdown' },
      { filename: asset.filename, contentType: asset.contentType });
    if (asset.docSource !== 'telegram_doc_file_id' && sent && sent.document && sent.document.file_id) {
      shadeAssets.cacheDocFileId(r.rowIndex, sent.document.file_id).catch(() => {});
    }
    return true;
  } catch (e) {
    logger.warn(`shadePhotoPresenter.sendFullQuality(${design}#${shadeNo}): sendDocument failed — ${e.message}`);
    await bot.sendMessage(chatId, '⚠️ Could not send the full-quality picture just now — try again in a moment.');
    return false;
  }
}

module.exports = {
  isEnabled, resolveShadePhoto, morphToShade, morphToPage, sendFullQuality,
  fullQualityButton, withRowBeforeLast,
  _internals: { editableMedia },
};
