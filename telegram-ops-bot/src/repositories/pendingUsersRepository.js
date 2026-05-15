/**
 * Data access for `PendingUsers` sheet (USR-C2).
 *
 * Captures unknown Telegram users who send `/start` so admins can
 * onboard them in-bot instead of asking for their numeric ID by hand.
 *
 * Columns:
 *   A: telegram_id            (string)
 *   B: username               (string, may be empty)
 *   C: first_name             (string)
 *   D: last_name              (string)
 *   E: arrived_at             (ISO timestamp)
 *   F: status                 ('pending' | 'onboarded' | 'ignored')
 *   G: last_notified_msg_id   (telegram message id of the admin-feed card, for edits)
 *   H: handled_by             (admin user id who clicked Onboard/Ignore)
 *   I: handled_at             (ISO timestamp)
 */

'use strict';

const sheets = require('./sheetsClient');

const SHEET = 'PendingUsers';
const HEADERS = [
  'telegram_id', 'username', 'first_name', 'last_name',
  'arrived_at', 'status', 'last_notified_msg_id',
  'handled_by', 'handled_at',
];

function str(v) { return (v ?? '').toString().trim(); }

function parse(r, rowIndex) {
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
  };
}

async function ensureHeader() {
  const rows = await sheets.readRange(SHEET, 'A1:I1');
  if (!rows.length || rows[0].length < HEADERS.length) {
    await sheets.updateRange(SHEET, 'A1:I1', [HEADERS]);
  }
}

async function getAll() {
  try {
    const rows = await sheets.readRange(SHEET, 'A2:I');
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
  ]]);
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
  SHEET,
  HEADERS,
};
