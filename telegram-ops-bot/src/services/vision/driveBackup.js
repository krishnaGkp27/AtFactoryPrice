/**
 * Local + Google Drive backup for every source file the bot ingests
 * (Photo Receive images/PDFs from P5, Bulk Receive CSV/XLSX from P2.5).
 *
 * Originally shipped in P5-C2 as `archiveImage()` for the photo flow only.
 * FILE-C1 generalised it to `archiveFile()` and added:
 *   - HUMAN-READABLE filenames (see buildReadableName) so the Drive
 *     folder is browsable by a real person, not just by hash lookup.
 *   - Sheet-friendly return shape (`webViewLink`) that flows into a new
 *     `source_url` column on `GoodsReceipts`, giving the admin a clickable
 *     "open the original" link straight from the sheet.
 *   - `updateDescription()` for post-approval enrichment — once the GRN
 *     gets its real `grn_id`, we tag the Drive file's description with
 *     `{grn_id} | {supplier} | {warehouse}` without renaming (so any
 *     stored URL stays valid).
 *
 * Every ingested file gets:
 *   1. Archived to disk at `data/ocr/{hash}.{ext}` (cheap, always works).
 *      Local path stays hash-based for idempotent collision-free storage.
 *   2. Uploaded to a Drive folder `{SOURCE_FOLDER_ID} / {YYYY-MM}/` with
 *      a readable filename like
 *      `2026-05-15__abdul__packing-slip__a3f4b9c2.jpg`.
 *
 * Drive backup is best-effort: if credentials are missing, the folder
 * isn't configured, or the upload itself fails, the local copy still
 * goes through and we surface the Drive error in the return value
 * instead of throwing. The bot must never lose the operator's file
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
 *     ext:         string,   // 'jpg', 'png', 'pdf', 'csv', 'xlsx', …
 *     mime:        string,
 *     bytes:       number,
 *     localPath:   string,   // absolute path on disk
 *     readableName:string,   // the human-readable Drive filename
 *     drive: null | {
 *       id:           string,
 *       name:         string,
 *       webViewLink:  string,   // ← what we store in GoodsReceipts.source_url
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
  // FILE-C1: bulk-receive sources land in the same archive — same naming,
  // same Drive folder hierarchy, same sheet-link surface.
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
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
 * FILE-C1: build a human-readable filename for the Drive copy.
 *
 * Pattern: `{YYYY-MM-DD}__{uploader}__{original_or_kind}__{hash8}.{ext}`
 *
 *   - Date prefix → time-sortable in the Drive folder.
 *   - Uploader name → tells a human at a glance who sent it.
 *   - Original filename (sanitized) or kind hint → the "what" of the file.
 *   - 8-char hash suffix → guarantees uniqueness even if two operators
 *     upload identically-named files on the same day; matches the
 *     idempotency lookup key in GoodsReceipts.file_hash.
 *   - Extension preserved from `ext`.
 *
 * All path-unfriendly characters are stripped or replaced with `-`,
 * the segments are clamped to keep total filename comfortably under
 * Drive's 255-byte limit, and double underscores (`__`) separate the
 * segments so the eye can scan them.
 *
 * @param {object} opts
 * @param {Date}   [opts.date=new Date()]
 * @param {string} [opts.uploader]     - free-text uploader name
 * @param {string} [opts.originalName] - filename as Telegram knew it
 * @param {string} [opts.kind]         - 'photo' | 'bulk' (fallback if originalName missing)
 * @param {string} opts.hash           - full 16-hex hash
 * @param {string} opts.ext            - lowercase extension, no dot
 * @returns {string}
 */
function buildReadableName({ date, uploader, originalName, kind, hash, ext }) {
  const d = date instanceof Date ? date : new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const datePart = `${yyyy}-${mm}-${dd}`;

  const sanitize = (s, max) => {
    if (!s) return '';
    return String(s)
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')   // anything not word/dot/dash → dash
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, max);
  };

  const uploaderPart = sanitize(uploader, 24) || 'unknown';

  // Original filename: strip the extension since we re-attach our own,
  // and cap it so the total stays well under Drive's 255-byte limit.
  let rawOrig = (originalName || '').replace(/\.[^.]+$/, '');
  const origPart = sanitize(rawOrig, 60) || sanitize(kind, 20) || 'file';

  const hash8 = (hash || '').slice(0, 8) || 'nohash';
  const safeExt = (ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');

  return `${datePart}__${uploaderPart}__${origPart}__${hash8}.${safeExt}`;
}

/**
 * Resolve the Drive root folder for source files. Honours the new
 * `SOURCE_GDRIVE_FOLDER_ID` env var when set, then falls back to the
 * legacy OCR-specific folder, then the generic Drive folder. This lets
 * an operator point all source uploads at one folder OR keep photos
 * and bulk files split across two folders without code changes.
 */
function resolveSourceFolderId() {
  return config.drive.sourceFolderId || config.drive.ocrFolderId || '';
}

/**
 * Top-level entry point — archive locally and (best-effort) to Drive,
 * with a HUMAN-READABLE Drive filename. Replaces archiveImage() as the
 * preferred entry point; archiveImage() is kept as a back-compat wrapper.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {object} [opts]
 * @param {string} [opts.uploader]      uploader name (for the readable filename)
 * @param {string} [opts.originalName]  filename as Telegram delivered it
 * @param {string} [opts.kind]          'photo' | 'bulk' — fallback if no originalName
 * @param {string} [opts.filename]      explicit override; if set, replaces the built name entirely
 * @param {Date}   [opts.now]           inject for tests
 * @returns {Promise<object>}  see file header for shape
 */
async function archiveFile(buffer, mimeType, opts = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('archiveFile: empty or invalid buffer');
  }
  const hash = sha256First16(buffer);
  const ext = extensionFor(mimeType);
  const now = opts.now || new Date();
  const readableName = opts.filename || buildReadableName({
    date: now,
    uploader: opts.uploader,
    originalName: opts.originalName,
    kind: opts.kind,
    hash,
    ext,
  });

  // Local copy keeps the hash-based path — it's an internal cache, and
  // hash-naming makes idempotent re-uploads collide cleanly on disk.
  const localPath = await archiveLocally(buffer, hash, ext);

  const out = {
    hash,
    ext,
    mime: mimeType,
    bytes: buffer.length,
    localPath,
    readableName,
    drive: null,
    driveError: null,
  };

  const folderId = resolveSourceFolderId();
  if (!folderId) {
    // No Drive backup configured — local-only mode. Still log so an
    // operator grepping for "archive" sees what happened.
    logger.info(`archive: kind=${opts.kind || 'file'} uploader=${opts.uploader || '?'} hash=${hash} drive=disabled local=${localPath} name=${readableName}`);
    return out;
  }

  try {
    const label = monthLabel(now);
    const monthFolder = await ensureMonthFolder(folderId, label);
    const meta = await uploadToDrive(buffer, readableName, mimeType, monthFolder);
    out.drive = {
      id: meta.id,
      name: meta.name,
      webViewLink: meta.webViewLink || '',
      folderId: monthFolder,
      monthLabel: label,
    };
    logger.info(`archive: kind=${opts.kind || 'file'} uploader=${opts.uploader || '?'} hash=${hash} drive_id=${meta.id} url=${meta.webViewLink || '-'} name=${readableName}`);
  } catch (e) {
    logger.warn(`driveBackup: upload failed for ${readableName} — ${e.message}`);
    out.driveError = e.message;
    logger.info(`archive: kind=${opts.kind || 'file'} uploader=${opts.uploader || '?'} hash=${hash} drive=error local=${localPath} name=${readableName}`);
  }

  return out;
}

/**
 * Backward-compatible wrapper preserved for any caller that still imports
 * `archiveImage`. Internally delegates to `archiveFile()` so the Drive
 * filename matches the new pattern. The legacy single-arg `opts.filename`
 * override is still honoured for tests.
 */
async function archiveImage(buffer, mimeType, opts = {}) {
  return archiveFile(buffer, mimeType, { kind: 'photo', ...opts });
}

/**
 * FILE-C1: stamp a Drive file with a human-readable description AFTER
 * the GRN is approved + persisted. Lets the operator open the file in
 * Drive and see immediately which GRN / supplier / warehouse it
 * belongs to, without renaming (so the URL stored in GoodsReceipts
 * stays valid).
 *
 * Best-effort: returns `false` on any failure (no Drive client, file
 * gone, permission denied) — caller should log and move on. The sheet
 * row is still useful even when this enrichment fails.
 *
 * @param {string} fileId       Drive file ID
 * @param {string} description  free-text, kept short (Drive accepts a lot)
 * @returns {Promise<boolean>}  true on success
 */
async function updateDescription(fileId, description) {
  if (!fileId) return false;
  try {
    const drive = await getDriveClient();
    await drive.files.update({
      fileId,
      requestBody: { description: String(description || '').slice(0, 1024) },
    });
    return true;
  } catch (e) {
    logger.warn(`driveBackup.updateDescription(${fileId}) failed: ${e.message}`);
    return false;
  }
}

module.exports = {
  archiveFile,
  archiveImage,
  archiveLocally,
  ensureMonthFolder,
  uploadToDrive,
  updateDescription,
  buildReadableName,
  resolveSourceFolderId,
  sha256First16,
  extensionFor,
  monthLabel,
  EXT_BY_MIME,
  _setDriveClient,
};
