/**
 * Design-asset service — product-photo lifecycle for the Telegram bot.
 *
 * Responsibilities:
 *   1. Process an upload (raw photo + metadata) → generate labeled photo →
 *      stash both in Drive → enqueue for 2-admin approval.
 *   2. On approval, mark the asset 'active' and supersede any older asset
 *      for the same design (so consumers always read the freshest photo).
 *   3. Provide getPhotoForSend(design) — used by sale/supply/sample/order/
 *      report/stock pickers to send a photo with shade buttons (or an
 *      on-demand "View" reply). Returns null if no active asset exists,
 *      letting consumers gracefully fall back to text-only pickers.
 *   4. Cache the Telegram file_id after the first send for instant
 *      subsequent dispatch (no Drive download cost).
 *
 * No new external dependency surfaces here beyond `sharp` (used inside
 * imageOverlay) — Drive and Sheets are reused.
 */

const designAssetsRepo = require('../repositories/designAssetsRepository');
const driveClient = require('../repositories/driveClient');
const inventoryRepository = require('../repositories/inventoryRepository');
const imageOverlay = require('../utils/imageOverlay');
const logger = require('../utils/logger');

/**
 * Detect the productType for a given design from the inventory.
 * Falls back to 'fabric' if no rows exist.
 */
async function detectProductType(design) {
  if (!design) return 'fabric';
  try {
    const rows = await inventoryRepository.findByDesign(design);
    if (rows && rows.length) {
      const t = (rows[0].productType || '').toString().trim().toLowerCase();
      if (t) return t;
    }
  } catch (e) {
    logger.warn(`detectProductType failed for ${design}`, e.message);
  }
  return 'fabric';
}

/** Sanitize a design number for use in a filename. */
function safeName(s) {
  return String(s || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
}

/**
 * Stage an upload — generate the labeled JPEG, push raw + labeled to Drive,
 * and return everything the caller needs to write an ApprovalQueue row and
 * an optional preview to the uploader.
 *
 * @param {object} params
 * @param {string} params.design               (required)
 * @param {Buffer} params.rawBuffer            (required) raw photo bytes
 * @param {number} params.shadeCount           (>=1)
 * @param {string[]} params.shadeNames         length === shadeCount
 * @param {string} params.uploadedBy           Telegram user id
 * @param {string} [params.notes]
 * @returns {{
 *   design, productType, shadeCount, shadeNames,
 *   rawDriveFileId, rawDriveUrl, labeledDriveFileId, labeledDriveUrl,
 *   labeledBuffer
 * }}
 */
async function stageUpload({ design, rawBuffer, shadeCount, shadeNames, uploadedBy, notes }) {
  if (!design) throw new Error('design is required');
  if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
    throw new Error('rawBuffer is required');
  }
  if (!shadeCount || shadeCount < 1) throw new Error('shadeCount must be >= 1');
  const names = Array.isArray(shadeNames) ? shadeNames.slice(0, shadeCount) : [];
  while (names.length < shadeCount) names.push(`Shade ${names.length + 1}`);

  const productType = await detectProductType(design);

  const safe = safeName(design);
  const ts = Date.now();

  // 1. Normalize the raw photo (rotate + resize) so what we store is
  //    Telegram-friendly. We still keep this as "raw" — i.e. unstamped.
  let normalizedRaw;
  try {
    normalizedRaw = await imageOverlay.normalizePhoto(rawBuffer);
  } catch (e) {
    logger.warn(`normalizePhoto failed for ${design}; using buffer as-is`, e.message);
    normalizedRaw = rawBuffer;
  }

  // 2. Generate the labeled (design-stamped) version.
  let labeledBuffer = null;
  try {
    const stamped = await imageOverlay.stampDesignNumber(normalizedRaw, design);
    labeledBuffer = stamped.buffer;
  } catch (e) {
    logger.warn(`stampDesignNumber failed for ${design}; falling back to normalized raw`, e.message);
    labeledBuffer = normalizedRaw;
  }

  // 3. Upload both to Drive (best-effort — if one fails, return whatever we have).
  let rawDriveFileId = '', rawDriveUrl = '';
  let labeledDriveFileId = '', labeledDriveUrl = '';
  try {
    const r = await driveClient.uploadFile(normalizedRaw, `design_${safe}_raw_${ts}.jpg`, 'image/jpeg');
    rawDriveFileId = r.fileId; rawDriveUrl = r.webViewLink;
  } catch (e) {
    logger.error(`Drive upload (raw) failed for ${design}`, e.message);
  }
  try {
    const l = await driveClient.uploadFile(labeledBuffer, `design_${safe}_labeled_${ts}.jpg`, 'image/jpeg');
    labeledDriveFileId = l.fileId; labeledDriveUrl = l.webViewLink;
  } catch (e) {
    logger.error(`Drive upload (labeled) failed for ${design}`, e.message);
  }

  return {
    design: String(design).trim(),
    productType,
    shadeCount,
    shadeNames: names,
    rawDriveFileId, rawDriveUrl,
    labeledDriveFileId, labeledDriveUrl,
    labeledBuffer,
    uploadedBy: String(uploadedBy || ''),
    uploadedAt: new Date().toISOString(),
    notes: notes || '',
  };
}

/**
 * Persist a staged upload (returned by stageUpload) into the DesignAssets
 * sheet in 'pending' state, linked to an approval request id.
 */
async function persistPending(staged, approvalRequestId) {
  await designAssetsRepo.append({
    design: staged.design,
    productType: staged.productType,
    shadeCount: staged.shadeCount,
    shadeNames: staged.shadeNames,
    rawDriveFileId: staged.rawDriveFileId,
    rawDriveUrl: staged.rawDriveUrl,
    labeledDriveFileId: staged.labeledDriveFileId,
    labeledDriveUrl: staged.labeledDriveUrl,
    telegramFileId: '',
    status: 'pending',
    uploadedBy: staged.uploadedBy,
    uploadedAt: staged.uploadedAt,
    approvalRequestId: approvalRequestId || '',
    approvedBy: '',
    notes: staged.notes || '',
  });
}

/**
 * Activate an asset previously persisted by persistPending. Marks any older
 * active asset for the same design as 'replaced' so getPhotoForSend always
 * returns the freshest photo.
 *
 * Called from inventoryService.executeApprovedAction for action
 * 'design_asset_upload'.
 */
async function activateByApprovalRequestId(approvalRequestId, approvedBy) {
  const row = await designAssetsRepo.findByApprovalRequestId(approvalRequestId);
  if (!row) return { ok: false, message: 'Asset not found.' };

  // Supersede any prior active version for this design (idempotent).
  await designAssetsRepo.deactivatePriorActive(row.design);
  await designAssetsRepo.updateStatus(row.rowIndex, 'active', approvedBy || '');
  return { ok: true, design: row.design };
}

/**
 * Reject (rather than activate) an asset on approval rejection.
 */
async function rejectByApprovalRequestId(approvalRequestId, rejectedBy) {
  const row = await designAssetsRepo.findByApprovalRequestId(approvalRequestId);
  if (!row) return { ok: false };
  await designAssetsRepo.updateStatus(row.rowIndex, 'inactive', rejectedBy || '');
  return { ok: true };
}

/**
 * Get the active asset for a design, in a form ready for `bot.sendPhoto(...)`.
 *
 * @param {string} design
 * @returns {Promise<null | {
 *   rowIndex: number,
 *   design: string,
 *   productType: string,
 *   shadeCount: number,
 *   shadeNames: string[],
 *   photo: string,            // value to pass to sendPhoto: telegramFileId or driveUrl or driveFileId-as-url
 *   photoSource: 'telegram_file_id' | 'drive_url',
 *   telegramFileId: string,
 *   labeledDriveUrl: string,
 *   labeledDriveFileId: string,
 * }>}
 */
async function getPhotoForSend(design) {
  if (!design) return null;
  const row = await designAssetsRepo.findActive(design);
  if (!row) return null;

  // Prefer the cached Telegram file_id (instant); otherwise use the labeled Drive URL.
  if (row.telegramFileId) {
    return {
      rowIndex: row.rowIndex,
      design: row.design,
      productType: row.productType,
      shadeCount: row.shadeCount,
      shadeNames: row.shadeNames,
      photo: row.telegramFileId,
      photoSource: 'telegram_file_id',
      telegramFileId: row.telegramFileId,
      labeledDriveUrl: row.labeledDriveUrl,
      labeledDriveFileId: row.labeledDriveFileId,
    };
  }
  // Drive direct-download URL (works for sendPhoto if file is shared with anyone).
  const url = row.labeledDriveUrl
    ? toDirectDownloadUrl(row.labeledDriveFileId)
    : (row.rawDriveFileId ? toDirectDownloadUrl(row.rawDriveFileId) : '');
  if (!url) return null;
  return {
    rowIndex: row.rowIndex,
    design: row.design,
    productType: row.productType,
    shadeCount: row.shadeCount,
    shadeNames: row.shadeNames,
    photo: url,
    photoSource: 'drive_url',
    telegramFileId: '',
    labeledDriveUrl: row.labeledDriveUrl,
    labeledDriveFileId: row.labeledDriveFileId,
  };
}

function toDirectDownloadUrl(fileId) {
  if (!fileId) return '';
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

/**
 * Cache the Telegram file_id after the first successful send so subsequent
 * sends don't hit Drive at all. Best-effort; never throws upward.
 */
async function cacheTelegramFileId(rowIndex, telegramFileId) {
  if (!rowIndex || !telegramFileId) return;
  try {
    await designAssetsRepo.setTelegramFileId(rowIndex, telegramFileId);
  } catch (e) {
    logger.warn(`cacheTelegramFileId failed for row ${rowIndex}`, e.message);
  }
}

/**
 * Convenience: send a product photo with an inline-keyboard composed of
 * shade buttons. If no asset exists for the design, return false so the
 * caller can fall back to its existing text-only picker.
 *
 * Each shade button calls `buildShadeButton(name, index)` to produce the
 * `{text, callback_data}` object — this lets each consumer flow plug in
 * its own callback prefix without coupling.
 *
 * @param {object} params
 * @param {object} params.bot                 node-telegram-bot-api instance
 * @param {string|number} params.chatId
 * @param {string} params.design
 * @param {string} [params.captionPrefix]     additional text prepended to the photo caption
 * @param {(name: string, index: number) => {text:string,callback_data:string}} params.buildShadeButton
 * @param {Array<Array<{text:string,callback_data:string}>>} [params.extraRows]
 *        e.g. [[{ text: '❌ Cancel', callback_data: '...' }]]
 * @param {number} [params.buttonsPerRow=3]
 * @returns {Promise<boolean>} true if photo sent, false if no asset (caller falls back)
 */
async function sendShadePicker({ bot, chatId, design, captionPrefix, buildShadeButton, extraRows, buttonsPerRow }) {
  const asset = await getPhotoForSend(design);
  if (!asset) return false;
  const perRow = Math.max(1, Math.min(4, buttonsPerRow || 3));

  const names = (asset.shadeNames && asset.shadeNames.length)
    ? asset.shadeNames
    : Array.from({ length: asset.shadeCount || 1 }, (_, i) => `Shade ${i + 1}`);

  const rows = [];
  for (let i = 0; i < names.length; i += perRow) {
    const row = [];
    for (let j = i; j < Math.min(i + perRow, names.length); j++) {
      row.push(buildShadeButton(names[j], j));
    }
    rows.push(row);
  }
  for (const r of (extraRows || [])) rows.push(r);

  const cap = `${captionPrefix ? captionPrefix + '\n' : ''}📷 *${asset.design}* — tap a shade${asset.productType && asset.productType !== 'fabric' ? ' (' + asset.productType + ')' : ''}`;
  try {
    const sent = await bot.sendPhoto(chatId, asset.photo, {
      caption: cap,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: rows },
    });
    // Cache the Telegram file_id (best effort, async, never blocks).
    if (asset.photoSource !== 'telegram_file_id' && sent && sent.photo && sent.photo.length) {
      const fid = sent.photo[sent.photo.length - 1].file_id;
      cacheTelegramFileId(asset.rowIndex, fid).catch(() => {});
    }
    return true;
  } catch (e) {
    logger.warn(`sendShadePicker failed for ${design}: ${e.message} — falling back to text picker`);
    return false;
  }
}

/**
 * Send the product photo *only* (no shade buttons), useful for design-only
 * pickers (e.g. order flow where shade isn't selected).
 *
 * @returns {Promise<boolean>} true if photo sent
 */
async function sendDesignPhoto({ bot, chatId, design, caption, extraRows }) {
  const asset = await getPhotoForSend(design);
  if (!asset) return false;
  try {
    const sent = await bot.sendPhoto(chatId, asset.photo, {
      caption: caption || `📷 *${asset.design}*`,
      parse_mode: 'Markdown',
      reply_markup: extraRows && extraRows.length ? { inline_keyboard: extraRows } : undefined,
    });
    if (asset.photoSource !== 'telegram_file_id' && sent && sent.photo && sent.photo.length) {
      const fid = sent.photo[sent.photo.length - 1].file_id;
      cacheTelegramFileId(asset.rowIndex, fid).catch(() => {});
    }
    return true;
  } catch (e) {
    logger.warn(`sendDesignPhoto failed for ${design}: ${e.message}`);
    return false;
  }
}

module.exports = {
  stageUpload,
  persistPending,
  activateByApprovalRequestId,
  rejectByApprovalRequestId,
  getPhotoForSend,
  cacheTelegramFileId,
  sendShadePicker,
  sendDesignPhoto,
  detectProductType,
};
