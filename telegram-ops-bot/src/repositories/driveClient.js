/**
 * Google Drive API client for uploading receipt images/PDFs.
 * Uses the same service account credentials as Sheets.
 * Scope: drive.file (only manages files created by this app).
 */

const { google } = require('googleapis');
const config = require('../config');
const logger = require('../utils/logger');
const { Readable } = require('stream');

let drive = null;

async function getDrive() {
  if (drive) return drive;
  const creds = config.sheets.credentials;
  if (!creds) throw new Error('GOOGLE_CREDENTIALS_JSON must be set for Drive uploads');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const authClient = await auth.getClient();
  drive = google.drive({ version: 'v3', auth: authClient });
  return drive;
}

/**
 * Upload a file buffer to Google Drive.
 * @param {Buffer} fileBuffer - file contents
 * @param {string} fileName - destination file name
 * @param {string} mimeType - e.g. 'image/jpeg', 'application/pdf'
 * @returns {{ fileId: string, webViewLink: string }}
 */
async function uploadFile(fileBuffer, fileName, mimeType) {
  const d = await getDrive();
  const folderId = config.drive.folderId;
  const parents = folderId ? [folderId] : [];

  const res = await d.files.create({
    requestBody: {
      name: fileName,
      parents,
    },
    media: {
      mimeType,
      body: Readable.from(fileBuffer),
    },
    fields: 'id, webViewLink',
  });

  const fileId = res.data.id;

  await d.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  const meta = await d.files.get({ fileId, fields: 'webViewLink' });
  const webViewLink = meta.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

  logger.info(`Drive: uploaded ${fileName} → ${fileId}`);
  return { fileId, webViewLink };
}

/**
 * Download a file's content from Drive as a Buffer.
 * Useful when re-serving an uploaded asset (e.g. product photos) to Telegram
 * directly, instead of relying on Telegram to fetch a shared Drive URL —
 * which is occasionally rate-limited or blocked depending on file metadata.
 *
 * @param {string} fileId
 * @returns {Promise<Buffer>}
 */
async function downloadFile(fileId) {
  if (!fileId) throw new Error('downloadFile: fileId is required');
  const d = await getDrive();
  const res = await d.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  );
  // googleapis returns ArrayBuffer or Buffer depending on transport — normalize.
  const data = res.data;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data && typeof data === 'object' && data.byteLength != null) return Buffer.from(data);
  return Buffer.from(data);
}

module.exports = { uploadFile, downloadFile };
