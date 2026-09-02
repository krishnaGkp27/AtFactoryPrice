'use strict';

/**
 * designShadeAssetsService — SHP-1 shade garment photos: staging, approval
 * activation, and the two send-ready resolvers (photo view / full-quality
 * document).
 *
 * Quality contract (owner, 02-Sep-2026 — "no compromise with the quality
 * at all, at any place"):
 *   - the ORIGINAL bytes go to Drive untouched (raw);
 *   - the stamped copy is rendered at native resolution (imageOverlay.stampNative);
 *   - Telegram's photo form is always recompressed by Telegram, so every
 *     surface also offers the DOCUMENT form, which carries the bytes as-is.
 *
 * Everything Drive-related is best-effort: the BKP-1 service-account quota
 * problem is unresolved, so a photo must stay serveable from the Telegram
 * file_ids alone (the preview send at upload time yields the photo id; the
 * uploader's own file yields the source id).
 */

const repo = require('../repositories/designShadeAssetsRepository');
const driveClient = require('../repositories/driveClient');
const imageOverlay = require('../utils/imageOverlay');
const logger = require('../utils/logger');

function safeName(s) { return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_'); }
function toDirectDownloadUrl(fileId) { return fileId ? `https://drive.google.com/uc?export=download&id=${fileId}` : ''; }
function extFor(mime, fallback) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  return fallback || 'jpg';
}

/**
 * Stage one shade photo: measure, stamp at native resolution, upload raw +
 * labeled to Drive (best effort). Returns a record ready for the preview
 * send; `labeledBuffer` is for that send only and must not be kept in a
 * session.
 */
async function stage({ design, shadeNo, shadeName, arrivalBatch, sourceBuffer, sourceFileId, sourceKind, sourceMime, uploadedBy }) {
  if (!design) throw new Error('design is required');
  if (shadeNo === undefined || shadeNo === null || String(shadeNo).trim() === '') throw new Error('shadeNo is required');
  if (!Buffer.isBuffer(sourceBuffer) || !sourceBuffer.length) throw new Error('sourceBuffer is required');

  const label = `${String(design).trim()} · #${String(shadeNo).trim()}`;
  let stamped = null;
  try {
    stamped = await imageOverlay.stampNative(sourceBuffer, label);
  } catch (e) {
    logger.warn(`shadeAssets.stage(${design}#${shadeNo}): stampNative failed — ${e.message}; using the original as-is`);
  }
  let width = stamped ? stamped.width : 0;
  let height = stamped ? stamped.height : 0;
  if (!stamped) {
    try { const m = await imageOverlay.readImageMeta(sourceBuffer); width = m.width; height = m.height; } catch (_) { /* unknown */ }
  }
  const labeledBuffer = stamped ? stamped.buffer : sourceBuffer;
  const labeledMime = stamped ? stamped.mime : (sourceMime || 'image/jpeg');

  const safe = safeName(design);
  const ts = Date.now();
  let rawDriveFileId = '';
  let labeledDriveFileId = '';
  try {
    const r = await driveClient.uploadFile(sourceBuffer, `shade_${safe}_${safeName(shadeNo)}_raw_${ts}.${extFor(sourceMime, 'jpg')}`, sourceMime || 'image/jpeg');
    rawDriveFileId = r.fileId;
  } catch (e) {
    logger.error(`shadeAssets.stage(${design}#${shadeNo}): Drive upload (raw) failed — ${e.message}`);
  }
  try {
    const l = await driveClient.uploadFile(labeledBuffer, `shade_${safe}_${safeName(shadeNo)}_labeled_${ts}.${extFor(labeledMime, 'jpg')}`, labeledMime);
    labeledDriveFileId = l.fileId;
  } catch (e) {
    logger.error(`shadeAssets.stage(${design}#${shadeNo}): Drive upload (labeled) failed — ${e.message}`);
  }
  if (!rawDriveFileId && !labeledDriveFileId) {
    logger.warn(`shadeAssets.stage(${design}#${shadeNo}): both Drive uploads failed; the photo will rely on Telegram file_ids (BKP-1).`);
  }
  return {
    design: String(design).trim(),
    shadeNo: String(shadeNo).trim(),
    shadeName: String(shadeName || '').trim(),
    arrivalBatch: String(arrivalBatch || '').trim(),
    rawDriveFileId, labeledDriveFileId,
    labeledBuffer, labeledMime,
    width, height, bytes: sourceBuffer.length,
    sourceFileId: String(sourceFileId || ''),
    sourceKind: sourceKind === 'document' ? 'document' : 'photo',
    uploadedBy: String(uploadedBy || ''),
    uploadedAt: new Date().toISOString(),
  };
}

/** Persist staged shade photos as one pending batch under one approval id. */
async function persistPending(stagedList, approvalRequestId) {
  const recs = (stagedList || []).map((s) => ({
    design: s.design, shadeNo: s.shadeNo, shadeName: s.shadeName, arrivalBatch: s.arrivalBatch,
    rawDriveFileId: s.rawDriveFileId, labeledDriveFileId: s.labeledDriveFileId,
    telegramFileId: s.telegramFileId || '', telegramDocFileId: s.telegramDocFileId || '',
    sourceFileId: s.sourceFileId, sourceKind: s.sourceKind,
    status: repo.STATUSES.PENDING,
    uploadedBy: s.uploadedBy, uploadedAt: s.uploadedAt, approvalRequestId,
    width: s.width, height: s.height, bytes: s.bytes, notes: s.notes || '',
  }));
  return repo.appendMany(recs);
}

/**
 * Approval executor (inventoryService, action design_asset_upload with
 * kind 'shade'): each shade in the batch supersedes the earlier active
 * photo for the SAME (design, shade, container) and goes live.
 */
async function activateByApprovalRequestId(approvalRequestId, approvedBy) {
  const rows = await repo.findByApprovalRequestId(approvalRequestId);
  if (!rows.length) return { ok: false, message: 'Shade photos not found.' };
  for (const r of rows) {
    await repo.deactivatePriorActive(r.design, r.shadeNo, r.arrivalBatch);
  }
  await repo.updateStatus(rows.map((r) => r.rowIndex), repo.STATUSES.ACTIVE, approvedBy || '');
  return {
    ok: true, design: rows[0].design, arrivalBatch: rows[0].arrivalBatch || '', count: rows.length,
    shades: rows.map((r) => ({ number: r.shadeNo, name: r.shadeName })),
  };
}

async function rejectByApprovalRequestId(approvalRequestId, rejectedBy) {
  const rows = await repo.findByApprovalRequestId(approvalRequestId);
  if (!rows.length) return { ok: false };
  await repo.updateStatus(rows.map((r) => r.rowIndex), repo.STATUSES.INACTIVE, rejectedBy || '');
  return { ok: true, count: rows.length };
}

/**
 * The PHOTO form for a shade, ready for sendPhoto / editMessageMedia.
 * Priority: cached photo file_id → labeled Drive bytes → raw Drive bytes →
 * Drive URL → the uploader's own photo file_id (only if it was a photo).
 * @returns {Promise<null|{row:object, photo:string|Buffer, photoSource:string}>}
 */
async function getShadePhotoForSend(design, shadeNo, opts = {}) {
  const row = await repo.findActive(design, shadeNo, opts.arrivalBatch);
  if (!row) return null;
  if (row.telegramFileId) return { row, photo: row.telegramFileId, photoSource: 'telegram_file_id' };
  const fileId = row.labeledDriveFileId || row.rawDriveFileId;
  if (fileId) {
    try {
      const buffer = await driveClient.downloadFile(fileId);
      return { row, photo: buffer, photoSource: 'drive_buffer' };
    } catch (e) {
      logger.warn(`shadeAssets.getShadePhotoForSend(${design}#${shadeNo}): Drive download failed — ${e.message}`);
    }
    return { row, photo: toDirectDownloadUrl(fileId), photoSource: 'drive_url' };
  }
  if (row.sourceFileId && row.sourceKind === 'photo') return { row, photo: row.sourceFileId, photoSource: 'source_file_id' };
  return null;
}

/**
 * The FULL-QUALITY form: bytes as stored, delivered as a Telegram document
 * so nothing recompresses them. Priority: cached document file_id →
 * labeled Drive bytes → raw Drive bytes → the uploader's own document.
 * @returns {Promise<null|{row:object, doc:string|Buffer, docSource:string, filename:string, contentType:string}>}
 */
async function getFullQualityForSend(design, shadeNo, opts = {}) {
  const row = await repo.findActive(design, shadeNo, opts.arrivalBatch);
  if (!row) return null;
  const filename = `${safeName(row.design)}_shade_${safeName(row.shadeNo)}.jpg`;
  if (row.telegramDocFileId) return { row, doc: row.telegramDocFileId, docSource: 'telegram_doc_file_id', filename, contentType: 'image/jpeg' };
  for (const fileId of [row.labeledDriveFileId, row.rawDriveFileId]) {
    if (!fileId) continue;
    try {
      const buffer = await driveClient.downloadFile(fileId);
      return { row, doc: buffer, docSource: 'drive_buffer', filename, contentType: 'image/jpeg' };
    } catch (e) {
      logger.warn(`shadeAssets.getFullQualityForSend(${design}#${shadeNo}): Drive download failed — ${e.message}`);
    }
  }
  if (row.sourceFileId && row.sourceKind === 'document') return { row, doc: row.sourceFileId, docSource: 'source_document', filename, contentType: 'image/jpeg' };
  return null;
}

/** Active shade photos of a design as Map<shadeNo, row> (for ✓ marks / existence checks). */
async function activeShadeMap(design, arrivalBatch) {
  return repo.activeMapForDesign(design, arrivalBatch);
}

async function cachePhotoFileId(rowIndex, fileId) {
  if (!rowIndex || !fileId) return;
  try { await repo.setTelegramFileId(rowIndex, fileId); } catch (e) { logger.warn(`shadeAssets.cachePhotoFileId row ${rowIndex}: ${e.message}`); }
}
async function cacheDocFileId(rowIndex, fileId) {
  if (!rowIndex || !fileId) return;
  try { await repo.setTelegramDocFileId(rowIndex, fileId); } catch (e) { logger.warn(`shadeAssets.cacheDocFileId row ${rowIndex}: ${e.message}`); }
}

module.exports = {
  stage, persistPending, activateByApprovalRequestId, rejectByApprovalRequestId,
  getShadePhotoForSend, getFullQualityForSend, activeShadeMap,
  cachePhotoFileId, cacheDocFileId,
  _internals: { toDirectDownloadUrl, extFor },
};
