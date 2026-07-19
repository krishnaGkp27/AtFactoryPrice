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
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, chunk, mdEscape } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const transactionsRepository = require('../repositories/transactionsRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const usersRepository = require('../repositories/usersRepository');
const idGenerator = require('../utils/idGenerator');
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
 * Match the OCR'd label against available bales: bale-number digits must
 * match (exact or suffix — sheets sometimes prefix e.g. "P896"), and when
 * OCR also read a design it must agree.
 */
function matchBales(bales, ocr) {
  const pkgDigits = String(ocr.packageNo || '').replace(/\D/g, '');
  if (!pkgDigits) return [];
  const design = String(ocr.design || '').trim().toUpperCase();
  return bales.filter((b) => {
    const bDigits = String(b.packageNo).replace(/\D/g, '');
    if (bDigits !== pkgDigits && !String(b.packageNo).toUpperCase().endsWith(pkgDigits)) return false;
    if (design && String(b.design).toUpperCase() !== design) return false;
    return true;
  });
}

/* ── screens ── */

async function start(bot, chatId, userId, messageId) {
  sessionStore.set(userId, { type: SESSION_TYPE, step: 'await_photo', flowMessageId: messageId || null, startedAt: Date.now() });
  await render(bot, chatId, userId,
    '📸 *Snap Sale*\n\nSend a clear photo of the *bale label* (the sack side with Bale No. / Design No. / Colour No.).\n\nI will read it and match the bale for you.',
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
    await showMatch(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('all:')) {
    if (!session.bale) return true;
    await showAllCustomers(bot, chatId, userId, Number(rest.slice(4)));
    return true;
  }
  if (rest.startsWith('cu:') || rest.startsWith('ca:')) {
    const list = rest.startsWith('cu:') ? session._recent : session._all;
    const name = (list || [])[Number(rest.slice(3))];
    if (!name || !session.bale) return true;
    session.customer = name;
    session.step = 'confirm';
    sessionStore.set(userId, session);
    await showConfirm(bot, chatId, userId);
    return true;
  }
  if (rest === 'ok') {
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

module.exports = { SESSION_TYPE, start, handleCallback, handleFile };
