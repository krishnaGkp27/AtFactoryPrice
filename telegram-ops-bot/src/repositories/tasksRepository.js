/**
 * Data access for the Tasks sheet.
 *
 * Schema (20 columns, A..T) — extended for TG-7.5 Phase C (negotiated
 * timelines + incentive tracks + full timestamp coverage). Legacy 9-col
 * rows are still parsed correctly (new columns default to '' or 0).
 *
 *   A  task_id
 *   B  title
 *   C  description
 *   D  assigned_to
 *   E  assigned_by
 *   F  status                  (see STATUSES below)
 *   G  created_at              (assignment creation; legacy alias)
 *   H  submitted_at            (doer tapped Mark Done)
 *   I  completed_at            (assigner approved)
 *   J  track                   (incentivized | salaried)
 *   K  priority                (critical | high | normal | low)
 *   L  assigned_at             (mirror of created_at, kept explicit)
 *   M  accepted_at             (doer first opened the card)
 *   N  proposed_hours          (doer's estimated effort)
 *   O  proposed_deadline       (ISO date)
 *   P  negotiation_rounds      (int; capped at 3)
 *   Q  timeline_agreed_at      (assigner accepted timeline)
 *   R  started_at              (final ack → clock starts)
 *   S  approved_at             (alias of completed_at for now)
 *   T  last_event_at           (any state change)
 *
 * STATUSES:
 *   assigned                — assigner created; awaiting doer
 *   awaiting_timeline_ack   — doer proposed; awaiting assigner accept/counter
 *   awaiting_incentive      — assigner accepted timeline; needs to set incentive
 *                              (incentivized track only)
 *   awaiting_final_ack      — incentive set; doer must accept the deal
 *                              (incentivized track) OR doer must final-ack
 *                              the agreed timeline (salaried track)
 *   active                  — clock running
 *   submitted               — doer marked done; assigner sign-off pending
 *   completed               — assigner approved
 *   declined                — doer rejected up front
 *   cancelled               — assigner cancelled
 *
 * Legacy 'pending' / 'in_progress' rows are auto-mapped to 'assigned' /
 * 'active' on read so existing data keeps working.
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const SHEET = 'Tasks';
const READ_RANGE = 'A2:T';
const NUM_COLS = 20;

const STATUSES = Object.freeze({
  ASSIGNED: 'assigned',
  AWAITING_TIMELINE_ACK: 'awaiting_timeline_ack',
  AWAITING_INCENTIVE: 'awaiting_incentive',
  AWAITING_FINAL_ACK: 'awaiting_final_ack',
  ACTIVE: 'active',
  SUBMITTED: 'submitted',
  COMPLETED: 'completed',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
});

const VALID_STATUSES = new Set(Object.values(STATUSES));
const LEGACY_STATUS_MAP = { pending: STATUSES.ASSIGNED, in_progress: STATUSES.ACTIVE };
const VALID_TRACKS = new Set(['incentivized', 'salaried']);

function str(v) { return (v ?? '').toString().trim(); }
function intOr(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function floatOr(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

function parse(r, rowIndex) {
  const rawStatus = str(r[5]) || STATUSES.ASSIGNED;
  const status = LEGACY_STATUS_MAP[rawStatus] || rawStatus;
  const createdAt = str(r[6]);
  return {
    rowIndex,
    task_id: str(r[0]),
    title: str(r[1]),
    description: str(r[2]),
    assigned_to: str(r[3]),
    assigned_by: str(r[4]),
    status,
    created_at: createdAt,
    submitted_at: str(r[7]),
    completed_at: str(r[8]),
    track: str(r[9]) || 'salaried',
    priority: str(r[10]) || 'normal',
    assigned_at: str(r[11]) || createdAt,
    accepted_at: str(r[12]),
    proposed_hours: floatOr(r[13], null),
    proposed_deadline: str(r[14]),
    negotiation_rounds: intOr(r[15], 0),
    timeline_agreed_at: str(r[16]),
    started_at: str(r[17]),
    approved_at: str(r[18]) || str(r[8]),
    last_event_at: str(r[19]) || createdAt,
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, READ_RANGE);
  return rows.map((r, i) => parse(r, i + 2)).filter((t) => t.task_id);
}

async function getById(taskId) {
  if (!taskId) return null;
  const all = await getAll();
  return all.find((t) => t.task_id === taskId) || null;
}

async function getByAssignedTo(telegramId) {
  const all = await getAll();
  return all.filter((t) => t.assigned_to === String(telegramId));
}

async function getByAssignedBy(telegramId) {
  if (!telegramId) return [];
  const all = await getAll();
  return all.filter((t) => t.assigned_by === String(telegramId));
}

async function getSubmittedPendingApproval() {
  const all = await getAll();
  return all.filter((t) => t.status === STATUSES.SUBMITTED);
}

async function getSubmittedForAssigner(assignerUserId) {
  if (!assignerUserId) return [];
  const all = await getAll();
  return all.filter(
    (t) => t.status === STATUSES.SUBMITTED && t.assigned_by === String(assignerUserId),
  );
}

async function getByAssignedToMany(teamUserIds) {
  if (!Array.isArray(teamUserIds) || !teamUserIds.length) return [];
  const set = new Set(teamUserIds.map((x) => String(x)));
  const all = await getAll();
  return all.filter((t) => set.has(t.assigned_to));
}

/**
 * Tasks whose state is "waiting on action by `userId`" — used to seed
 * the My Tasks / Pending Sign-off lists without reading the whole sheet
 * twice.
 */
async function getActionableFor(userId) {
  const uid = String(userId);
  const all = await getAll();
  return all.filter((t) => {
    if (t.assigned_to === uid) {
      return [
        STATUSES.ASSIGNED,
        STATUSES.AWAITING_INCENTIVE, // doer waits for assigner; surfaced as "in negotiation"
        STATUSES.AWAITING_FINAL_ACK,
        STATUSES.ACTIVE,
      ].includes(t.status);
    }
    if (t.assigned_by === uid) {
      return [
        STATUSES.AWAITING_TIMELINE_ACK,
        STATUSES.AWAITING_INCENTIVE,
        STATUSES.SUBMITTED,
      ].includes(t.status);
    }
    return false;
  });
}

async function append(task) {
  const taskId = task.task_id || idGenerator.generate('TASK');
  const now = new Date().toISOString();
  const track = VALID_TRACKS.has(task.track) ? task.track : 'salaried';
  const status = VALID_STATUSES.has(task.status) ? task.status : STATUSES.ASSIGNED;

  const row = new Array(NUM_COLS).fill('');
  row[0] = taskId;
  row[1] = task.title || '';
  row[2] = task.description || '';
  row[3] = task.assigned_to || '';
  row[4] = task.assigned_by || '';
  row[5] = status;
  row[6] = task.created_at || now;
  row[7] = task.submitted_at || '';
  row[8] = task.completed_at || '';
  row[9] = track;
  row[10] = task.priority || 'normal';
  row[11] = task.assigned_at || now;
  row[12] = task.accepted_at || '';
  row[13] = task.proposed_hours != null ? String(task.proposed_hours) : '';
  row[14] = task.proposed_deadline || '';
  row[15] = String(task.negotiation_rounds || 0);
  row[16] = task.timeline_agreed_at || '';
  row[17] = task.started_at || '';
  row[18] = task.approved_at || '';
  row[19] = task.last_event_at || now;

  await sheets.appendRows(SHEET, [row]);
  return { ...task, task_id: taskId, status, track, last_event_at: row[19] };
}

const COLUMN_BY_FIELD = Object.freeze({
  status: 'F',
  submitted_at: 'H',
  completed_at: 'I',
  accepted_at: 'M',
  proposed_hours: 'N',
  proposed_deadline: 'O',
  negotiation_rounds: 'P',
  timeline_agreed_at: 'Q',
  started_at: 'R',
  approved_at: 'S',
  last_event_at: 'T',
});

/**
 * Update an arbitrary set of fields on a task row in a single sheet
 * call. Pass any subset of COLUMN_BY_FIELD keys in `patch`.
 *
 * `last_event_at` is always written to `now()` unless explicitly
 * provided in the patch.
 */
async function updateFields(taskId, patch) {
  if (!taskId || !patch || typeof patch !== 'object') return false;
  const all = await getAll();
  const t = all.find((x) => x.task_id === taskId);
  if (!t) return false;

  const nowIso = new Date().toISOString();
  const finalPatch = { ...patch };
  if (!('last_event_at' in finalPatch)) finalPatch.last_event_at = nowIso;

  // Sheets has no batchUpdate via our thin client beyond updateRange,
  // so do per-cell writes. Field count per transition is tiny (1-3
  // cells), so this is fine.
  for (const [field, value] of Object.entries(finalPatch)) {
    const col = COLUMN_BY_FIELD[field];
    if (!col) continue;
    const cellValue = value == null ? '' : String(value);
    await sheets.updateRange(SHEET, `${col}${t.rowIndex}`, [[cellValue]]);
  }
  return true;
}

/**
 * Legacy single-status updater. Preserved for callers that haven't
 * migrated to updateFields yet. Now routes through updateFields so
 * `last_event_at` is also bumped.
 */
async function updateStatus(taskId, status, submittedOrCompletedAt) {
  const patch = { status };
  if (status === STATUSES.SUBMITTED) patch.submitted_at = submittedOrCompletedAt || new Date().toISOString();
  if (status === STATUSES.COMPLETED) {
    const now = submittedOrCompletedAt || new Date().toISOString();
    patch.completed_at = now;
    patch.approved_at = now;
  }
  return updateFields(taskId, patch);
}

module.exports = {
  // metadata
  SHEET,
  STATUSES,
  VALID_STATUSES,
  VALID_TRACKS,
  COLUMN_BY_FIELD,
  // readers
  getAll,
  getById,
  getByAssignedTo,
  getByAssignedBy,
  getSubmittedPendingApproval,
  getSubmittedForAssigner,
  getByAssignedToMany,
  getActionableFor,
  // writers
  append,
  updateFields,
  updateStatus,
  // test exports
  _parse: parse,
};
