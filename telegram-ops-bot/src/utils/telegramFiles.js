/**
 * Helper for fetching a Telegram file (by file_id) into a local Buffer.
 *
 * The bot library exposes `getFile(fileId)` which returns a `file_path`
 * relative to the api.telegram.org file endpoint. We then HTTPS-GET that
 * URL using the bot token. Returns the raw bytes plus the inferred extension
 * and mime type.
 *
 * Usage:
 *   const { buffer, ext, mimeType } = await downloadTelegramFile(bot, file_id);
 */

const https = require('https');
const config = require('../config');

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf',
};

async function downloadTelegramFile(bot, fileId) {
  if (!fileId) throw new Error('fileId is required');
  if (!config.telegram.token) throw new Error('TELEGRAM_TOKEN not configured');

  const file = await bot.getFile(fileId);
  if (!file || !file.file_path) throw new Error('Could not resolve Telegram file_path');
  const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;

  const buffer = await new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Telegram file fetch failed: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Timeout fetching Telegram file'));
    });
  });

  const ext = (file.file_path.split('.').pop() || 'jpg').toLowerCase();
  const mimeType = MIME_BY_EXT[ext] || 'application/octet-stream';
  return { buffer, ext, mimeType, filePath: file.file_path };
}

module.exports = { downloadTelegramFile };
