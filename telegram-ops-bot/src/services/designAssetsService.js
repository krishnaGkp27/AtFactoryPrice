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
 * @param {Array<{number:number,name:string}>} [params.shades]
 *        Preferred: array of {number, name} pairs (numbers may be non-sequential, e.g. 3..11).
 * @param {number}   [params.shadeCount]       Required only if `shades` is omitted (legacy path).
 * @param {string[]} [params.shadeNames]       Legacy path — auto-numbered 1..N.
 * @param {string}   params.uploadedBy         Telegram user id
 * @param {string}   [params.notes]
 * @returns {{
 *   design, productType, shadeCount, shades, shadeNames,
 *   rawDriveFileId, rawDriveUrl, labeledDriveFileId, labeledDriveUrl,
 *   labeledBuffer
 * }}
 */
async function stageUpload({ design, rawBuffer, shades, shadeCount, shadeNames, uploadedBy, notes }) {
  if (!design) throw new Error('design is required');
  if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
    throw new Error('rawBuffer is required');
  }

  // Resolve to canonical [{number, name}] list, preferring `shades` when given.
  let canonical;
  if (Array.isArray(shades) && shades.length) {
    canonical = shades
      .map((s) => ({ number: parseInt(s.number, 10), name: String(s.name || '').trim() }))
      .filter((s) => Number.isFinite(s.number) && s.number > 0);
  } else {
    if (!shadeCount || shadeCount < 1) throw new Error('shadeCount must be >= 1 when `shades` not provided');
    const names = Array.isArray(shadeNames) ? shadeNames.slice(0, shadeCount) : [];
    while (names.length < shadeCount) names.push(`Shade ${names.length + 1}`);
    canonical = names.map((n, i) => ({ number: i + 1, name: n }));
  }
  if (!canonical.length) throw new Error('At least one shade is required');
  // De-duplicate by number, keep first.
  const seen = new Set();
  canonical = canonical.filter((s) => { if (seen.has(s.number)) return false; seen.add(s.number); return true; });
  canonical.sort((a, b) => a.number - b.number);

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
  //    On failure, the caller can still persist the asset using a Telegram
  //    file_id captured from the preview send. So Drive loss degrades gracefully.
  let rawDriveFileId = '', rawDriveUrl = '';
  let labeledDriveFileId = '', labeledDriveUrl = '';
  try {
    const r = await driveClient.uploadFile(normalizedRaw, `design_${safe}_raw_${ts}.jpg`, 'image/jpeg');
    rawDriveFileId = r.fileId; rawDriveUrl = r.webViewLink;
  } catch (e) {
    logger.error(`Drive upload (raw) failed for ${design}: ${e.message}`);
  }
  try {
    const l = await driveClient.uploadFile(labeledBuffer, `design_${safe}_labeled_${ts}.jpg`, 'image/jpeg');
    labeledDriveFileId = l.fileId; labeledDriveUrl = l.webViewLink;
  } catch (e) {
    logger.error(`Drive upload (labeled) failed for ${design}: ${e.message}`);
  }
  if (!rawDriveFileId && !labeledDriveFileId) {
    logger.warn(`stageUpload(${design}): Drive uploads BOTH failed. Asset will rely on the Telegram file_id captured at preview-send time. Verify Drive API is enabled + the service account has Editor access to the configured folder.`);
  }

  return {
    design: String(design).trim(),
    productType,
    shadeCount: canonical.length,
    shades: canonical,
    shadeNames: canonical.map((s) => s.name),
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
  // We accept staged.telegramFileId so the controller can pass through
  // the file_id captured when the labeled preview was sent at upload
  // time. This makes the asset serveable from Telegram alone, even when
  // Drive uploads fail (e.g. Drive API disabled, quota exhausted,
  // service-account permission gap). Defense-in-depth.
  await designAssetsRepo.append({
    design: staged.design,
    productType: staged.productType,
    shadeCount: staged.shadeCount,
    shades: staged.shades,
    shadeNames: staged.shadeNames,
    rawDriveFileId: staged.rawDriveFileId,
    rawDriveUrl: staged.rawDriveUrl,
    labeledDriveFileId: staged.labeledDriveFileId,
    labeledDriveUrl: staged.labeledDriveUrl,
    telegramFileId: staged.telegramFileId || '',
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
 * Photo dispatch strategy (in priority order):
 *   1. Cached telegramFileId  → instant, no network.
 *   2. Buffer from Drive      → reliable, captures a fresh file_id on first send.
 *   3. Drive direct URL       → last-resort fallback (Telegram fetches the URL).
 *
 * @param {string} design
 * @returns {Promise<null | {
 *   rowIndex, design, productType, shadeCount, shades, shadeNames,
 *   photo,                           // value passed to sendPhoto
 *   photoSource: 'telegram_file_id' | 'drive_buffer' | 'drive_url',
 *   telegramFileId, labeledDriveUrl, labeledDriveFileId
 * }>}
 */
async function getPhotoForSend(design) {
  if (!design) return null;
  const row = await designAssetsRepo.findActive(design);
  if (!row) {
    logger.info(`getPhotoForSend(${design}): no active asset`);
    return null;
  }

  const baseInfo = {
    rowIndex: row.rowIndex,
    design: row.design,
    productType: row.productType,
    shadeCount: row.shadeCount,
    shades: row.shades || [],
    shadeNames: row.shadeNames,
    telegramFileId: row.telegramFileId || '',
    labeledDriveUrl: row.labeledDriveUrl,
    labeledDriveFileId: row.labeledDriveFileId,
  };

  // 1. Cached file_id wins — instant subsequent sends.
  if (row.telegramFileId) {
    return { ...baseInfo, photo: row.telegramFileId, photoSource: 'telegram_file_id' };
  }

  // 2. Download from Drive into a Buffer. Telegram will fetch directly from
  //    bytes we hand it, sidestepping any Drive URL-fetch quirks.
  const fileId = row.labeledDriveFileId || row.rawDriveFileId;
  if (fileId) {
    try {
      const buffer = await driveClient.downloadFile(fileId);
      logger.info(`getPhotoForSend(${design}): downloaded ${buffer.length}B from Drive (${fileId})`);
      return { ...baseInfo, photo: buffer, photoSource: 'drive_buffer' };
    } catch (e) {
      logger.warn(`getPhotoForSend(${design}): Drive download failed (${e.message}); falling back to Drive URL`);
    }
  }

  // 3. Last-resort Drive direct-download URL.
  const url = row.labeledDriveFileId
    ? toDirectDownloadUrl(row.labeledDriveFileId)
    : (row.rawDriveFileId ? toDirectDownloadUrl(row.rawDriveFileId) : '');
  if (!url) {
    logger.warn(`getPhotoForSend(${design}): asset has no Drive file ids — cannot serve`);
    return null;
  }
  return { ...baseInfo, photo: url, photoSource: 'drive_url' };
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

  // Prefer the structured {number, name} list so buttons reflect the
  // physical tab numbers stamped on the bale card. Fall back to legacy
  // sequential numbering only if the asset has no structured shades.
  const items = (Array.isArray(asset.shades) && asset.shades.length)
    ? asset.shades.map((s) => ({ number: s.number, name: s.name }))
    : (asset.shadeNames && asset.shadeNames.length)
      ? asset.shadeNames.map((n, i) => ({ number: i + 1, name: n }))
      : Array.from({ length: asset.shadeCount || 1 }, (_, i) => ({ number: i + 1, name: `Shade ${i + 1}` }));

  const rows = [];
  for (let i = 0; i < items.length; i += perRow) {
    const row = [];
    for (let j = i; j < Math.min(i + perRow, items.length); j++) {
      row.push(buildShadeButton(items[j].name, j, items[j].number));
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
    logger.info(`sendShadePicker(${design}): sent via ${asset.photoSource}`);
    return true;
  } catch (e) {
    logger.warn(`sendShadePicker failed for ${design} (source=${asset.photoSource}): ${e.message}`);
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
    logger.info(`sendDesignPhoto(${design}): sent via ${asset.photoSource}`);
    return true;
  } catch (e) {
    logger.warn(`sendDesignPhoto failed for ${design} (source=${asset.photoSource}): ${e.message}`);
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
