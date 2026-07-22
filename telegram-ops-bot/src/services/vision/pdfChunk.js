/**
 * SNAP-5 — PDF page chunking for vision OCR (owner bug 22-Jul-2026).
 *
 * Abdul's real dispatch PDFs run 40–115 pages. One-shot reads fail two
 * ways at that size: Claude accepts at most 100 PDF pages per request,
 * and a long run of labels overflows the answer's max_tokens so the JSON
 * arrives cut off ("Model returned unparseable output"). Splitting into
 * small chunks fixes both and keeps each answer comfortably inside the
 * token budget.
 *
 * Pure pdf-lib (no native deps). Splitting copies pages as-is — the
 * embedded label photos are NOT re-encoded, so quality is untouched.
 */

'use strict';

const { PDFDocument } = require('pdf-lib');

/** Number of pages in a PDF buffer. Throws on a broken/unreadable file. */
async function pageCount(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}

/**
 * Split a PDF into chunks of at most `maxPages` pages.
 * A PDF already within the limit comes back as ONE chunk with the
 * original buffer untouched (no re-save).
 *
 * @param {Buffer} buffer
 * @param {number} maxPages
 * @returns {Promise<Array<{buffer: Buffer, fromPage: number, toPage: number}>>}
 *   1-based inclusive page ranges, in order.
 */
async function splitPdf(buffer, maxPages) {
  const cap = Math.max(1, parseInt(maxPages, 10) || 1);
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  if (total <= cap) return [{ buffer, fromPage: 1, toPage: total }];
  const chunks = [];
  for (let start = 0; start < total; start += cap) {
    const end = Math.min(start + cap, total);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: end - start }, (_, i) => start + i));
    for (const p of pages) out.addPage(p);
    chunks.push({ buffer: Buffer.from(await out.save()), fromPage: start + 1, toPage: end });
  }
  return chunks;
}

module.exports = { pageCount, splitPdf };
