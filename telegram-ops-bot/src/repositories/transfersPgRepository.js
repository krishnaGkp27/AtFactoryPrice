'use strict';
/**
 * TRF-20 (6/8) — the `transfers` table on Railway Postgres: the pilot of
 * the move off the spreadsheet (owner, 20-Sep-2026: "migrate this onto
 * PostgreSQL … maintaining it on a spreadsheet is not providing the tabular
 * features").
 *
 * SHADOW posture, exactly as stock_events (specs/STK-PG_PHASE1.md): the
 * ApprovalQueue sheet remains the source of truth; every transfer state
 * write is MIRRORED here best-effort and FAILS OPEN — a Postgres hiccup may
 * never block a dispatch. The read flip (Settings TRANSFERS_READ_FROM_PG)
 * comes only after the parity script has agreed for days and the backup
 * job has shipped (spec §3-G).
 *
 * What the table says that the sheet cannot:
 *   - `ref` is UNIQUE and `idem_key` is UNIQUE — a repeated reference or a
 *     retried send is refused by the database, not by a mutex.
 *   - ONE open row per load: a partial unique index on (from, to,
 *     lines_hash) WHERE status = 'pending' AND duplicate_of IS NULL. While
 *     the sheet still holds ghosts the mirror of a twin fails loudly in the
 *     log — which is the parity script's first finding, by design.
 *   - `status` says what happened (pending · received · declined ·
 *     reverted) and `stage` says where it sits; the sheet overloaded
 *     'approved' to mean received and 'rejected' to mean declined OR
 *     reverted.
 */
const pool = require('../db/postgresPool');
const logger = require('../utils/logger');
const transferGhosts = require('../services/transferGhosts');

const str = (v) => String(v ?? '').trim();

/** Sheet status + stage → table status. */
function statusOf(row) {
  const st = str(row && row.status).toLowerCase();
  const stage = str(row && row.actionJSON && row.actionJSON.stage).toLowerCase();
  if (st === 'approved') return 'received';
  if (st === 'rejected') return stage === 'in_transit' ? 'reverted' : 'declined';
  return 'pending';
}

/** The table row for one ApprovalQueue transfer row. Pure. */
function shape(row) {
  const aj = (row && row.actionJSON) || {};
  const stage = ['requested', 'admin_review', 'in_transit'].includes(str(aj.stage)) ? str(aj.stage) : 'requested';
  const status = statusOf(row);
  return {
    ref: str(row.requestId),
    idem_key: str(aj.idemKey) || null,
    from_wh: str(aj.from), to_wh: str(aj.to),
    lines: aj.lines || [],
    lines_hash: transferGhosts.linesKey(aj.lines),
    stage, status,
    requested_by: str(row.user), dispatcher: str(aj.dispatcher), receiver: str(aj.receiver),
    duplicate_of: str(aj.duplicateOf) || null,
    created_at: str(row.createdAt) || null,
    decided_at: status === 'pending' ? null : (str(row.resolvedAt) || null),
    decided_by: status === 'pending' ? null : (str(row.approver) || null),
    action_json: aj,
  };
}

/**
 * Mirror one queue row (insert or update by ref). Never throws.
 * @returns {Promise<boolean>} true when the write landed
 */
async function upsert(row) {
  if (!pool.isEnabled()) return false;
  try {
    const t = shape(row);
    if (!t.ref) return false;
    await pool.query(
      `INSERT INTO transfers
         (ref, idem_key, from_wh, to_wh, lines, lines_hash, stage, status,
          requested_by, dispatcher, receiver, duplicate_of, created_at,
          decided_at, decided_by, action_json)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,
               COALESCE($13::timestamptz, now()),$14,$15,$16::jsonb)
       ON CONFLICT (ref) DO UPDATE SET
         stage = EXCLUDED.stage, status = EXCLUDED.status,
         dispatcher = EXCLUDED.dispatcher, receiver = EXCLUDED.receiver,
         lines = EXCLUDED.lines, lines_hash = EXCLUDED.lines_hash,
         duplicate_of = EXCLUDED.duplicate_of,
         decided_at = EXCLUDED.decided_at, decided_by = EXCLUDED.decided_by,
         action_json = EXCLUDED.action_json, updated_at = now()`,
      [t.ref, t.idem_key, t.from_wh, t.to_wh, JSON.stringify(t.lines), t.lines_hash, t.stage, t.status,
        t.requested_by, t.dispatcher, t.receiver, t.duplicate_of, t.created_at,
        t.decided_at, t.decided_by, JSON.stringify(t.action_json)],
    );
    return true;
  } catch (e) {
    logger.warn(`transfersPg: mirror of ${str(row && row.requestId)} failed: ${e.message}`);
    return false;
  }
}

/** One lifecycle event for the trail. Never throws. */
async function event(ref, kind, actor, detail = {}) {
  if (!pool.isEnabled()) return false;
  try {
    await pool.query(
      'INSERT INTO transfer_events (ref, event, actor, detail) VALUES ($1,$2,$3,$4::jsonb)',
      [str(ref), str(kind), str(actor), JSON.stringify(detail || {})],
    );
    return true;
  } catch (e) {
    logger.warn(`transfersPg: event ${kind} for ${ref} failed: ${e.message}`);
    return false;
  }
}

/** Every row, for the parity script. Throws on a real error (the script reports it). */
async function all() {
  if (!pool.isEnabled()) return [];
  const res = await pool.query('SELECT ref, stage, status, from_wh, to_wh, lines_hash, duplicate_of, created_at FROM transfers ORDER BY created_at');
  return (res && res.rows) || [];
}

module.exports = { upsert, event, all, _internals: { shape, statusOf } };
