/**
 * Image overlay utilities — stamp the design number on a product photo.
 *
 * Uses `sharp` to composite an SVG label on top of a JPEG/PNG buffer.
 * The output is auto-rotated (so EXIF rotation is honored), max 1280px on
 * the longer side, JPEG quality 88. Telegram-friendly out of the box.
 *
 * NOTE: Sharp is loaded lazily so the rest of the app can boot even when
 * the native binding isn't installed yet (e.g. fresh checkout before
 * `npm install`). Calls will throw a clear error in that case.
 */

const logger = require('./logger');

let _sharp = null;
function loadSharp() {
  if (_sharp) return _sharp;
  try {
    _sharp = require('sharp');
  } catch (e) {
    throw new Error('sharp is not installed. Run `npm install sharp` to enable product photo overlays.');
  }
  return _sharp;
}

const MAX_DIM = 1280;

/**
 * Escape XML special characters for use inside an SVG <text> element.
 */
function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Compose an SVG containing the design-number label (with white halo for
 * legibility on any background).
 */
function buildLabelSvg(width, height, designNumber) {
  const label = xmlEscape(designNumber || '');
  const fontSize = Math.max(28, Math.round(height * 0.07));
  const padX = Math.round(width * 0.025);
  const padY = Math.round(height * 0.025);
  const x = width - padX;
  const y = padY + fontSize;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <style>
    .label {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      font-weight: 800;
      font-size: ${fontSize}px;
    }
    .halo  { fill: #ffffff; stroke: #ffffff; stroke-width: ${Math.round(fontSize * 0.18)}px; stroke-linejoin: round; opacity: 0.85; }
    .ink   { fill: #111111; }
  </style>
  <text x="${x}" y="${y}" class="label halo" text-anchor="end">${label}</text>
  <text x="${x}" y="${y}" class="label ink"  text-anchor="end">${label}</text>
</svg>`;
}

/**
 * Generate a labeled JPEG buffer from a raw image buffer.
 *
 * @param {Buffer} rawBuffer - input image bytes (any sharp-supported format)
 * @param {string} designNumber - text to stamp top-right (e.g. "9006")
 * @returns {Promise<{buffer: Buffer, width: number, height: number}>}
 */
async function stampDesignNumber(rawBuffer, designNumber) {
  const sharp = loadSharp();
  if (!Buffer.isBuffer(rawBuffer)) throw new Error('rawBuffer must be a Buffer');

  // Auto-rotate (EXIF) and downscale before composite so the label sizing
  // is computed on the final dimensions.
  const base = sharp(rawBuffer).rotate();
  const meta = await base.metadata();
  const w0 = meta.width || 0;
  const h0 = meta.height || 0;
  if (!w0 || !h0) throw new Error('Could not read image dimensions; corrupt or unsupported format.');

  const longer = Math.max(w0, h0);
  const scale = longer > MAX_DIM ? MAX_DIM / longer : 1;
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);

  const resized = scale < 1
    ? base.resize({ width: w, height: h, fit: 'inside' })
    : base;

  const svg = buildLabelSvg(w, h, designNumber);

  try {
    const out = await resized
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 88, progressive: true })
      .toBuffer();
    return { buffer: out, width: w, height: h };
  } catch (e) {
    logger.error('stampDesignNumber failed', e.message);
    throw e;
  }
}

/**
 * Convenience helper: just resize+rotate a photo (no label) to Telegram-friendly
 * dimensions. Used when the admin's raw photo is preferred unmodified.
 */
async function normalizePhoto(rawBuffer) {
  const sharp = loadSharp();
  if (!Buffer.isBuffer(rawBuffer)) throw new Error('rawBuffer must be a Buffer');
  const base = sharp(rawBuffer).rotate();
  const meta = await base.metadata();
  const w0 = meta.width || 0;
  const h0 = meta.height || 0;
  const longer = Math.max(w0, h0);
  const scale = longer > MAX_DIM ? MAX_DIM / longer : 1;
  if (scale >= 1) {
    return await base.jpeg({ quality: 88, progressive: true }).toBuffer();
  }
  return await base
    .resize({ width: Math.round(w0 * scale), height: Math.round(h0 * scale), fit: 'inside' })
    .jpeg({ quality: 88, progressive: true })
    .toBuffer();
}

module.exports = { stampDesignNumber, normalizePhoto };
