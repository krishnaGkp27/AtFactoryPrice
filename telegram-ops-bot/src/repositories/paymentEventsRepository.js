'use strict';

/**
 * paymentEventsRepository — PAY-2: the payment lifecycle trail.
 *
 * One append-only Postgres row per thing that happened to a payment
 * request: raised, signed (one admin), approved (the pair), the finance
 * card sent (with the chat + message id, so Mark Done / Decline can wipe
 * its buttons on every copy), reminders, done, declined, rejected, and who
 * was notified. `financeCardsFor` and `lastKindAt` are the two reads the
 * lifecycle needs; `forPayment` is the audit view.
 *
 * Storage rule (owner, 09-Sep-2026, spec §1): logging lives in Postgres,
 * never on a sheet. Writes FAIL OPEN — the PaymentRequests row is the
 * record of state; this is the trail. Same mould as
 * stockEventsRepository: `isEnabled()` guard, one try/catch, `logger.warn`,
 * neutral return, parameterised SQL.
 */

const pool = require('../db/postgresPool');
const logger = require('../utils/logger');

/** The CHECK list on payment_events.kind (migration 002) — keep in step. */
const KINDS = Object.freeze([
  'raised', 'signed', 'approved', 'finance_card_sent', 'reminder_sent',
  'done', 'declined', 'rejected', 'notified',
]);

const COLUMNS = 'id, at, payment_id, approval_request_id, kind, actor_id, actor_name, '
  + 'chat_id, message_id, detail';

function str(v) { return String(v ?? '').trim(); }
function toIso(v) {
  if (v instanceof Date) return v.toISOString();
  return v ? String(v) : null;
}
function shapeRow(r) {
  let detail = r.detail;
  if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch (_) { detail = {}; } }
  return { ...r, id: Number(r.id), at: toIso(r.at), detail: detail && typeof detail === 'object' ? detail : {} };
}

/**
 * Append one lifecycle event. Never throws.
 *
 * @param {{paymentId:string, approvalRequestId?:string, kind:string,
 *          actorId?:string, actorName?:string, chatId?:string|number,
 *          messageId?:string|number, detail?:object}} args
 * @returns {Promise<number|null>} inserted id, or null (PG off, invalid
 *   kind / missing payment id, or a PG error)
 */
async function record(args) {
  if (!pool.isEnabled()) return null;
  const a = args || {};
  const paymentId = str(a.paymentId);
  const kind = str(a.kind);
  if (!KINDS.includes(kind)) {
    logger.warn(`paymentEvents: record skipped — unknown kind "${kind}" (${paymentId || '?'})`);
    return null;
  }
  if (!paymentId) {
    logger.warn(`paymentEvents: record skipped — no payment id (${kind})`);
    return null;
  }
  const detail = a.detail && typeof a.detail === 'object' ? a.detail : {};
  try {
    const res = await pool.query(
      `INSERT INTO payment_events
         (payment_id, approval_request_id, kind, actor_id, actor_name,
          chat_id, message_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING id`,
      [paymentId, str(a.approvalRequestId), kind, str(a.actorId), str(a.actorName),
        str(a.chatId), str(a.messageId), JSON.stringify(detail)],
    );
    const row = res && res.rows && res.rows[0];
    return row && row.id != null ? Number(row.id) : null;
  } catch (e) {
    // Fail open: the PaymentRequests row already holds the state change.
    logger.warn(`paymentEvents: record failed (${kind} ${paymentId}): ${e.message}`);
    return null;
  }
}

/**
 * The whole trail for one payment, oldest first.
 * @param {string} paymentId
 * @returns {Promise<object[]>}
 */
async function forPayment(paymentId) {
  if (!pool.isEnabled()) return [];
  try {
    const res = await pool.query(
      `SELECT ${COLUMNS} FROM payment_events
        WHERE payment_id = $1
        ORDER BY at ASC, id ASC`,
      [str(paymentId)],
    );
    return (res && res.rows ? res.rows : []).map(shapeRow);
  } catch (e) {
    logger.warn(`paymentEvents: forPayment failed (${paymentId}): ${e.message}`);
    return [];
  }
}

/**
 * Every finance-card copy (first send + reminders) that still has a chat
 * and message id — the messages whose buttons Mark Done / Decline wipes.
 * De-duplicated on chat+message.
 * @param {string} paymentId
 * @returns {Promise<Array<{chat_id:string, message_id:string}>>}
 */
async function financeCardsFor(paymentId) {
  if (!pool.isEnabled()) return [];
  try {
    const res = await pool.query(
      `SELECT chat_id, message_id FROM payment_events
        WHERE payment_id = $1
          AND kind IN ('finance_card_sent', 'reminder_sent')
          AND chat_id <> '' AND message_id <> ''
        ORDER BY at ASC, id ASC`,
      [str(paymentId)],
    );
    const seen = new Set();
    const out = [];
    for (const r of (res && res.rows ? res.rows : [])) {
      const key = `${r.chat_id}|${r.message_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ chat_id: String(r.chat_id), message_id: String(r.message_id) });
    }
    return out;
  } catch (e) {
    logger.warn(`paymentEvents: financeCardsFor failed (${paymentId}): ${e.message}`);
    return [];
  }
}

/**
 * When the latest event of `kind` happened for this payment — the reminder
 * sweep asks "when was the finance card last sent?".
 * @param {string} paymentId
 * @param {string} kind one of KINDS
 * @returns {Promise<string|null>} ISO instant, or null (none / PG off / bad kind)
 */
async function lastKindAt(paymentId, kind) {
  if (!pool.isEnabled()) return null;
  const k = str(kind);
  if (!KINDS.includes(k)) {
    logger.warn(`paymentEvents: lastKindAt skipped — unknown kind "${k}"`);
    return null;
  }
  try {
    const res = await pool.query(
      `SELECT MAX(at) AS at FROM payment_events
        WHERE payment_id = $1 AND kind = $2`,
      [str(paymentId), k],
    );
    const row = res && res.rows && res.rows[0];
    return row && row.at ? toIso(row.at) : null;
  } catch (e) {
    logger.warn(`paymentEvents: lastKindAt failed (${kind} ${paymentId}): ${e.message}`);
    return null;
  }
}

module.exports = { KINDS, record, forPayment, financeCardsFor, lastKindAt };
