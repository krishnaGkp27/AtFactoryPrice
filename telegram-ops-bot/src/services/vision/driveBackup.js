/**
 * Local + Google Drive backup for Photo Receive uploads (P5-C2).
 *
 * Every image / PDF that lands in the Photo Receive flow gets:
 *   1. Archived to disk at `data/ocr/{hash}.{ext}` (cheap, always works).
 *   2. Uploaded to a Drive folder `{OCR_GDRIVE_FOLDER_ID} / {YYYY-MM}/`
 *      so the operator has a durable, searchable, off-bot copy.
 *
 * Drive backup is best-effort: if credentials are missing, the folder
 * isn't configured, or the upload itself fails, the local copy still
 * goes through and we surface the Drive error in the return value
 * instead of throwing. The bot must never lose the operator's image
 * because Google had a bad minute.
 *
 * Uses the same service-account credentials as the Sheets client, with
 * the `drive.file` scope added — that scope is locked to files the
 * service account itself creates, so we can't accidentally read the
 * operator's whole Drive.
 *
 * Return shape:
 *   {
 *     hash:        string,   // SHA-256 first 16 hex of the file bytes
 *     ext:         string,   // 'jpg', 'png', 'pdf', etc.
 *     mime:        string,
 *     bytes:       number,
 *     localPath:   string,   // absolute path on disk
 *     drive: null | {
 *       id:           string,
 *       name:         string,
 *       webViewLink:  string,
 *       folderId:     string,
 *       monthLabel:   string,  // 'YYYY-MM'
 *     },
 *     driveError:  string | null,   // present if Drive backup attempted and failed
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const config = require('../../config');
const logger = require('../../utils/logger');

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};

/**
 * Internal: lazy-loaded Drive client. Exposed setter is for tests only.
 */
let _drive = null;

function _setDriveClient(stubOrReal) {
  _drive = stubOrReal;
}

async function getDriveClient() {
  if (_drive) return _drive;
  const { google } = require('googleapis');
  const creds = config.sheets.credentials;
  if (!creds) throw new Error('Drive client unavailable: no service-account credentials in config.');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
    ],
  });
  const authClient = await auth.getClient();
  _drive = google.drive({ version: 'v3', auth: authClient });
  return _drive;
}

function sha256First16(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function extensionFor(mimeType) {
  const m = (mimeType || '').toLowerCase();
  return EXT_BY_MIME[m] || 'bin';
}

function monthLabel(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Write the buffer to `data/ocr/{hash}.{ext}` (configurable via
 * `OCR_ARCHIVE_DIR`). Idempotent — same bytes ⇒ same path ⇒ same
 * file on disk, so re-uploads don't duplicate.
 *
 * @returns {Promise<string>} absolute path
 */
async function archiveLocally(buffer, hash, ext) {
  const dir = path.resolve(config.ocr.localArchiveDir || 'data/ocr');
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${hash}.${ext}`);
  // Idempotency: if the file already exists with the same byte length,
  // don't re-write. (Caller could have re-uploaded the same slip.)
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size === buffer.length) return filePath;
  } catch { /* not found — write below */ }
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Find (or create) a `{YYYY-MM}` subfolder under `parentId`.
 *
 * @returns {Promise<string>} folder ID
 */
async function ensureMonthFolder(parentId, label) {
  const drive = await getDriveClient();
  const safe = label.replace(/'/g, "\\'");
  const q = `mimeType='application/vnd.google-apps.folder' and name='${safe}' and '${parentId}' in parents and trashed=false`;
  const list = await drive.files.list({ q, fields: 'files(id,name)' });
  if (list?.data?.files?.length) return list.data.files[0].id;
  const created = await drive.files.create({
    requestBody: {
      name: label,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return created.data.id;
}

/**
 * Upload one file into a Drive folder. Returns the file metadata.
 */
async function uploadToDrive(buffer, filename, mimeType, folderId) {
  const drive = await getDriveClient();
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, name, webViewLink, parents',
  });
  return res.data;
}

/**
 * Top-level entry point — archive locally and (best-effort) to Drive.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {object} [opts]
 * @param {string} [opts.filename]  override the default `{hash}.{ext}` name
 * @param {Date}   [opts.now]       inject for tests
 * @returns {Promise<object>}  see file header for shape
 */
async function archiveImage(buffer, mimeType, opts = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('archiveImage: empty or invalid buffer');
  }
  const hash = sha256First16(buffer);
  const ext = extensionFor(mimeType);
  const fname = opts.filename || `${hash}.${ext}`;
  const localPath = await archiveLocally(buffer, hash, ext);

  const out = {
    hash,
    ext,
    mime: mimeType,
    bytes: buffer.length,
    localPath,
    drive: null,
    driveError: null,
  };

  const folderId = config.drive.ocrFolderId;
  if (!folderId) {
    // No Drive backup configured — local-only mode.
    return out;
  }

  try {
    const label = monthLabel(opts.now || new Date());
    const monthFolder = await ensureMonthFolder(folderId, label);
    const meta = await uploadToDrive(buffer, fname, mimeType, monthFolder);
    out.drive = {
      id: meta.id,
      name: meta.name,
      webViewLink: meta.webViewLink || '',
      folderId: monthFolder,
      monthLabel: label,
    };
  } catch (e) {
    logger.warn(`driveBackup: upload failed for ${fname} — ${e.message}`);
    out.driveError = e.message;
  }

  return out;
}

module.exports = {
  archiveImage,
  archiveLocally,
  ensureMonthFolder,
  uploadToDrive,
  sha256First16,
  extensionFor,
  monthLabel,
  EXT_BY_MIME,
  _setDriveClient,
};
