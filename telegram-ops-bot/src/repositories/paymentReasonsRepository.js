'use strict';

/**
 * paymentReasonsRepository — PAY-2: the reason behind every payment request.
 *
 * One Postgres row per raised payment request: the reason as typed, its
 * chip key (`reasonKey.normaliseReasonKey`), who raised it, for whom, how
 * much and when. Phase 2 (chips) and phase 3 (the reason-code index) are
 * queries over these rows; this file only starts writing them.
 *
 * Storage rule (owner, 09-Sep-2026, spec §1): this trail lives in Postgres,
 * never on a sheet. Writes FAIL OPEN — the ApprovalQueue payload carries the
 * same `reason` and `scripts/backfill-payment-reasons.js` rebuilds this
 * table from it, so a Postgres hiccup may never block a request. Same
 * mould as stockEventsRepository: `isEnabled()` guard, one try/catch,
 * `logger.warn`, neutral return, parameterised SQL.
 */

const pool = require('../db/postgresPool');
const logger = require('../utils/logger');
const { normaliseReasonKey } = require('../utils/reasonKey');

const COLUMNS = 'id, payment_id, approval_request_id, requester_id, requester_name, '
  + 'payee_name, payee_type, amount_ngn, reason_text, reason_key, reason_code_id, raised_at';

function str(v) { return String(v ?? '').trim(); }
function toIso(v) {
  if (v instanceof Date) return v.toISOString();
  return v ? String(v) : null;
}
function shapeRow(r) {
  return {
    ...r,
    id: Number(r.id),
    amount_ngn: Number(r.amount_ngn),
    raised_at: toIso(r.raised_at),
  };
}

/**
 * Record the reason for one payment request. Never throws.
 *
 * @param {{paymentId:string, approvalRequestId?:string, requesterId:string,
 *          requesterName?:string, payeeName?:string, payeeType?:string,
 *          amountNgn:number, reasonText:string, raisedAt?:string}} args
 *   `raisedAt` (ISO) is for the backfill only — live writes take now().
 * @returns {Promise<number|null>} the inserted id, or null (PG off, bad
 *   input, or a PG error)
 */
async function record(args) {
  if (!pool.isEnabled()) return null;
  const a = args || {};
  const paymentId = str(a.paymentId);
  const requesterId = str(a.requesterId);
  const reasonText = str(a.reasonText);
  const amount = Number(a.amountNgn);
  if (!paymentId || !requesterId || !reasonText || !Number.isFinite(amount)) {
    logger.warn(`paymentReasons: record skipped — missing payment/requester/reason/amount (${paymentId || '?'})`);
    return null;
  }
  try {
    const res = await pool.query(
      `INSERT INTO payment_reasons
         (payment_id, approval_request_id, requester_id, requester_name,
          payee_name, payee_type, amount_ngn, reason_text, reason_key, raised_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::timestamptz, now()))
       RETURNING id`,
      [paymentId, str(a.approvalRequestId), requesterId, str(a.requesterName),
        str(a.payeeName), str(a.payeeType), amount, reasonText,
        normaliseReasonKey(reasonText), toIso(a.raisedAt)],
    );
    const row = res && res.rows && res.rows[0];
    return row && row.id != null ? Number(row.id) : null;
  } catch (e) {
    // Fail open: the queue row already carries the reason; the backfill
    // script is the safety net.
    logger.warn(`paymentReasons: record failed (${paymentId}): ${e.message}`);
    return null;
  }
}

/**
 * The reason row for one payment (the latest, should a backfill and a live
 * write ever both land).
 * @param {string} paymentId
 * @returns {Promise<object|null>}
 */
async function forPayment(paymentId) {
  if (!pool.isEnabled()) return null;
  try {
    const res = await pool.query(
      `SELECT ${COLUMNS} FROM payment_reasons
        WHERE payment_id = $1
        ORDER BY raised_at DESC, id DESC
        LIMIT 1`,
      [str(paymentId)],
    );
    const row = res && res.rows && res.rows[0];
    return row ? shapeRow(row) : null;
  } catch (e) {
    logger.warn(`paymentReasons: forPayment failed (${paymentId}): ${e.message}`);
    return null;
  }
}

/**
 * Phase-2 chip fodder: the requester's REPEATING reasons (uses >= 2), most
 * used first, then most recent. `reason_text` is the most recent spelling.
 * @param {string} requesterId
 * @param {number} [limit=4]
 * @returns {Promise<Array<{reason_text:string, reason_key:string, uses:number, last_at:string}>>}
 */
async function topForRequester(requesterId, limit = 4) {
  if (!pool.isEnabled()) return [];
  const n = Math.max(1, Math.min(50, Number(limit) || 4));
  try {
    const res = await pool.query(
      `SELECT reason_key,
              COUNT(*)::int AS uses,
              MAX(raised_at) AS last_at,
              (ARRAY_AGG(reason_text ORDER BY raised_at DESC, id DESC))[1] AS reason_text
         FROM payment_reasons
        WHERE requester_id = $1 AND reason_key <> ''
        GROUP BY reason_key
       HAVING COUNT(*) >= 2
        ORDER BY uses DESC, last_at DESC
        LIMIT $2`,
      [str(requesterId), n],
    );
    return (res && res.rows ? res.rows : []).map((r) => ({
      reason_text: String(r.reason_text || ''),
      reason_key: String(r.reason_key || ''),
      uses: Number(r.uses) || 0,
      last_at: toIso(r.last_at),
    }));
  } catch (e) {
    logger.warn(`paymentReasons: topForRequester failed (${requesterId}): ${e.message}`);
    return [];
  }
}

/**
 * Every reason raised in [fromIso, toIso) — half-open, so day boundaries
 * chain without overlap. Phase-3 analysis / export fodder.
 * @param {string} fromIso inclusive
 * @param {string} toIso exclusive
 * @returns {Promise<object[]>}
 */
async function listByRange(fromIso, toIso) {
  if (!pool.isEnabled()) return [];
  try {
    const res = await pool.query(
      `SELECT ${COLUMNS} FROM payment_reasons
        WHERE raised_at >= $1::timestamptz AND raised_at < $2::timestamptz
        ORDER BY raised_at ASC, id ASC`,
      [str(fromIso), str(toIso)],
    );
    return (res && res.rows ? res.rows : []).map(shapeRow);
  } catch (e) {
    logger.warn(`paymentReasons: listByRange failed: ${e.message}`);
    return [];
  }
}

/**
 * The set of payment_ids that already have a reason row — one round trip
 * for the backfill script instead of one `forPayment` per queue row.
 * @returns {Promise<Set<string>>} empty when PG is off or errored
 */
async function existingPaymentIds() {
  if (!pool.isEnabled()) return new Set();
  try {
    const res = await pool.query('SELECT DISTINCT payment_id FROM payment_reasons', []);
    return new Set((res && res.rows ? res.rows : []).map((r) => String(r.payment_id)));
  } catch (e) {
    logger.warn(`paymentReasons: existingPaymentIds failed: ${e.message}`);
    return new Set();
  }
}

module.exports = { record, forPayment, topForRequester, listByRange, existingPaymentIds };
