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

/** Resolve a Telegram user id to the display name used on approval cards. */
async function resolveUserLabel(userId) {
  try {
    const u = await usersRepository.findByUserId(String(userId));
    if (u && u.name) return u.name;
  } catch (_) { /* fall through */ }
  return String(userId);
}

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
  buildSaleCard,
  buildSellPackageCard,
  buildSaleBundleCard,
  buildCardFromActionJSON,
  forwardAttachmentsToAdmins,
};
