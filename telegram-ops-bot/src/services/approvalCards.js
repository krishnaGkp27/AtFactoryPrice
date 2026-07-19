/**
 * APU-1 — the single place approval-card content is built and request
 * attachments are forwarded to admins.
 *
 * Owner directive (18-Jul-2026): every approval rides one channel with the
 * same stages, and the approving admin must see the SAME detail level the
 * classic sale card established (customer + phone/address, salesperson,
 * canonical date, per-item lines with warehouse, totals, attached document
 * forwarded before the decision). See docs/AUDIT_APPROVALS_2026-07-18.md.
 *
 * Rules for builders here:
 *   - PLAIN TEXT ONLY. notifyAdminsApprovalRequest MarkdownV2-escapes the
 *     whole summary, so any '*'/'`' written here renders literally.
 *   - Render from the queued actionJSON wherever possible so the reminder
 *     sweep and the morning digest can rebuild the SAME card later from the
 *     sheet row alone (no session required).
 *   - Missing lookups (CRM, users) degrade silently to fewer lines — a card
 *     must never fail to render.
 */

'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const usersRepository = require('../repositories/usersRepository');
const { fmtQty } = require('../utils/format');
const fmtDate = require('../utils/formatDate');

/**
 * Resolve a Telegram user id to a human-readable display name.
 *
 * Sources, in order (owner 19-Jul: "everything human-readable"):
 *   1. Users sheet (user_id → name) — staff added via the bot.
 *   2. PendingUsers sheet — people who /start-ed but were never onboarded.
 *   3. Telegram itself via bot.getChat — works for ANYONE who has messaged
 *      the bot, including env-ADMIN_IDS admins who predate the Users sheet
 *      and therefore have no row in it (the exact case behind raw ids
 *      appearing on digest cards). Pass `bot` whenever you have one.
 *   4. The raw id, only when every source comes up empty.
 * Results are cached ~10 min so list renders don't hammer Sheets/Telegram.
 */
const _nameCache = new Map(); // id → { label, at }
const NAME_CACHE_TTL_MS = 10 * 60 * 1000;

async function resolveUserLabel(userId, bot) {
  const key = String(userId || '').trim();
  if (!key) return 'Unknown';
  const hit = _nameCache.get(key);
  if (hit && Date.now() - hit.at < NAME_CACHE_TTL_MS) return hit.label;
  let label = '';
  try {
    const u = await usersRepository.findByUserId(key);
    if (u && u.name) label = u.name;
  } catch (_) { /* next source */ }
  if (!label) {
    try {
      const pendingUsersRepository = require('../repositories/pendingUsersRepository');
      const rows = await pendingUsersRepository.getAll();
      const p = rows.find((r) => String(r.telegram_id) === key);
      if (p) label = [p.first_name, p.last_name].filter(Boolean).join(' ') || (p.username ? `@${p.username}` : '');
    } catch (_) { /* next source */ }
  }
  if (!label && bot && typeof bot.getChat === 'function') {
    try {
      const c = await bot.getChat(key);
      label = [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? `@${c.username}` : '');
    } catch (_) { /* user never messaged the bot */ }
  }
  if (!label) label = key;
  _nameCache.set(key, { label, at: Date.now() });
  return label;
}

/** Test hook — clear the name cache. */
function _resetNameCacheForTests() { _nameCache.clear(); }

/** Best-effort CRM enrichment — returns { phone, address } or {}. */
async function customerContact(customerName) {
  try {
    const crmService = require('./crmService');
    const cust = await crmService.getCustomer(customerName);
    if (cust) return { phone: cust.phone || '', address: cust.address || '' };
  } catch (_) { /* CRM down ≠ no card */ }
  return {};
}

/**
 * Gold-standard sale card (shape of the classic Sell Bale card,
 * telegramController ~6140-6220).
 *
 * @param {object} p
 * @param {string} p.headline       e.g. 'Sale Request (Snap Sale)'
 * @param {string} p.customer
 * @param {string} [p.salesPerson]
 * @param {string} [p.paymentMode]
 * @param {string} [p.salesDate]    raw; canonicalized via fmtDate
 * @param {Array<{packageNo:string,design:string,shade?:string,thans?:number,yards?:number,warehouse?:string}>} p.items
 * @param {boolean} [p.docAttached]
 * @param {string}  [p.docLabel]    default 'Sales bill'
 */
async function buildSaleCard(p) {
  let text = `${p.headline || 'Sale Request'}\nCustomer: ${p.customer}`;
  const contact = await customerContact(p.customer);
  if (contact.phone) text += `\nPhone: ${contact.phone}`;
  if (contact.address) text += `\nAddress: ${contact.address}`;
  if (p.salesPerson) text += `\nSalesperson: ${p.salesPerson}`;
  if (p.paymentMode) text += `\nPayment: ${p.paymentMode}`;
  if (p.salesDate) text += `\nDate: ${fmtDate(p.salesDate)}`;
  text += '\n\nItems:\n';
  let totalYards = 0;
  let totalThans = 0;
  for (const it of p.items || []) {
    const qty = [];
    if (Number(it.thans)) qty.push(`${it.thans} thans`);
    if (Number(it.yards)) qty.push(`${fmtQty(it.yards)} yds`);
    text += `  Bale ${it.packageNo}: ${it.design}${it.shade ? ` ${it.shade}` : ''}${qty.length ? `, ${qty.join(', ')}` : ''}${it.warehouse ? ` (${it.warehouse})` : ''}\n`;
    totalThans += Number(it.thans) || 0;
    totalYards += Number(it.yards) || 0;
  }
  const n = (p.items || []).length;
  text += `\nTotal: ${n} Bale${n === 1 ? '' : 's'} (${totalThans} thans), ${fmtQty(totalYards)} yards`;
  if (p.docAttached) text += `\n📎 ${p.docLabel || 'Sales bill'} attached (see below)`;
  return text;
}

/** Card for a queued snap-sale sell_package actionJSON. */
async function buildSellPackageCard(aj) {
  return buildSaleCard({
    headline: aj.source === 'snap_sale' ? 'Sale Request (Snap Sale)' : 'Sale Request',
    customer: aj.customer,
    salesPerson: aj.salesPerson,
    salesDate: aj.salesDate,
    items: [{ packageNo: aj.packageNo, design: aj.design, shade: aj.shade, thans: aj.thans, yards: aj.yards, warehouse: aj.warehouse }],
    docAttached: !!aj.sale_doc_file_id,
    docLabel: aj.source === 'snap_sale' ? 'Sales bill (label photo)' : 'Sales bill',
  });
}

/**
 * Card for a return (sale reversal) — the approving admins were previously
 * shown ONLY the bale number for one of the riskiest dual-admin actions.
 * Enriched best-effort from Inventory; degrades to the bare line.
 */
async function buildReturnCard({ packageNo, thanNo }) {
  let text = thanNo
    ? `Return Request\nBale ${packageNo} — Than ${thanNo}`
    : `Return Request\nBale ${packageNo} (whole bale)`;
  try {
    const inventoryService = require('./inventoryService');
    const info = await inventoryService.getPackageSummary(packageNo);
    if (info) {
      text += `\nDesign: ${info.design}${info.shade ? ` Shade ${info.shade}` : ''}`;
      if (info.warehouse) text += `\nWarehouse: ${info.warehouse}`;
      text += `\nCurrently available there: ${info.availableThans || 0} thans, ${fmtQty(info.availableYards || 0)} yds`;
    }
  } catch (_) { /* lookup failure must not block the card */ }
  text += '\n⚠️ Reverses a completed sale — verify the goods physically came back.';
  return text;
}

/**
 * Card for a payment approval (dual-admin finance action) — shows the
 * customer's live outstanding balance and the before→after picture so the
 * signing admins have monetary context, not just the amount.
 */
async function buildPaymentCard({ customer, amount, method }) {
  let text = `Record Payment Request\nCustomer: ${customer}\nAmount: ₦${Number(amount || 0).toLocaleString('en-NG')}\nMethod: ${method || '—'}\nDate: ${fmtDate(new Date().toISOString().slice(0, 10))}`;
  try {
    const accountingService = require('./accountingService');
    const { outstandingAsOfToday } = await accountingService.getCustomerLedger(customer);
    const after = Number(outstandingAsOfToday) - Number(amount || 0);
    text += `\nOutstanding today: ₦${Number(outstandingAsOfToday).toLocaleString('en-NG')}`
      + `\nAfter this payment: ₦${after.toLocaleString('en-NG')}`;
    if (after < 0) text += `\n⚠️ Payment EXCEEDS the outstanding balance.`;
  } catch (_) { text += '\n(Outstanding balance unavailable right now.)'; }
  return text;
}

/**
 * Card for removing a bank — previously the thinnest card in the system
 * for a destructive finance action. Adds how much history points at the
 * bank so the approver can judge the blast radius.
 */
async function buildRemoveBankCard({ bankName }) {
  let text = `Remove Bank Request\nBank: ${bankName}`;
  try {
    const receiptsRepository = require('../repositories/receiptsRepository');
    const receipts = (await receiptsRepository.getAll()).filter(
      (r) => String(r.bank_account || '').toLowerCase() === String(bankName).toLowerCase());
    text += `\nReceipts recorded against it: ${receipts.length}`;
    const latest = receipts.map((r) => String(r.created_at || r.uploaded_at || '')).sort().pop();
    if (latest) text += `\nMost recent: ${fmtDate(latest.slice(0, 10))}`;
  } catch (_) { /* context is best-effort */ }
  text += '\n⚠️ Removal only hides it from pickers — recorded history keeps the name.';
  return text;
}

/** Card for a queued classic sale_bundle actionJSON (no inventory lookups —
 *  renders exactly what the queue row carries, so reminders can rebuild it). */
async function buildSaleBundleCard(aj) {
  let text = `Sale Request\nCustomer: ${aj.customer || '—'}`;
  const contact = await customerContact(aj.customer);
  if (contact.phone) text += `\nPhone: ${contact.phone}`;
  if (contact.address) text += `\nAddress: ${contact.address}`;
  if (aj.salesPerson) text += `\nSalesperson: ${aj.salesPerson}`;
  if (aj.paymentMode) text += `\nPayment: ${aj.paymentMode}`;
  if (aj.salesDate) text += `\nDate: ${fmtDate(aj.salesDate)}`;
  const items = Array.isArray(aj.items) ? aj.items : [];
  if (items.length) {
    text += '\n\nItems:\n';
    for (const it of items) {
      text += it.type === 'than'
        ? `  Bale ${it.packageNo} Than ${it.thanNo}\n`
        : `  Bale ${it.packageNo}\n`;
    }
  }
  if (aj.totalYards) text += `\nTotal: ${fmtQty(aj.totalYards)} yards`;
  if (aj.backdated) text += `\n⚠️ BACKDATED sale (${aj.daysBack || '?'} day(s) in the past)`;
  if (aj.sale_doc_file_id) text += '\n📎 Sales bill attached (see below)';
  return text;
}

/**
 * Plain-text supply-request card rebuilt from the queue row — the goods
 * live only in aj.cart, which the generic field list can't render. Without
 * this, a reminder's approve button asked admins to decide a multi-bale
 * request without seeing what is being requested.
 */
function buildSupplyRequestCard(aj) {
  let text = `Supply Request\nCustomer: ${aj.customer || '—'}\nWarehouse: ${aj.warehouse || '—'}`;
  if (aj.salesperson) text += `\nSalesperson: ${aj.salesperson}`;
  if (aj.paymentMode) text += `\nPayment: ${aj.paymentMode}`;
  if (aj.salesDate) text += `\nDate: ${fmtDate(aj.salesDate)}`;
  const cart = Array.isArray(aj.cart) ? aj.cart : [];
  if (cart.length) {
    text += '\n\nItems:';
    let total = 0;
    for (const c of cart.slice(0, 15)) {
      text += `\n  • ${c.design}${c.shade ? ` Shade ${c.shade}` : ''} × ${c.quantity}`;
      total += Number(c.quantity) || 0;
    }
    if (cart.length > 15) text += `\n  …+${cart.length - 15} more lines`;
    text += `\nTotal: ${total} container(s)`;
  }
  if (aj.sale_doc_file_id) text += '\n📎 Bill attached (see below)';
  return text;
}

/**
 * Detail block for bulk/photo receive approvals (dual-admin container
 * uploads) — per-design breakdown + provenance, rendered from actionJSON.
 * Returns '' when there is nothing beyond the caller's headline.
 */
function buildReceiveDetail(aj) {
  const lines = [];
  const bales = Array.isArray(aj.bales) ? aj.bales : [];
  if (bales.length) {
    const byDesign = new Map();
    for (const b of bales) {
      const key = b.design || '?';
      const d = byDesign.get(key) || { pkgs: new Set(), yards: 0 };
      if (b.packageNo) d.pkgs.add(String(b.packageNo));
      d.yards += Number(b.yards) || 0;
      byDesign.set(key, d);
    }
    lines.push('Designs:');
    let i = 0;
    for (const [design, d] of byDesign) {
      if (i++ >= 12) { lines.push(`  …+${byDesign.size - 12} more designs`); break; }
      lines.push(`  • ${design}: ${d.pkgs.size} bale${d.pkgs.size === 1 ? '' : 's'}, ${fmtQty(d.yards)} yds`);
    }
  } else if (aj.stagedCount) {
    lines.push(`⚠️ ${aj.stagedCount} rows staged locally (too large for the queue row) — review the source file before approving.`);
  }
  if (aj.supplier) lines.push(`Supplier: ${aj.supplier}`);
  if (aj.arrivalBatch) lines.push(`Container: ${aj.arrivalBatch}`);
  if (aj.ocrConfidence !== undefined && aj.ocrConfidence !== '') lines.push(`OCR confidence: ${Math.round(Number(aj.ocrConfidence) * 100)}%`);
  if (aj.fileHash) lines.push(`File hash: ${String(aj.fileHash).slice(0, 12)}…`);
  if (aj.sourceUrl || aj.driveLink) lines.push(`Source file: ${aj.sourceUrl || aj.driveLink}`);
  return lines.length ? `\n${lines.join('\n')}` : '';
}

/**
 * Best card we can rebuild for ANY queued actionJSON — used by the
 * reminder sweep (and anywhere else that only has the sheet row). Sale
 * actions get their full card; everything else gets a generic card that
 * surfaces every recognisable business field instead of dropping them.
 */
async function buildCardFromActionJSON(aj) {
  if (!aj || typeof aj !== 'object') return 'pending action';
  try {
    if (aj.action === 'sell_package') return await buildSellPackageCard(aj);
    if (aj.action === 'sale_bundle') return await buildSaleBundleCard(aj);
    if (aj.action === 'supply_request') return buildSupplyRequestCard(aj);
  } catch (_) { /* fall through to generic */ }
  const parts = [String(aj.action || 'action').replace(/_/g, ' ')];
  const fields = [
    ['customer', 'Customer'], ['customer_name', 'Customer'], ['name', 'Name'],
    ['design', 'Design'], ['shade', 'Shade'], ['packageNo', 'Bale'],
    ['warehouse', 'Warehouse'], ['toWarehouse', 'To'], ['arrivalBatch', 'Container'],
    ['price', 'Price'], ['amount', 'Amount'], ['bank_name', 'Bank'],
    ['phone', 'Phone'], ['grnId', 'GRN'], ['supplier', 'Supplier'],
  ];
  const seen = new Set();
  for (const [key, label] of fields) {
    if (aj[key] === undefined || aj[key] === null || aj[key] === '' || seen.has(label)) continue;
    seen.add(label);
    parts.push(`${label}: ${aj[key]}`);
  }
  return parts.join('\n');
}

/**
 * Forward a request's attachments (bill photo, receipt, …) to every admin
 * except excludeId — the same loop the classic sale card runs at
 * telegramController 6205-6216, shared. Best-effort per admin; returns how
 * many sends succeeded so callers can surface total failure.
 *
 * @param {object} bot
 * @param {string} requestId
 * @param {Array<{fileId:string,kind?:'photo'|'document',caption?:string}>} attachments
 * @param {string|undefined} excludeId
 */
async function forwardAttachmentsToAdmins(bot, requestId, attachments, excludeId) {
  let sent = 0;
  for (const att of attachments || []) {
    if (!att || !att.fileId) continue;
    const caption = att.caption || `📷 Sales bill for request ${requestId}`;
    for (const adminId of config.access.adminIds) {
      if (excludeId && String(adminId) === String(excludeId)) continue;
      try {
        if (att.kind === 'document') await bot.sendDocument(adminId, att.fileId, { caption });
        else await bot.sendPhoto(adminId, att.fileId, { caption });
        sent += 1;
      } catch (e) {
        logger.warn(`approvalCards: attachment to admin ${adminId} failed for ${requestId}: ${e.message}`);
      }
    }
  }
  return sent;
}

module.exports = {
  resolveUserLabel,
  _resetNameCacheForTests,
  buildSaleCard,
  buildSellPackageCard,
  buildReturnCard,
  buildSaleBundleCard,
  buildSupplyRequestCard,
  buildPaymentCard,
  buildRemoveBankCard,
  customerContact,
  buildReceiveDetail,
  buildCardFromActionJSON,
  forwardAttachmentsToAdmins,
};
