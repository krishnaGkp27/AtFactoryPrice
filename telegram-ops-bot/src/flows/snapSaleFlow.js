'use strict';

/**
 * SNAP-1 — 📸 Snap Sale: one photo + two taps (owner-locked 18-Jul-2026).
 *
 * Staff photograph the BALE LABEL (indent/bale/design/colour handwriting),
 * the vision OCR reads it, the bale is matched in Inventory, and a confirm
 * card shows BOTH what was read and what matched (handwriting OCR is good,
 * not infallible — the human verifies before tapping). Tap a customer →
 * a standard sell_package approval is queued: the usual single-admin
 * approval + ST-1 enrichment (rate/payment entered by the ADMIN — owner
 * decision c), and the label photo rides as sale_doc_file_id so it IS the
 * attached sale document (owner decision b): admins get the photo preview
 * and the existing Drive archival applies.
 *
 * No match / OCR down → graceful fallback into the normal 💰 Sell Bale.
 *
 * SNAP-4 (owner 21-Jul): the SAME PDF batch can be a WAREHOUSE TRANSFER
 * instead of a sale (dispatch PDFs, e.g. Lagos → Kano). Admin-only button
 * on the batch review → destination + receiver taps → bales are grouped
 * by their SOURCE warehouse automatically (one staged transfer per source,
 * exact packageNos dispatched immediately — the PDF IS the load document,
 * satisfying the TRF-6 doc requirement). Receiver confirms arrival through
 * the existing trf: pipeline; bales already at the destination are skipped.
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, chunk, mdEscape } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const transactionsRepository = require('../repositories/transactionsRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const usersRepository = require('../repositories/usersRepository');
const idGenerator = require('../utils/idGenerator');
const auth = require('../middlewares/auth');
const { todayInLagos } = require('../utils/dates');
const config = require('../config');
const logger = require('../utils/logger');

const SESSION_TYPE = 'snap_sale_flow';
const NS = 'sns:';
const CUSTOMERS_PAGE = 8;

const render = makeRenderer({ parseMode: 'Markdown', requireSession: SESSION_TYPE });

function cancelRow() { return [{ text: '❌ Cancel', callback_data: `${NS}cancel` }, { text: '🏠 Menu', callback_data: 'act:__back__' }]; }

/* ── matching ── */

/** Group inventory into per-(warehouse,bale) summaries for matching. */
function groupBales(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.packageNo) continue;
    const k = `${r.warehouse}|${r.packageNo}`;
    if (!map.has(k)) {
      map.set(k, { packageNo: String(r.packageNo), design: r.design, shade: r.shade, warehouse: r.warehouse, availableThans: 0, availableYards: 0 });
    }
    const b = map.get(k);
    if (r.status === 'available') { b.availableThans += 1; b.availableYards += Number(r.yards) || 0; }
  }
  return [...map.values()].filter((b) => b.availableThans > 0);
}

/**
 * SNAP-6 — hyphen/space-insensitive code comparison: the sheet's "9060B",
 * a label's "9060-B" and a re-read's "9060 B" are the same design.
 */
function normCode(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/**
 * Match the OCR'd label against available bales: bale-number digits must
 * match (exact or suffix — sheets sometimes prefix e.g. "P896"), and when
 * OCR also read a design it must agree (normalised, SNAP-6).
 */
function matchBales(bales, ocr) {
  const pkgDigits = String(ocr.packageNo || '').replace(/\D/g, '');
  if (!pkgDigits) return [];
  const design = normCode(ocr.design);
  return bales.filter((b) => {
    const bDigits = String(b.packageNo).replace(/\D/g, '');
    if (bDigits !== pkgDigits && !String(b.packageNo).toUpperCase().endsWith(pkgDigits)) return false;
    if (design && normCode(b.design) !== design) return false;
    return true;
  });
}

/**
 * SNAP-6 — rescue matching (owner 22-Jul). Handwriting OCR sometimes puts
 * the INDENT number where the bale number belongs ("2522 9060-A" for every
 * sack of an order), or misreads a digit. When the number matches nothing,
 * the label's OTHER attributes — design, shade, pieces, meterage — usually
 * identify the bale anyway, searched across EVERY store.
 *
 * Never invents: exactly one corroborated candidate → rescued (flagged for
 * human eyes); several plausible ones → kept aside with the candidates
 * named in the skip reason (owner 6b: no questions); none → skip.
 *
 * @returns {{cand: object|null, cands: object[]}}
 *   cand set = unique confident rescue; cands = shortlist for the picker.
 */
function rescueMatch(bales, ocr, takenKeys) {
  const design = normCode(ocr.design);
  if (!design) return { cand: null, cands: [] };
  let cands = bales.filter((b) => !takenKeys.has(`${b.warehouse}|${b.packageNo}`) && normCode(b.design) === design);
  const shade = normCode(ocr.shade);
  if (shade) {
    const shaded = cands.filter((b) => normCode(b.shade) === shade);
    if (shaded.length) cands = shaded;
  }
  if (!cands.length) return { cand: null, cands: [] };
  if (cands.length === 1) return { cand: cands[0], cands };
  // Corroborate: pieces count, meterage (±12%), and bale-number digit overlap.
  const labelDigits = String(ocr.packageNo || '').replace(/\D/g, '');
  const scored = cands.map((b) => {
    let s = 0;
    if (ocr.thanNo && ocr.thanNo === b.availableThans) s += 1;
    if (ocr.yards && b.availableYards
        && Math.abs(ocr.yards - b.availableYards) / b.availableYards <= 0.12) s += 1;
    const bDigits = String(b.packageNo).replace(/\D/g, '');
    if (labelDigits && bDigits
        && (bDigits.includes(labelDigits) || labelDigits.includes(bDigits))) s += 1;
    return { b, s };
  }).sort((a, z) => z.s - a.s);
  const top = scored.filter((x) => x.s === scored[0].s);
  if (top.length === 1 && scored[0].s >= 1) return { cand: top[0].b, cands };
  return { cand: null, cands: cands.slice(0, 6) };
}

/** Short "could be 1002 (IDUMOTA) or 1005 (IDUMOTA)" candidate list. */
function candList(cands) {
  const names = cands.slice(0, 3).map((c) => `${c.packageNo} (${c.warehouse})`);
  return names.join(' or ') + (cands.length > 3 ? ` or ${cands.length - 3} more` : '');
}

/**
 * SNAP-6 (revised 6b, owner 22-Jul): one pass over every OCR'd label —
 * exact match → attribute rescue → KEEP ASIDE. No questions: when the
 * details cannot pin ONE bale, the label is set aside with the candidate
 * analysis in its skip reason ("could be 1002 or 1005") instead of an
 * interactive picker ("what is the whole purpose of making it faster?").
 * Pure (no session/IO); shared by the sale and transfer paths.
 *
 * @param {object[]} grouped   groupBales() output (all stores)
 * @param {object[]} ocrBales  mapParsedBales() rows
 * @returns {{items: object[], skipped: Array<{label, reason}>}}
 */
function matchBatch(grouped, ocrBales) {
  const items = [];
  const skipped = [];
  const seenLabels = new Set();
  const taken = new Set();
  for (const b of ocrBales) {
    const digits = String(b.packageNo || '').replace(/\D/g, '');
    // No-number labels (unreadable bale no.) dedupe on their full detail
    // set instead, so two distinct same-design bales don't collapse.
    const labelKey = digits
      ? `${digits}|${normCode(b.design)}`
      : `?|${normCode(b.design)}|${normCode(b.shade)}|${b.thanNo || ''}|${b.yards || ''}`;
    if ((!b.packageNo && !b.design) || seenLabels.has(labelKey)) continue; // junk / duplicate page
    seenLabels.add(labelKey);
    const label = `${b.packageNo || '(no number)'} ${b.design || ''}`.trim();
    if (b.packageNo) {
      const exact = matchBales(grouped, b).filter((m) => !taken.has(`${m.warehouse}|${m.packageNo}`));
      if (exact.length === 1) {
        taken.add(`${exact[0].warehouse}|${exact[0].packageNo}`);
        items.push(exact[0]);
        continue;
      }
      if (exact.length > 1) {
        // Same bale number lives in more than one store — kept aside.
        skipped.push({ label, reason: `could be ${candList(exact)} — kept aside` });
        continue;
      }
    }
    const rescue = rescueMatch(grouped, b, taken);
    if (rescue.cand) {
      taken.add(`${rescue.cand.warehouse}|${rescue.cand.packageNo}`);
      items.push({ ...rescue.cand, _rescued: `label read "${label}"` });
      continue;
    }
    if (rescue.cands.length > 1) {
      skipped.push({ label, reason: `could be ${candList(rescue.cands)} — kept aside` });
      continue;
    }
    skipped.push({ label, reason: 'not available in the sheet' });
  }
  return { items, skipped };
}

/* ── screens ── */

async function start(bot, chatId, userId, messageId) {
  sessionStore.set(userId, { type: SESSION_TYPE, step: 'await_photo', flowMessageId: messageId || null, startedAt: Date.now() });
  await render(bot, chatId, userId,
    '📸 *Snap Sale*\n\nSend a clear photo of the *bale label* (the sack side with Bale No. / Design No. / Colour No.) — I will read it and match the bale.\n\n'
    + '📄 Supplying MANY bales to one customer — or *dispatching to another warehouse*? Send a *PDF* containing the label photos and I will read them ALL together.',
    [cancelRow()]);
}

function readBackLine(ocr) {
  const bits = [];
  if (ocr.packageNo) bits.push(`Bale *${ocr.packageNo}*`);
  if (ocr.design) bits.push(`Design *${ocr.design}*`);
  if (ocr.shade) bits.push(`Colour *${ocr.shade}*`);
  if (ocr.yards) bits.push(`${ocr.yards} m`);
  return bits.join(' · ') || '_could not read the label_';
}

async function showMatch(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const b = session.bale;
  const recent = (await transactionsRepository.getCustomersByDesign(b.design).catch(() => [])).slice(0, 6);
  session._recent = recent;
  sessionStore.set(userId, session);
  const rows = chunk(recent.map((c, i) => ({ text: `👤 ${c}`, callback_data: `${NS}cu:${i}` })), 2);
  rows.push([{ text: '📋 All customers', callback_data: `${NS}all:0` }]);
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    `📸 Read from label: ${readBackLine(session.ocr)}\n\n`
    + `✅ *Matched bale:*\n📦 *${mdEscape(b.packageNo)}* — ${mdEscape(b.design)} · shade ${mdEscape(b.shade || '—')}\n`
    + `🏭 ${mdEscape(b.warehouse)} · ${b.availableThans} thans · ${Math.round(b.availableYards)} yds available\n\n`
    + '*Who is buying?* (recent buyers of this design first)',
    rows);
}

async function showAllCustomers(bot, chatId, userId, page) {
  const session = sessionStore.get(userId);
  const customersRepository = require('../repositories/customersRepository');
  const all = (await customersRepository.getAll())
    .filter((c) => (c.status || '').toLowerCase() !== 'inactive')
    .sort((a, b2) => a.name.localeCompare(b2.name));
  const pages = Math.max(1, Math.ceil(all.length / CUSTOMERS_PAGE));
  const p = Math.min(Math.max(page, 0), pages - 1);
  session._all = all.slice(p * CUSTOMERS_PAGE, (p + 1) * CUSTOMERS_PAGE).map((c) => c.name);
  sessionStore.set(userId, session);
  const rows = chunk(session._all.map((n, i) => ({ text: `👤 ${n}`, callback_data: `${NS}ca:${i}` })), 2);
  const pager = [];
  if (p > 0) pager.push({ text: '◀ Prev', callback_data: `${NS}all:${p - 1}` });
  if (p < pages - 1) pager.push({ text: 'More ▶', callback_data: `${NS}all:${p + 1}` });
  if (pager.length) rows.push(pager);
  rows.push([{ text: '⬅ Back', callback_data: `${NS}bk` }]);
  rows.push(cancelRow());
  await render(bot, chatId, userId, `📋 All customers (page ${p + 1}/${pages}):`, rows);
}

async function showConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const b = session.bale;
  await render(bot, chatId, userId,
    `📸 *Confirm sale*\n\n📦 Bale *${mdEscape(b.packageNo)}* — ${mdEscape(b.design)} · shade ${mdEscape(b.shade || '—')}\n`
    + `🏭 ${mdEscape(b.warehouse)} · ${b.availableThans} thans · ${Math.round(b.availableYards)} yds\n`
    + `👤 Customer: *${mdEscape(session.customer)}*\n📅 ${todayInLagos()}\n\n`
    + '_The label photo is attached as the sale document. Rate and payment are entered by the approving admin._',
    [[{ text: '✅ Submit for approval', callback_data: `${NS}ok` }], cancelRow()]);
}

/* ── photo entry (routed from the controller file router) ── */

async function handleFile(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || session.step !== 'await_photo') return false;
  // SNAP-3 — a PDF of label photos takes the batch path.
  if (msg.document && /pdf/i.test(msg.document.mime_type || '')) {
    return handleBatchPdf(bot, msg, session);
  }
  if (!msg.photo || !msg.photo.length) return false;
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  session.photoFileId = fileId;
  sessionStore.set(userId, session);
  await render(bot, chatId, userId, '📸 Reading the label…', [cancelRow()]);
  try {
    const { downloadTelegramFile } = require('../utils/telegramFiles');
    const vision = require('../services/vision');
    const { buffer, mimeType } = await downloadTelegramFile(bot, fileId);
    const ocr = await vision.extractBales(buffer, mimeType || 'image/jpeg');
    const best = (ocr.ok && ocr.bales && ocr.bales.length)
      ? [...ocr.bales].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0]
      : null;
    if (!best || !best.packageNo) {
      await render(bot, chatId, userId,
        `📸 I couldn't read a bale number from that photo${ocr.error ? ` (${ocr.error})` : ''}.\n\nTry a clearer photo, or sell the normal way:`,
        [[{ text: '💰 Open Sell Bale', callback_data: 'act:sell_bale' }], cancelRow()]);
      return true;
    }
    session.ocr = { packageNo: best.packageNo, design: best.design || '', shade: best.shade || '', yards: best.yards || best.netMtrs || 0 };
    const matches = matchBales(groupBales(await inventoryRepository.getAll()), session.ocr);
    if (!matches.length) {
      sessionStore.set(userId, session);
      await render(bot, chatId, userId,
        `📸 Read from label: ${readBackLine(session.ocr)}\n\n⚠️ No AVAILABLE bale in the sheet matches this label — it may be sold already or recorded differently.\n\nSell the normal way instead:`,
        [[{ text: '💰 Open Sell Bale', callback_data: 'act:sell_bale' }], cancelRow()]);
      return true;
    }
    if (matches.length > 1) {
      session._matches = matches;
      session.step = 'pick_match';
      sessionStore.set(userId, session);
      await render(bot, chatId, userId,
        `📸 Read from label: ${readBackLine(session.ocr)}\n\nThis bale number exists in more than one place — which one?`,
        [...chunk(matches.map((m, i) => ({ text: `📦 ${m.packageNo} · ${m.design} · ${m.warehouse}`, callback_data: `${NS}m:${i}` })), 1), cancelRow()]);
      return true;
    }
    session.bale = matches[0];
    session.step = 'pick_customer';
    sessionStore.set(userId, session);
    await showMatch(bot, chatId, userId);
    return true;
  } catch (e) {
    logger.warn(`snap sale OCR failed: ${e.message}`);
    await render(bot, chatId, userId, '⚠️ Could not process the photo. Try again, or use 💰 Sell Bale.',
      [[{ text: '💰 Open Sell Bale', callback_data: 'act:sell_bale' }], cancelRow()]);
    return true;
  }
}

/* ── SNAP-3: PDF batch (many labels, one customer, ONE approval) ── */

async function handleBatchPdf(bot, msg, session) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const doc = msg.document;
  if (doc.file_size && doc.file_size > config.ocr.maxPdfBytes) {
    await render(bot, chatId, userId,
      `📄 That PDF is ${(doc.file_size / 1024 / 1024).toFixed(1)} MB — the limit is ${(config.ocr.maxPdfBytes / 1024 / 1024).toFixed(0)} MB. Split it and send again.`,
      [cancelRow()]);
    return true;
  }
  session.pdfFileId = doc.file_id;
  sessionStore.set(userId, session);
  await render(bot, chatId, userId, '📄 Reading every label in the PDF… big PDFs are read in parts and can take a few minutes.', [cancelRow()]);
  try {
    const { downloadTelegramFile } = require('../utils/telegramFiles');
    const vision = require('../services/vision');
    const { buffer } = await downloadTelegramFile(bot, doc.file_id);
    const ocr = await vision.extractBales(buffer, 'application/pdf');
    if (!ocr.ok || !ocr.bales || !ocr.bales.length) {
      const err = ocr.error || 'no labels recognised';
      const hint = /ANTHROPIC_API_KEY|not supported by the openai provider/i.test(err)
        ? '\n\n_PDF reading runs on the Claude provider — add ANTHROPIC_API_KEY in Railway to enable it._'
        : '';
      await render(bot, chatId, userId, `📄 Could not read the PDF (${mdEscape(err)}).${hint}`,
        [[{ text: '💰 Open Sell Bale', callback_data: 'act:sell_bale' }], cancelRow()]);
      return true;
    }

    const grouped = groupBales(await inventoryRepository.getAll());
    // SNAP-6b: exact match → attribute rescue → keep aside. No questions.
    const { items, skipped } = matchBatch(grouped, ocr.bales);
    if (!items.length) {
      await render(bot, chatId, userId,
        `📄 Read ${ocr.bales.length} label(s) but NONE matched an available bale:\n`
        + skipped.slice(0, 10).map((s) => `  ⚠️ ${mdEscape(s.label)} — ${mdEscape(s.reason)}`).join('\n')
        + '\n\nSell the normal way instead:',
        [[{ text: '💰 Open Sell Bale', callback_data: 'act:sell_bale' }], cancelRow()]);
      return true;
    }
    session.batch = { items, skipped };
    session.bale = null;
    session.step = 'pick_customer';
    sessionStore.set(userId, session);
    await showBatchReview(bot, chatId, userId);
    return true;
  } catch (e) {
    logger.warn(`snap PDF batch failed: ${e.message}`);
    await render(bot, chatId, userId, '⚠️ Could not process the PDF. Try again, or use 💰 Sell Bale.',
      [[{ text: '💰 Open Sell Bale', callback_data: 'act:sell_bale' }], cancelRow()]);
    return true;
  }
}

function batchSummaryLines(batch, cap = 12) {
  // CARD-2 — same canonical order as the approval card: design → shade → bale.
  try { batch.items = require('../services/approvalCards').sortSaleItems(batch.items); } catch (_) { /* unsorted */ }
  const lines = batch.items.slice(0, cap).map((m) =>
    `  ${m._rescued ? '🔎' : '✅'} *${mdEscape(m.packageNo)}* — ${mdEscape(m.design)} · ${mdEscape(m.warehouse)} · ${m.availableThans} thans · ${Math.round(m.availableYards)} yds`
    + (m._rescued ? ` — _by details (${mdEscape(m._rescued)})_` : ''));
  if (batch.items.length > cap) lines.push(`  …+${batch.items.length - cap} more matched`);
  for (const s of batch.skipped.slice(0, 6)) lines.push(`  ⚠️ ${mdEscape(s.label)} — ${mdEscape(s.reason)} (skipped)`);
  if (batch.skipped.length > 6) lines.push(`  …+${batch.skipped.length - 6} more skipped`);
  return lines.join('\n');
}


async function showBatchReview(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const batch = session.batch;
  const firstDesign = batch.items[0].design;
  const recent = (await transactionsRepository.getCustomersByDesign(firstDesign).catch(() => [])).slice(0, 6);
  session._recent = recent;
  sessionStore.set(userId, session);
  const rows = chunk(recent.map((c, i) => ({ text: `👤 ${c}`, callback_data: `${NS}cu:${i}` })), 2);
  rows.push([{ text: '📋 All customers', callback_data: `${NS}all:0` }]);
  // SNAP-4 — the same PDF can be a warehouse dispatch instead of a sale.
  // Transfers are admin-created (same rule as the trf: wizard).
  if (auth.isAdmin(userId)) {
    rows.push([{ text: '🚚 This is a TRANSFER, not a sale', callback_data: `${NS}tmode` }]);
  }
  rows.push(cancelRow());
  const totalYards = batch.items.reduce((s, m) => s + m.availableYards, 0);
  await render(bot, chatId, userId,
    `📄 *PDF batch — ${batch.items.length} bale(s) matched* (${Math.round(totalYards)} yds)\n\n`
    + `${batchSummaryLines(batch)}\n\n`
    + '*Who is buying the whole batch?*',
    rows);
}

async function showBatchConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const batch = session.batch;
  const totalYards = batch.items.reduce((s, m) => s + m.availableYards, 0);
  const totalThans = batch.items.reduce((s, m) => s + m.availableThans, 0);
  await render(bot, chatId, userId,
    `📄 *Confirm batch sale*\n\n${batchSummaryLines(batch)}\n\n`
    + `Total: *${batch.items.length} bales* (${totalThans} thans), *${Math.round(totalYards)} yds*\n`
    + `👤 Customer: *${mdEscape(session.customer)}*\n📅 ${todayInLagos()}\n\n`
    + '_The PDF is attached as the sale document. Rate and payment are entered by the approving admin._',
    [[{ text: '✅ Submit for approval', callback_data: `${NS}ok` }], cancelRow()]);
}

/* ── SNAP-4: PDF batch as a WAREHOUSE TRANSFER ── */

function normWh(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/**
 * Split matched bales into per-SOURCE-warehouse transfer groups for a given
 * destination. Bales already sitting at the destination go to `stay`.
 * Each group carries service-shaped `lines` ({design, shade, qty}) plus a
 * parallel `picks` array (exact packageNos per line — the PDF documents the
 * physical dispatch, so nothing is left to a picker).
 */
function buildTransferGroups(items, dest) {
  const stay = [];
  const bySource = new Map();
  for (const m of items) {
    if (normWh(m.warehouse) === normWh(dest)) { stay.push(m); continue; }
    if (!bySource.has(m.warehouse)) bySource.set(m.warehouse, []);
    bySource.get(m.warehouse).push(m);
  }
  const groups = [...bySource.entries()].map(([from, bales]) => {
    const lineMap = new Map();
    for (const b of bales) {
      const k = `${b.design}|${b.shade || ''}`;
      if (!lineMap.has(k)) lineMap.set(k, { design: b.design, shade: b.shade || '', qty: 0, picks: [] });
      const l = lineMap.get(k);
      l.qty += 1;
      l.picks.push(b.packageNo);
    }
    const ls = [...lineMap.values()];
    return {
      from, bales,
      lines: ls.map(({ design, shade, qty }) => ({ design, shade, qty })),
      picks: ls.map((l) => l.picks),
    };
  });
  return { groups, stay };
}

async function showTransferDest(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  // Same destination universe as the trf: wizard: warehouses with stock ∪
  // warehouses users are assigned to (an empty warehouse can still receive).
  const inv = await inventoryRepository.getAll();
  const users = await usersRepository.getAll().catch(() => []);
  const set = new Set(inv.map((r) => r.warehouse).filter(Boolean));
  for (const u of users) for (const w of (u.warehouses || [])) if (w) set.add(w);
  const dests = [...set].sort();
  session._dests = dests;
  session.step = 'transfer_dest';
  sessionStore.set(userId, session);
  const sources = [...new Set(session.batch.items.map((m) => m.warehouse))];
  const rows = chunk(dests.map((w, i) => ({ text: `🏭 ${w}`, callback_data: `${NS}tdst:${i}` })), 2);
  rows.push([{ text: '⬅ Back', callback_data: `${NS}bk` }]);
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    `🚚 *Transfer the PDF batch* — ${session.batch.items.length} bale(s) from *${sources.map(mdEscape).join('* + *')}*\n\nTo which warehouse?`,
    rows);
}

async function showTransferReceiver(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const { candidatesFor } = require('./transferFlow')._internals;
  const cands = await candidatesFor(session.transferTo);
  if (!cands.length) {
    await render(bot, chatId, userId,
      `⚠️ No active users found for *${mdEscape(session.transferTo)}* — assign one first (Manage Users).`,
      [[{ text: '⬅ Back', callback_data: `${NS}tmode` }], cancelRow()]);
    return;
  }
  if (cands.length === 1) {
    session.transferReceiver = { user_id: cands[0].user_id, name: cands[0].name };
    sessionStore.set(userId, session);
    await showTransferConfirm(bot, chatId, userId);
    return;
  }
  session._people = cands.slice(0, 12).map((u) => ({ user_id: u.user_id, name: u.name }));
  session.step = 'transfer_receiver';
  sessionStore.set(userId, session);
  const rows = chunk(session._people.map((u, i) => ({ text: `👤 ${u.name}`, callback_data: `${NS}trc:${i}` })), 2);
  rows.push([{ text: '⬅ Back', callback_data: `${NS}tmode` }]);
  rows.push(cancelRow());
  await render(bot, chatId, userId, `🚚 Who receives at *${mdEscape(session.transferTo)}*?`, rows);
}

async function showTransferConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  const { groups, stay } = buildTransferGroups(session.batch.items, session.transferTo);
  if (!groups.length) {
    await render(bot, chatId, userId,
      `⚠️ Every matched bale is ALREADY at *${mdEscape(session.transferTo)}* — nothing to transfer.`,
      [[{ text: '⬅ Back', callback_data: `${NS}tmode` }], cancelRow()]);
    return;
  }
  session.step = 'transfer_confirm';
  sessionStore.set(userId, session);
  const lines = groups.map((g) => {
    const pkgs = g.bales.map((b) => b.packageNo);
    const preview = pkgs.length > 8 ? `${pkgs.slice(0, 8).join(', ')} … (+${pkgs.length - 8})` : pkgs.join(', ');
    return `📦 *${mdEscape(g.from)}* → *${mdEscape(session.transferTo)}* — ${g.bales.length} bale(s)\n   ${mdEscape(preview)}`;
  });
  const stayNote = stay.length
    ? `\n⚠️ ${stay.length} bale(s) already at ${mdEscape(session.transferTo)} — skipped: ${stay.map((b) => mdEscape(b.packageNo)).join(', ')}`
    : '';
  const rescuedN = session.batch.items.filter((m) => m._rescued).length;
  const rescueNote = rescuedN
    ? `\n🔎 ${rescuedN} bale(s) identified by label details, not number — double-check them above before dispatching.`
    : '';
  await render(bot, chatId, userId,
    `🚚 *Confirm dispatch*\n\n${lines.join('\n')}${stayNote}${rescueNote}\n\n`
    + `Receiver: *${mdEscape(session.transferReceiver.name)}*\n\n`
    + `_Submitting dispatches IMMEDIATELY — the PDF is the load document. Stock shows *in transit* at ${mdEscape(session.transferTo)} until ${mdEscape(session.transferReceiver.name)} confirms receipt._`,
    [[{ text: '🚚 Dispatch now', callback_data: `${NS}tok` }],
      [{ text: '⬅ Back', callback_data: `${NS}tmode` }], cancelRow()]);
}

async function submitTransferBatch(bot, chatId, userId, session) {
  const transferService = require('../services/transferService');
  const tf = require('./transferFlow')._internals;
  const to = session.transferTo;
  const receiver = session.transferReceiver;
  const { groups, stay } = buildTransferGroups(session.batch.items, to);
  if (!groups.length) return true;

  // Best-effort Drive archive of the PDF (shared by every group's record).
  let url = '';
  try {
    const { downloadTelegramFile } = require('../utils/telegramFiles');
    const driveBackup = require('../services/vision/driveBackup');
    const dl = await downloadTelegramFile(bot, session.pdfFileId);
    let uploader = userId;
    try { const u = await usersRepository.findByUserId(userId); if (u && u.name) uploader = u.name; } catch (_) { /* raw id */ }
    const up = await driveBackup.archiveFile(dl.buffer, dl.mimeType || 'application/pdf',
      { uploader, originalName: 'snap-transfer.pdf', kind: 'photo' });
    url = (up && up.drive && up.drive.webViewLink) || '';
  } catch (e) { logger.warn(`snap transfer: PDF archive failed: ${e.message}`); }

  const created = [];
  const failed = [];
  for (const g of groups) {
    let requestId = null;
    try {
      ({ requestId } = await transferService.createTransferRequest({
        from: g.from, to, lines: g.lines, requestedBy: userId,
        dispatcher: userId, receiver: receiver.user_id,
      }));
      const res = await transferService.dispatch(requestId, userId, g.picks);
      if (!res.ok) {
        failed.push({ from: g.from, message: res.message });
        await transferService.abort(requestId, userId).catch(() => {});
        continue;
      }
      const aj = res.aj;
      await transferService.attachDoc(requestId, 'dispatch',
        { url, name: 'Dispatch PDF (snap batch)', fileId: session.pdfFileId || '', by: userId });
      // Receiver card rides the EXISTING trf: pipeline (Received / Reject),
      // with the PDF forwarded for eyes-on.
      try {
        const card = tf.receiverCard(requestId, aj);
        await bot.sendMessage(receiver.user_id, card.text, { parse_mode: 'Markdown', reply_markup: card.kb });
        if (session.pdfFileId) {
          await bot.sendDocument(receiver.user_id, session.pdfFileId, { caption: `📄 Dispatch PDF — ${requestId}` });
        }
      } catch (e) { logger.warn(`snap transfer: receiver DM failed: ${e.message}`); }
      for (const adminId of config.access.adminIds) {
        if (String(adminId) === String(userId)) continue;
        try {
          await bot.sendMessage(adminId, tf.shortCard(requestId, aj, 'dispatched 🚚 (PDF batch)'), {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔍 View details', callback_data: `trf:info:${requestId}` }]] },
          });
        } catch (_) { /* best-effort */ }
      }
      await auditLogRepository.append('transfer.pdf_batch',
        { requestId, from: g.from, to, bales: (aj.bales || []).length, source: 'snap_pdf' }, userId);
      created.push({ requestId, from: g.from, n: (aj.bales || []).length, short: res.short });
    } catch (e) {
      logger.warn(`snap transfer group ${g.from}: ${e.message}`);
      failed.push({ from: g.from, message: e.message });
    }
  }

  const okLines = created.map((c) =>
    `  ✅ \`${c.requestId}\` ${mdEscape(c.from)} → ${mdEscape(to)} — ${c.n} bale(s)${c.short ? ' ⚠️ short' : ''}`);
  const failLines = failed.map((f) => `  ⚠️ ${mdEscape(f.from)} — ${mdEscape(f.message)}`);
  const stayLine = stay.length ? `\n⚠️ ${stay.length} bale(s) already at ${mdEscape(to)} — untouched.` : '';
  // Render BEFORE clearing — the anchored renderer no-ops without a session.
  await render(bot, chatId, userId,
    `🚚 *Dispatched from the PDF*\n\n${[...okLines, ...failLines].join('\n')}${stayLine}\n\n`
    + `⏳ *${mdEscape(receiver.name)}* confirms each transfer on arrival (stock then goes live at ${mdEscape(to)}).`,
    [[{ text: '📸 Snap another', callback_data: 'act:snap_sale' }, { text: '🏠 Menu', callback_data: 'act:__back__' }]]);
  sessionStore.clear(userId);
  return true;
}

async function submitBatch(bot, chatId, userId, session) {
  const batch = session.batch;
  const seller = await usersRepository.findByUserId(userId).catch(() => null);
  const sellerLabel = (seller && seller.name)
    || await require('../services/approvalCards').resolveUserLabel(userId, bot);
  const requestId = idGenerator.requestId();
  const totalYards = Math.round(batch.items.reduce((s, m) => s + m.availableYards, 0));
  const yardsByDesign = {};
  for (const m of batch.items) {
    yardsByDesign[m.design] = (yardsByDesign[m.design] || 0) + m.availableYards;
  }
  const actionJSON = {
    action: 'sale_bundle',
    items: batch.items.map((m) => ({ type: 'package', packageNo: m.packageNo })),
    customer: session.customer,
    salesDate: todayInLagos(),
    salesPerson: sellerLabel,
    paymentMode: '',
    totalYards,
    yardsByDesign,
    // The PDF IS the attached sale document (ST-1 preview + Drive archival).
    sale_doc_file_id: session.pdfFileId || '',
    sale_doc_type: 'document',
    source: 'snap_pdf',
  };
  await approvalQueueRepository.append({
    requestId, user: userId, actionJSON,
    riskReason: 'All sale operations require admin approval.', status: 'pending',
  });
  await auditLogRepository.append('approval_queued',
    { requestId, action: 'sale_bundle', source: 'snap_pdf', bales: batch.items.length, skipped: batch.skipped.length }, userId);

  let adminCards = 0;
  const excludeId = config.access.adminIds.includes(userId) ? userId : undefined;
  try {
    const approvalEvents = require('../events/approvalEvents');
    const approvalCards = require('../services/approvalCards');
    let card = await approvalCards.buildSaleCard({
      headline: 'Sale Request (Snap PDF batch)',
      customer: session.customer,
      salesPerson: sellerLabel,
      salesDate: actionJSON.salesDate,
      items: batch.items.map((m) => ({
        packageNo: m.packageNo, design: m.design, shade: m.shade,
        thans: m.availableThans, yards: Math.round(m.availableYards), warehouse: m.warehouse,
      })),
      docAttached: !!actionJSON.sale_doc_file_id,
      docLabel: 'Supply PDF',
    });
    // SNAP-6 — rescues are flagged so the approving admin double-checks them.
    const rescued = batch.items.filter((m) => m._rescued);
    if (rescued.length) {
      card += `\n🔎 Identified by label DETAILS, not by number (${rescued.length}): `
        + rescued.map((m) => `${m.packageNo} (${m._rescued})`).join('; ');
    }
    if (batch.skipped.length) {
      card += `\n⚠️ Skipped from the PDF (${batch.skipped.length}): `
        + batch.skipped.map((s) => `${s.label} (${s.reason})`).join('; ');
    }
    const res = await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, sellerLabel,
      card, 'All sale operations require admin approval.', excludeId);
    adminCards = (res && res.sent) || 0;
    if (actionJSON.sale_doc_file_id) {
      await approvalCards.forwardAttachmentsToAdmins(bot, requestId,
        [{ fileId: actionJSON.sale_doc_file_id, kind: 'document', caption: `📄 Supply PDF for request ${requestId}` }], excludeId);
    }
  } catch (e) { logger.warn(`snap pdf cards: ${e.message}`); }

  const notifyWarning = adminCards === 0
    ? '\n\n⚠️ Admins could not be notified right now — ask an admin to check Pending Approvals.'
    : '';
  await render(bot, chatId, userId,
    `✅ *Submitted.*\n\n📄 ${batch.items.length} bale(s) → *${mdEscape(session.customer)}*\nRequest: \`${requestId}\`\n\n⏳ Waiting for admin approval (rate + payment entered there).${notifyWarning}`,
    [[{ text: '📸 Snap another', callback_data: 'act:snap_sale' }, { text: '🏠 Menu', callback_data: 'act:__back__' }]]);
  sessionStore.clear(userId);
  return true;
}

/* ── callbacks ── */

async function handleCallback(bot, callbackQuery) {
  const data = callbackQuery.data || '';
  if (!data.startsWith(NS)) return false;
  const chatId = callbackQuery.message.chat.id;
  const userId = String(callbackQuery.from.id);
  await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'This card expired. Open 📸 Snap Sale again.', show_alert: true }).catch(() => {});
    return true;
  }
  const rest = data.slice(NS.length);

  if (rest === 'cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '📸 Snap Sale cancelled.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return true;
  }
  if (rest.startsWith('m:')) {
    const m = (session._matches || [])[Number(rest.slice(2))];
    if (!m) return true;
    session.bale = m;
    session.step = 'pick_customer';
    sessionStore.set(userId, session);
    await showMatch(bot, chatId, userId);
    return true;
  }
  if (rest === 'bk') {
    if (session.step === 'confirm') { session.step = 'pick_customer'; sessionStore.set(userId, session); }
    if (session.batch) await showBatchReview(bot, chatId, userId);
    else await showMatch(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('all:')) {
    if (!session.bale && !session.batch) return true;
    await showAllCustomers(bot, chatId, userId, Number(rest.slice(4)));
    return true;
  }
  if (rest.startsWith('cu:') || rest.startsWith('ca:')) {
    const list = rest.startsWith('cu:') ? session._recent : session._all;
    const name = (list || [])[Number(rest.slice(3))];
    if (!name || (!session.bale && !session.batch)) return true;
    session.customer = name;
    session.step = 'confirm';
    sessionStore.set(userId, session);
    if (session.batch) await showBatchConfirm(bot, chatId, userId);
    else await showConfirm(bot, chatId, userId);
    return true;
  }
  // SNAP-4 — the PDF batch as a warehouse transfer (admin-only).
  if (rest === 'tmode') {
    if (!session.batch) return true;
    if (!auth.isAdmin(userId)) {
      await bot.answerCallbackQuery(callbackQuery.id,
        { text: '🚚 Transfers can be created by admins only.', show_alert: true }).catch(() => {});
      return true;
    }
    await showTransferDest(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('tdst:')) {
    const w = (session._dests || [])[Number(rest.slice(5))];
    if (!w || !session.batch) return true;
    session.transferTo = w;
    sessionStore.set(userId, session);
    await showTransferReceiver(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('trc:')) {
    const p = (session._people || [])[Number(rest.slice(4))];
    if (!p || !session.batch) return true;
    session.transferReceiver = p;
    sessionStore.set(userId, session);
    await showTransferConfirm(bot, chatId, userId);
    return true;
  }
  if (rest === 'tok') {
    if (session.step !== 'transfer_confirm' || !session.batch || !session.transferTo || !session.transferReceiver) return true;
    if (!auth.isAdmin(userId)) return true;
    return submitTransferBatch(bot, chatId, userId, session);
  }
  if (rest === 'ok') {
    // SNAP-3 batch submit: one sale_bundle for the whole PDF.
    if (session.batch) {
      if (session.step !== 'confirm' || !session.customer || !session.batch.items.length) return true;
      return submitBatch(bot, chatId, userId, session);
    }
    if (session.step !== 'confirm' || !session.bale || !session.customer) return true;
    const b = session.bale;
    const seller = await usersRepository.findByUserId(userId).catch(() => null);
    const sellerLabel = (seller && seller.name)
      || await require('../services/approvalCards').resolveUserLabel(userId, bot);
    const requestId = idGenerator.requestId();
    const actionJSON = {
      action: 'sell_package',
      packageNo: b.packageNo, design: b.design, shade: b.shade || '',
      yards: Math.round(b.availableYards), thans: b.availableThans,
      warehouse: b.warehouse || '',
      customer: session.customer, salesDate: todayInLagos(),
      salesPerson: sellerLabel,
      // Owner decision (b): the label photo IS the attached sale document —
      // rides the exact ST-1 machinery (admin preview + Drive archival).
      sale_doc_file_id: session.photoFileId || '',
      source: 'snap_sale',
    };
    await approvalQueueRepository.append({
      requestId, user: userId, actionJSON,
      riskReason: 'All sale operations require admin approval.', status: 'pending',
    });
    await auditLogRepository.append('approval_queued', { requestId, action: 'sell_package', source: 'snap_sale', packageNo: b.packageNo }, userId);
    // APU-1: the approving admin sees the SAME card as a classic sale —
    // full item line + totals + the label photo forwarded before deciding.
    let adminCards = 0;
    const excludeId = config.access.adminIds.includes(userId) ? userId : undefined;
    try {
      const approvalEvents = require('../events/approvalEvents');
      const approvalCards = require('../services/approvalCards');
      const card = await approvalCards.buildSellPackageCard(actionJSON);
      const res = await approvalEvents.notifyAdminsApprovalRequest(bot, requestId, sellerLabel,
        card, 'All sale operations require admin approval.', excludeId);
      adminCards = (res && res.sent) || 0;
      if (actionJSON.sale_doc_file_id) {
        await approvalCards.forwardAttachmentsToAdmins(bot, requestId,
          [{ fileId: actionJSON.sale_doc_file_id, kind: 'photo', caption: `📷 Sales bill for request ${requestId}` }], excludeId);
      }
    } catch (e) { logger.warn(`snap sale cards: ${e.message}`); }
    const notifyWarning = adminCards === 0
      ? '\n\n⚠️ Admins could not be notified right now — ask an admin to check Pending Approvals.'
      : '';
    // Render BEFORE clearing: the anchored renderer no-ops once the session
    // is gone, which silently ate the seller's "Submitted" confirmation
    // (latent since SNAP-1; surfaced by the APU-1 adversarial review).
    await render(bot, chatId, userId,
      `✅ *Submitted.*\n\n📦 Bale ${mdEscape(b.packageNo)} — ${mdEscape(b.design)} → *${mdEscape(session.customer)}*\nRequest: \`${requestId}\`\n\n⏳ Waiting for admin approval (rate + payment entered there).${notifyWarning}`,
      [[{ text: '📸 Snap another', callback_data: 'act:snap_sale' }, { text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    sessionStore.clear(userId);
    return true;
  }
  return true;
}

module.exports = {
  SESSION_TYPE, start, handleCallback, handleFile,
  _internals: { buildTransferGroups, matchBatch, rescueMatch, matchBales, normCode },
};
