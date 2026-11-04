'use strict';

/**
 * vision/local — VRF-6 (owner's final go, 04-Nov-2026): the bill reader that
 * needs no paid API.
 *
 * Owner: "Since I am not integrating the OpenAI API for now … what other
 * different permanent solution." A bill arrives as a photo, or as a PDF that
 * is either typed (a text layer) or one photograph per page. Three readers,
 * tried in this order, all in-process, no network:
 *
 *   1. PDF text layer (pdfjs-dist) — bale numbers lifted exactly, in
 *      document order, so the bill-order rule (VRF-5) holds.
 *   2. PDF of photographs — the embedded JPEGs are pulled out page by page
 *      (pdf-lib, no rendering) and read by Tesseract.
 *   3. A photo — converted to a clean PNG by sharp, read by Tesseract.
 *
 * Tesseract reads PRINTED numbers well and handwriting poorly; the honest
 * "unreadable" and the 75% marks-off rule stay as they are. The language
 * file (~4 MB) is fetched once and cached under OCR_LOCAL_CACHE_DIR.
 *
 * Provider contract (vision/index.js normalise): { ok, provider, bales[{
 * packageNo, confidence, …}], rawText, overallConfidence, warnings, error? }.
 * `method` names which reader answered, for the card and the try-out script.
 */
const config = require('../../config');
const logger = require('../../utils/logger');

const PROVIDER = 'local';
const NUM = /\b\d{3,7}\b/g;
// "Bale 1234", "BALE NO: 1234", "Pkg# 1234", "B/No 1234", "No. 1234"
const KEYED = /\b(?:bale|bl|pkg|package|b\/no|bale\s*no\.?|pkg\s*no\.?|no\.?)\s*[:#.\-–]?\s*(\d{3,7})\b/gi;
// a number that is a quantity, not a bale: "150 yds", "30 m", "18.5 kg", "5 pcs", a year, a date part
const UNIT_AFTER = /^\s*(?:\.\d+)?\s*(?:yds?|yards?|y|m|mtrs?|meters?|metres?|kgs?|pcs?|pieces?|%|\/|-\d|\.\d)/i;

/* ── the pure part: bale numbers out of text ─────────────────────────── */

/**
 * @param {string} text
 * @param {Map<string, number>} [wordConf] number → confidence 0..1 (from OCR words)
 * @returns {{bales:Array<{packageNo:string, confidence:number}>, method:'keyed'|'all-numbers', warnings:string[]}}
 */
function balesFromText(text, wordConf = new Map()) {
  const t = String(text || '');
  const seen = new Set();
  const bales = [];
  const warnings = [];
  const push = (no, base) => {
    if (seen.has(no)) return;
    seen.add(no);
    const c = wordConf.has(no) ? Math.min(base, wordConf.get(no)) : base;
    bales.push({ packageNo: no, confidence: Math.round(c * 100) / 100 });
  };
  for (const m of t.matchAll(KEYED)) push(m[1], 0.95);
  if (bales.length) return { bales, method: 'keyed', warnings };
  for (const m of t.matchAll(NUM)) {
    const no = m[0];
    const after = t.slice(m.index + no.length, m.index + no.length + 12);
    if (UNIT_AFTER.test(after)) continue;
    if (/^(19|20)\d\d$/.test(no)) continue;                      // a year
    const before = t.slice(Math.max(0, m.index - 3), m.index);
    if (/[\d/.-]$/.test(before)) continue;                        // a date / decimal part
    push(no, 0.6);
  }
  if (bales.length) {
    warnings.push("No 'bale' keyword found — every 3–7 digit number was taken as a bale; check the ➕ extras on the card.");
  }
  return { bales, method: 'all-numbers', warnings };
}

/* ── the readers (each lazily loads its library) ────────────────────── */

let _pdfText = null;        // test seam
let _recognizer = null;     // test seam: (pngBuffer) => { text, words:[{text, confidence}] }

async function pdfText(buffer) {
  if (_pdfText) return _pdfText(buffer);
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, verbosity: 0 }).promise;
  const max = Math.min(doc.numPages, Number(config.ocr.localMaxPages) || 30);
  let out = '';
  for (let i = 1; i <= max; i += 1) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out += `${tc.items.map((it) => it.str).join(' ')}\n`;
  }
  try { await doc.destroy(); } catch (_) { /* best-effort */ }
  return out;
}

/** The JPEGs embedded in a PDF, page by page (no rendering). */
async function embeddedJpegs(buffer) {
  const { PDFDocument, PDFName, PDFRawStream, PDFDict } = require('pdf-lib');
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const max = Math.min(pages.length, Number(config.ocr.localMaxPages) || 30);
  const images = [];
  let skipped = 0;
  for (let i = 0; i < max; i += 1) {
    const res = pages[i].node.Resources();
    const xo = res && res.lookup(PDFName.of('XObject'));
    if (!(xo instanceof PDFDict)) continue;
    for (const [, ref] of xo.entries()) {
      const s = doc.context.lookup(ref);
      if (!(s instanceof PDFRawStream)) continue;
      if (String(s.dict.get(PDFName.of('Subtype'))) !== '/Image') continue;
      const filter = String(s.dict.get(PDFName.of('Filter')) || '');
      if (filter === '/DCTDecode') images.push({ page: i + 1, bytes: Buffer.from(s.contents) });
      else skipped += 1;
    }
  }
  return { images, skipped, pages: pages.length, truncated: pages.length > max };
}

let _worker = null;
let _queue = Promise.resolve();

async function worker() {
  if (_worker) return _worker;
  const { createWorker } = require('tesseract.js');
  _worker = await createWorker(config.ocr.localLang || 'eng', 1, {
    cachePath: config.ocr.localCacheDir || 'data/ocr/tess',
    logger: () => {},
  });
  return _worker;
}

/** One image at a time — Tesseract is CPU-bound and the box is small. */
function serial(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.catch(() => {});
  return run;
}

async function recognize(png) {
  if (_recognizer) return _recognizer(png);
  const w = await worker();
  const { data } = await w.recognize(png);
  return { text: data.text || '', words: Array.isArray(data.words) ? data.words : [] };
}

async function toPng(buffer) {
  const sharp = require('sharp');
  return sharp(buffer).rotate().grayscale().normalise().png().toBuffer();
}

async function readImage(buffer) {
  const png = await toPng(buffer);
  const { text, words } = await serial(() => recognize(png));
  const wordConf = new Map();
  for (const w of words) {
    const no = String(w.text || '').replace(/\D/g, '');
    if (no.length >= 3 && Number.isFinite(Number(w.confidence))) wordConf.set(no, Math.max(0, Math.min(1, Number(w.confidence) / 100)));
  }
  return { text, wordConf };
}

/* ── the provider ───────────────────────────────────────────────────── */

const fail = (error, extra = {}) => ({ ok: false, provider: PROVIDER, bales: [], rawText: '', overallConfidence: 0, warnings: [], error, ...extra });

async function extractBales(buffer, mimeType /* , opts */) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'application/pdf') {
    let text = '';
    try { text = await pdfText(buffer); } catch (e) { logger.warn(`vision.local: pdf text layer failed: ${e.message}`); }
    const fromText = balesFromText(text);
    if (fromText.bales.length) return done(fromText, 'pdf-text', text);
    let imgs;
    try { imgs = await embeddedJpegs(buffer); } catch (e) { return fail(`PDF could not be opened: ${e.message}`); }
    if (!imgs.images.length) {
      return fail(imgs.skipped
        ? `the PDF's ${imgs.skipped} image(s) are not JPEG — attach the bill as a photo`
        : 'no text layer and no photographs in the PDF');
    }
    const parts = [];
    const conf = new Map();
    for (const img of imgs.images) {
      try {
        const r = await readImage(img.bytes);
        parts.push(`--- page ${img.page} ---\n${r.text}`);
        for (const [k, v] of r.wordConf) if (!conf.has(k)) conf.set(k, v);
      } catch (e) { parts.push(`--- page ${img.page} --- (unreadable: ${e.message})`); }
    }
    const raw = parts.join('\n');
    const out = balesFromText(raw, conf);
    if (imgs.truncated) out.warnings.push(`Only the first ${config.ocr.localMaxPages || 30} pages were read.`);
    if (imgs.skipped) out.warnings.push(`${imgs.skipped} non-JPEG image(s) in the PDF were skipped.`);
    return done(out, 'pdf-photos', raw);
  }
  if (!/^image\//.test(mime)) return fail(`unsupported type ${mime || '(none)'}`);
  let r;
  try { r = await readImage(buffer); } catch (e) { return fail(`photo could not be read: ${e.message}`); }
  return done(balesFromText(r.text, r.wordConf), 'photo', r.text);
}

function done(parsed, method, rawText) {
  const bales = parsed.bales;
  const overall = bales.length ? bales.reduce((s, b) => s + b.confidence, 0) / bales.length : 0;
  if (!bales.length) return fail('no bale numbers recognised', { method, rawText: String(rawText || '').slice(0, 4000) });
  return {
    ok: true, provider: PROVIDER, method: `${method}/${parsed.method}`,
    bales, rawText: String(rawText || '').slice(0, 4000), overallConfidence: overall, warnings: parsed.warnings,
  };
}

module.exports = {
  extractBales,
  balesFromText,
  _internals: {
    setPdfText(fn) { _pdfText = fn; },
    setRecognizer(fn) { _recognizer = fn; },
    embeddedJpegs,
  },
};
