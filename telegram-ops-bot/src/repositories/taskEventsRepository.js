/**
 * Append-only audit log for every task state transition.
 *
 * One row per transition. Combined with the timestamp columns in the
 * Tasks sheet this is the single source of truth for downstream
 * performance analysis (planned vs actual duration, negotiation
 * latency, approval lag, Gantt timelines, etc.).
 *
 * Schema (8 columns, A..H):
 *   A  event_id          unique id
 *   B  task_id
 *   C  event_type        free-form short tag (e.g. 'assigned',
 *                        'doer_proposed_timeline', 'assigner_set_incentive',
 *                        'doer_final_ack', 'submitted', 'approved',
 *                        'rejected_back', 'cancelled', 'declined')
 *   D  from_status
 *   E  to_status
 *   F  actor_user_id
 *   G  at                ISO timestamp
 *   H  meta_json         JSON-encoded extra payload (hours, deadline,
 *                        incentive_amount, reject_reason, etc.)
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const SHEET = 'TaskEvents';
const READ_RANGE = 'A2:H';
const NUM_COLS = 8;

function str(v) { return (v ?? '').toString().trim(); }

function parse(r, rowIndex) {
  let meta = null;
  const raw = str(r[7]);
  if (raw) {
    try { meta = JSON.parse(raw); } catch (_) { meta = { _raw: raw }; }
  }
  return {
    rowIndex,
    event_id: str(r[0]),
    task_id: str(r[1]),
    event_type: str(r[2]),
    from_status: str(r[3]),
    to_status: str(r[4]),
    actor_user_id: str(r[5]),
    at: str(r[6]),
    meta,
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, READ_RANGE);
  return rows.map((r, i) => parse(r, i + 2)).filter((x) => x.event_id);
}

async function getByTaskId(taskId) {
  if (!taskId) return [];
  const all = await getAll();
  return all.filter((x) => x.task_id === taskId)
    .sort((a, b) => (a.at || '').localeCompare(b.at || ''));
}

async function append({ task_id, event_type, from_status, to_status, actor_user_id, at, meta }) {
  if (!task_id || !event_type) {
    throw new Error('taskEventsRepository.append: task_id and event_type required');
  }
  const event_id = idGenerator.generate('TEV');
  const when = at || new Date().toISOString();
  let metaStr = '';
  if (meta && typeof meta === 'object') {
    try { metaStr = JSON.stringify(meta); } catch (_) { metaStr = ''; }
  }
  const row = new Array(NUM_COLS).fill('');
  row[0] = event_id;
  row[1] = String(task_id);
  row[2] = String(event_type);
  row[3] = from_status || '';
  row[4] = to_status || '';
  row[5] = actor_user_id ? String(actor_user_id) : '';
  row[6] = when;
  row[7] = metaStr;
  await sheets.appendRows(SHEET, [row]);
  return { event_id, task_id, event_type, from_status, to_status, actor_user_id, at: when, meta };
}

module.exports = {
  SHEET,
  getAll,
  getByTaskId,
  append,
  _parse: parse,
};
