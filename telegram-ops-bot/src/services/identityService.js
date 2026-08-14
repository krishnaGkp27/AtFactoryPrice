'use strict';

/**
 * IDR-1 — the Telegram identity register (owner ruling, 14-Aug-2026).
 *
 * One question, one door: **who, in the business, is this Telegram
 * account?** Before this, the answer existed nowhere. A stranger who
 * messaged the bot could only be onboarded as an EMPLOYEE; if they were
 * a customer or someone in the contact network, the admin's only options
 * were Ignore them and add them separately — and their Telegram identity
 * was lost in the process. Nothing downstream (invoice delivery, catalogue
 * shares, notifications) could ever find a customer's chat.
 *
 * The owner's ruling shaped this: identity lives in **one sheet**, and the
 * sheet grows by **columns, not blobs** — "only thing expandable should be
 * attribute of the column or new column in case of a new attribute set,
 * like in tabular form". PendingUsers already holds a row for every
 * account that has ever messaged the bot, so it became the register; the
 * five link columns say what each account IS. Customers, Contacts and
 * Marketers are untouched — a Telegram id is an attribute of the ACCOUNT,
 * not of a customer record, and putting it on three sheets would be three
 * places to drift.
 *
 * Everything that later needs "which chat belongs to customer X?" asks
 * HERE. Nothing else reads or writes those columns.
 */

const pendingUsersRepo = require('../repositories/pendingUsersRepository');
const logger = require('../utils/logger');

const TYPE_EMPLOYEE = 'employee';
const TYPE_CUSTOMER = 'customer';
const TYPE_CONTACT = 'contact';

const norm = (v) => String(v ?? '').trim();

/**
 * Bind an account to a business identity.
 *
 * @param {string} telegramId
 * @param {{type:'employee'|'customer'|'contact', id?:string, name?:string}} link
 * @param {string} by admin user id making the decision
 * @returns {Promise<{ok:boolean, reason?:string}>} never throws
 */
async function link(telegramId, linkSpec, by) {
  const id = norm(telegramId);
  if (!id) return { ok: false, reason: 'no telegram id' };
  if (!linkSpec || !pendingUsersRepo.LINK_TYPES.includes(String(linkSpec.type || '').toLowerCase())) {
    return { ok: false, reason: 'unknown link type' };
  }
  try {
    const done = await pendingUsersRepo.setLink(id, linkSpec, by);
    if (!done) return { ok: false, reason: 'no register row for that account' };
    return { ok: true };
  } catch (e) {
    logger.warn(`identityService.link(${id}): ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

/**
 * What is this Telegram account? `null` when the account has never
 * messaged the bot; an unlinked row reports `link_type: ''`.
 *
 * @returns {Promise<null|{telegram_id, link_type, link_id, link_name, status, name}>}
 */
async function whoIs(telegramId) {
  const id = norm(telegramId);
  if (!id) return null;
  let row;
  try { row = await pendingUsersRepo.findByTelegramId(id); } catch (e) {
    logger.warn(`identityService.whoIs(${id}): ${e.message}`);
    return null;
  }
  if (!row) return null;
  return {
    telegram_id: row.telegram_id,
    name: row.link_name || [row.first_name, row.last_name].filter(Boolean).join(' ') || row.username,
    status: row.status,
    link_type: row.link_type,
    link_id: row.link_id,
    link_name: row.link_name,
  };
}

/**
 * The Telegram account bound to a business record — the reverse lookup,
 * and the reason the register exists at all: it is what lets a future
 * invoice or catalogue reach a CUSTOMER on Telegram.
 *
 * Matches on link_id first (the solid key). Falls back to link_name ONLY
 * when no id was recorded, and only on an exact case-insensitive match —
 * a near-miss returns nothing rather than guessing a wrong person's chat.
 *
 * @param {'employee'|'customer'|'contact'} type
 * @param {{id?:string, name?:string}} ref
 * @returns {Promise<string>} telegram id, or '' when nothing is bound
 */
async function telegramIdFor(type, ref = {}) {
  const t = String(type || '').toLowerCase();
  const id = norm(ref.id);
  const name = norm(ref.name).toLowerCase();
  if (!t || (!id && !name)) return '';
  let rows;
  try { rows = await pendingUsersRepo.getAll(); } catch (e) {
    logger.warn(`identityService.telegramIdFor: ${e.message}`);
    return '';
  }
  const mine = rows.filter((r) => r.link_type === t);
  if (id) {
    const hit = mine.find((r) => r.link_id && r.link_id === id);
    if (hit) return hit.telegram_id;
    // An id was given and did not match: do NOT fall back to the name.
    // Two customers can share a display name; only the id is identity.
    return '';
  }
  const byName = mine.filter((r) => r.link_name && r.link_name.toLowerCase() === name);
  // Ambiguous is the same as unknown — never pick one of two chats.
  return byName.length === 1 ? byName[0].telegram_id : '';
}

/** Every account bound to a given domain, for admin views. */
async function listLinked(type) {
  const t = String(type || '').toLowerCase();
  try {
    const rows = await pendingUsersRepo.getAll();
    return rows.filter((r) => (t ? r.link_type === t : !!r.link_type));
  } catch (e) {
    logger.warn(`identityService.listLinked: ${e.message}`);
    return [];
  }
}

module.exports = {
  link,
  whoIs,
  telegramIdFor,
  listLinked,
  TYPE_EMPLOYEE,
  TYPE_CUSTOMER,
  TYPE_CONTACT,
};
