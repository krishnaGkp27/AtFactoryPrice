/**
 * Data access for `PendingUsers` sheet (USR-C2).
 *
 * Captures unknown Telegram users who send `/start` so admins can
 * onboard them in-bot instead of asking for their numeric ID by hand.
 *
 * IDR-1 (owner, 14-Aug-2026) — this sheet is now also the **Telegram
 * identity register**: the ONE place that answers "who, in the business,
 * is this Telegram account?"
 *
 * The owner's ruling was one sheet, and expansion by columns only — "only
 * thing expandable should be attribute of the column or new column in case
 * of a new attribute set, like in tabular form". So the link is five plain
 * end-columns (no JSON blob, one attribute each), and Customers, Contacts
 * and Marketers are left completely alone: a person's Telegram id is not
 * an attribute of those records, it is an attribute of the account.
 *
 * Every row already lands here automatically the first time an unknown
 * account messages the bot, so the register needs no new capture path —
 * only somewhere to record what the admin decided the person IS.
 *
 * Columns:
 *   A: telegram_id            (string)
 *   B: username               (string, may be empty)
 *   C: first_name             (string)
 *   D: last_name              (string)
 *   E: arrived_at             (ISO timestamp)
 *   F: status                 ('pending' | 'onboarded' | 'linked' | 'ignored')
 *   G: last_notified_msg_id   (telegram message id of the admin-feed card, for edits)
 *   H: handled_by             (admin user id who clicked Onboard/Ignore)
 *   I: handled_at             (ISO timestamp)
 *   --- IDR-1 ---
 *   J: link_type              ('employee' | 'customer' | 'contact' | '')
 *   K: link_id                (the id in that domain: user id / customer_id / contact_id)
 *   L: link_name              (the human name at link time — the row reads without a lookup)
 *   M: linked_by              (admin who bound it)
 *   N: linked_at              (Lagos wall-clock, 'YYYY-MM-DD HH:MM')
 */

'use strict';

const sheets = require('./sheetsClient');

const SHEET = 'PendingUsers';
const HEADERS = [
  'telegram_id', 'username', 'first_name', 'last_name',
  'arrived_at', 'status', 'last_notified_msg_id',
  'handled_by', 'handled_at',
  // IDR-1 — what this Telegram account IS in the business.
  'link_type', 'link_id', 'link_name', 'linked_by', 'linked_at',
];

/** IDR-1 — the domains a Telegram account can be bound to. */
// MYP-1 (owner, 23-Aug-2026): a marketer is NOT company — they link like
// a customer. Only a marketer may take commission (BUSINESS_RULES §16).
const LINK_TYPES = ['employee', 'customer', 'contact', 'marketer'];

function str(v) { return (v ?? '').toString().trim(); }

function parse(r, rowIndex) {
  const linkType = str(r[9]).toLowerCase();
  return {
    rowIndex,
    telegram_id: str(r[0]),
    username: str(r[1]),
    first_name: str(r[2]),
    last_name: str(r[3]),
    arrived_at: str(r[4]),
    status: str(r[5]) || 'pending',
    last_notified_msg_id: str(r[6]),
    handled_by: str(r[7]),
    handled_at: str(r[8]),
    // An unrecognised link_type degrades to '' (unlinked) rather than
    // inventing a fourth domain no reader handles.
    link_type: LINK_TYPES.includes(linkType) ? linkType : '',
    link_id: str(r[10]),
    link_name: str(r[11]),
    linked_by: str(r[12]),
    linked_at: str(r[13]),
  };
}

let _headerReady = false;

async function ensureHeader() {
  // Bootstrapping the header only matters once per process — schemaMapper
  // already creates every sheet + header at startup. Without this guard each
  // append/write paid an extra read (and, where ensureHeader also calls
  // getSheetNames, a whole-spreadsheet metadata call) first.
  if (_headerReady) return;
  const rows = await sheets.readRange(SHEET, 'A1:N1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await sheets.updateRange(SHEET, 'A1:N1', [HEADERS]);
  }
  _headerReady = true;
}

async function getAll() {
  try {
    const rows = await sheets.readRange(SHEET, 'A2:N');
    return rows.map((r, i) => parse(r, i + 2)).filter((u) => u.telegram_id);
  } catch (_) {
    return [];
  }
}

async function findByTelegramId(telegramId) {
  const all = await getAll();
  return all.find((u) => u.telegram_id === String(telegramId)) || null;
}

async function append(entry) {
  await ensureHeader();
  await sheets.appendRows(SHEET, [[
    String(entry.telegram_id),
    str(entry.username),
    str(entry.first_name),
    str(entry.last_name),
    entry.arrived_at || new Date().toISOString(),
    entry.status || 'pending',
    str(entry.last_notified_msg_id),
    str(entry.handled_by),
    str(entry.handled_at),
    // IDR-1 — a fresh arrival is unlinked; the admin decides what it is.
    str(entry.link_type),
    str(entry.link_id),
    str(entry.link_name),
    str(entry.linked_by),
    str(entry.linked_at),
  ]]);
}

/**
 * IDR-1 — bind a Telegram account to who they are in the business.
 *
 * Writes ONLY the link columns (J–N) plus status, so nothing about the
 * arrival record is disturbed: the person's original name, username and
 * arrival time stay exactly as captured.
 *
 * @param {string} telegramId
 * @param {{type: string, id?: string, name?: string}} link
 * @param {string} by admin user id
 * @returns {Promise<boolean>} false when there is no row for that account
 */
async function setLink(telegramId, link, by) {
  const u = await findByTelegramId(telegramId);
  if (!u) return false;
  const type = String((link && link.type) || '').toLowerCase();
  if (!LINK_TYPES.includes(type)) return false;
  const fmtDate = require('../utils/formatDate');
  // Employees remain 'onboarded' (they are in the Users sheet and can use
  // the bot); a customer or contact is 'linked' — known, but not staff.
  const status = type === 'employee' ? 'onboarded' : 'linked';
  await sheets.updateRange(SHEET, `F${u.rowIndex}`, [[status]]);
  await sheets.updateRange(SHEET, `J${u.rowIndex}:N${u.rowIndex}`, [[
    type,
    str(link.id),
    str(link.name),
    str(by),
    fmtDate.withTime(new Date().toISOString()),
  ]]);
  return true;
}

async function updateStatus(telegramId, status, handledBy) {
  const u = await findByTelegramId(telegramId);
  if (!u) return false;
  await sheets.updateRange(SHEET, `F${u.rowIndex}:I${u.rowIndex}`, [[
    status,
    u.last_notified_msg_id,
    str(handledBy),
    new Date().toISOString(),
  ]]);
  return true;
}

async function updateLastNotifiedMsgId(telegramId, msgId) {
  const u = await findByTelegramId(telegramId);
  if (!u) return false;
  await sheets.updateRange(SHEET, `G${u.rowIndex}`, [[String(msgId)]]);
  return true;
}

module.exports = {
  getAll,
  findByTelegramId,
  append,
  updateStatus,
  updateLastNotifiedMsgId,
  setLink,
  SHEET,
  HEADERS,
  LINK_TYPES,
};
