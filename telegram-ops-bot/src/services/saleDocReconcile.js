'use strict';

/**
 * saleDocReconcile — one engine for "what does the sale document say?"
 * shared by every supply/sale card that shows bale numbers (SBL-2 Customer
 * Supplies, SDG-2 Design-wise, SDD-2 Warehouse-wise).
 *
 * Two jobs:
 *   1. docsFor(customer, day)  — the bill photo/PDF(s) filed against that
 *      customer's approved sales on that day (`sale_doc_file_id`, written
 *      by the snap flows).
 *   2. readBaleDigits(bot, docs) — OCR them through the existing vision
 *      layer and return the set of bale numbers the DOCUMENT contains.
 *
 * `reconcile()` then compares a card's bale numbers against that set.
 * Matching is digit-exact on both sides (printed numbers are the primary
 * key — BUSINESS_RULES §1); a near-miss is never treated as a match.
 *
 * SCOPE NOTE (owner, 02-Aug): a document belongs to a customer + DAY, but
 * a card may be narrower (one design, one warehouse). So `docOnly` numbers
 * on a narrowed card are usually just that day's other designs — callers
 * that are narrower than customer+day pass `partial: true` and simply do
 * not show them, instead of flagging honest numbers as anomalies.
 *
 * Read-only: nothing here writes to any sheet.
 */

const logger = require('../utils/logger');

/** Digits-only view of a printed bale number ('B-1057' → '1057'). */
function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

/**
 * Normalize a sold/sales date to ISO YYYY-MM-DD. Mirrors the convention in
 * soldBalesFlow / supplyDetails* (the sheet holds mixed formats).
 */
function normDay(sRaw) {
  const raw = String(sRaw || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const ms = Date.parse(raw);
  if (isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  return raw;
}

/**
 * Sale document(s) filed for a customer on a day, deduped by file id.
 * @param {string} customer @param {string} day ISO YYYY-MM-DD
 * @returns {Promise<Array<{fileId:string, kind:'photo'|'document'}>>}
 */
async function docsFor(customer, day) {
  try {
    const approvalQueueRepository = require('../repositories/approvalQueueRepository');
    const cust = String(customer || '').trim().toLowerCase();
    const seen = new Set();
    const docs = [];
    for (const r of await approvalQueueRepository.getResolved()) {
      if (String(r.status || '').toLowerCase() !== 'approved') continue;
      const aj = r.actionJSON || {};
      if (!aj.sale_doc_file_id || seen.has(aj.sale_doc_file_id)) continue;
      if (String(aj.customer || '').trim().toLowerCase() !== cust) continue;
      if (normDay(aj.salesDate) !== day) continue;
      seen.add(aj.sale_doc_file_id);
      // snap PDF batches ride as documents; snap bill photos as photos.
      docs.push({ fileId: aj.sale_doc_file_id, kind: aj.action === 'sale_bundle' ? 'document' : 'photo' });
    }
    return docs;
  } catch (_) { return []; }
}

/**
 * Deliver docs into the chat as EPHEMERAL views (TRF-9b): they are swept
 * on the viewer's next tap in the flow, so bills never pile up.
 * @param {object} bot @param {number|string} chatId @param {string} userId
 * @param {Array} docs @param {string} caption
 */
async function sendDocs(bot, chatId, userId, docs, caption) {
  const ephemeralDocs = require('./ephemeralDocs');
  for (const d of docs || []) {
    let sent = null;
    try {
      sent = d.kind === 'document'
        ? await bot.sendDocument(chatId, d.fileId, { caption })
        : await bot.sendPhoto(chatId, d.fileId, { caption });
    } catch (_) {
      // A stored kind can mislie (a photo id cannot go out as a document
      // and vice versa) — retry the other way before giving up.
      try {
        sent = d.kind === 'document'
          ? await bot.sendPhoto(chatId, d.fileId, { caption })
          : await bot.sendDocument(chatId, d.fileId, { caption });
      } catch (e2) {
        logger.warn(`saleDocReconcile: doc send failed: ${e2.message}`);
      }
    }
    if (sent && sent.message_id) ephemeralDocs.track(bot, userId, chatId, sent.message_id);
  }
}

/**
 * OCR the documents and collect every bale number they contain.
 *
 * @param {object} bot
 * @param {Array<{fileId:string, kind:string}>} docs
 * @param {{onProgress?:function(number,number):Promise<void>, shouldAbort?:function():boolean}} [opts]
 *        onProgress(at, of) runs BEFORE each document; shouldAbort() is
 *        polled between documents so a user's ✖ Stop ends the read early.
 * @returns {Promise<{digits:Set<string>, error:string|null, aborted:boolean}>}
 */
async function readBaleDigits(bot, docs, opts = {}) {
  const telegramFiles = require('../utils/telegramFiles');
  const vision = require('./vision');
  const digits = new Set();
  let error = null;
  const list = docs || [];
  for (let i = 0; i < list.length; i += 1) {
    if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) {
      return { digits, error, aborted: true };
    }
    if (typeof opts.onProgress === 'function') await opts.onProgress(i + 1, list.length);
    const d = list[i];
    try {
      const dl = await telegramFiles.downloadTelegramFile(bot, d.fileId);
      const mime = dl.mimeType || (d.kind === 'document' ? 'application/pdf' : 'image/jpeg');
      const ocr = await vision.extractBales(dl.buffer, mime);
      if (!ocr.ok) { error = ocr.error || 'document unreadable'; continue; }
      for (const b of ocr.bales) {
        const dg = digitsOf(b.packageNo);
        if (dg) digits.add(dg);
      }
    } catch (e) { error = e.message; }
  }
  return { digits, error, aborted: false };
}

/**
 * Compare a card's printed bale numbers against what the document holds.
 * @param {Array<string>} cardBales printed numbers exactly as shown
 * @param {Set<string>} docDigits from readBaleDigits
 * @returns {{verified:string[], matched:number, missing:string[], docOnly:string[]}}
 *          `verified` is digit keys (for dotting), `missing` keeps the
 *          printed spelling (it is shown to the user).
 */
function reconcile(cardBales, docDigits) {
  const pairs = (cardBales || []).map((p) => ({ printed: String(p), key: digitsOf(p) }));
  const inDoc = (x) => x.key && docDigits.has(x.key);
  const cardKeys = new Set(pairs.map((x) => x.key));
  const hit = pairs.filter(inDoc);
  return {
    verified: [...new Set(hit.map((x) => x.key))],
    matched: hit.length,
    missing: pairs.filter((x) => !inDoc(x)).map((x) => x.printed),
    docOnly: [...docDigits].filter((d) => !cardKeys.has(d)),
  };
}

/**
 * The status block every card prints above its rows after a check.
 * @param {object} st session-held result
 * @param {number} total bales on the card
 * @param {{partial?:boolean}} [opts] partial cards hide `docOnly` (see the
 *        scope note at the top of this file).
 */
function statusLines(st, total, opts = {}) {
  if (!st) return '';
  if (st.reading) {
    const prog = st.of > 1 ? ` (doc ${st.at}/${st.of})` : '';
    return `\n⏳ _Reading sale doc…${prog}_\n`;
  }
  if (st.error && !st.done) return `\n⚠️ _Doc check failed: ${st.error}_\n`;
  if (!st.done) return '';
  let out = `\n📑 Doc check: *${st.matched}/${total}* matched\n`;
  if ((st.missing || []).length) {
    const m = st.missing;
    out += `⚠️ Not in doc: ${m.slice(0, 8).join(', ')}${m.length > 8 ? ` +${m.length - 8} more` : ''}\n`;
  }
  if (!opts.partial && (st.docOnly || []).length) {
    const e = st.docOnly;
    out += `_Doc-only numbers: ${e.slice(0, 8).join(', ')}${e.length > 8 ? ` +${e.length - 8} more` : ''}_\n`;
  }
  if (st.error) out += `_${st.error}_\n`;
  return out;
}

/** Bale numbers rendered for a row, dotting the verified ones. */
function dotted(pkgs, verified) {
  const set = new Set(verified || []);
  return (pkgs || []).map((p) => (set.has(digitsOf(p)) ? `🟢${p}` : String(p))).join(', ');
}

module.exports = {
  docsFor, sendDocs, readBaleDigits, reconcile, statusLines, dotted,
  digitsOf, normDay,
};
