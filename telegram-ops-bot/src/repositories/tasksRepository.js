/**
 * Data access for Tasks sheet (task assignment and tracking).
 * status: pending | in_progress | submitted | completed
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const SHEET = 'Tasks';

function str(v) { return (v ?? '').toString().trim(); }

function parse(r, rowIndex) {
  return {
    rowIndex,
    task_id: str(r[0]),
    title: str(r[1]),
    description: str(r[2]),
    assigned_to: str(r[3]),
    assigned_by: str(r[4]),
    status: str(r[5]) || 'pending',
    created_at: str(r[6]),
    submitted_at: str(r[7]),
    completed_at: str(r[8]),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:I');
  return rows.map((r, i) => parse(r, i + 2)).filter((t) => t.task_id);
}

async function getById(taskId) {
  const all = await getAll();
  return all.find((t) => t.task_id === taskId) || null;
}

async function getByAssignedTo(telegramId) {
  const all = await getAll();
  return all.filter((t) => t.assigned_to === String(telegramId));
}

async function getSubmittedPendingApproval() {
  const all = await getAll();
  return all.filter((t) => t.status === 'submitted');
}

/**
 * Tasks the given assigner created that are currently waiting on
 * their sign-off (status === 'submitted').
 */
async function getSubmittedForAssigner(assignerUserId) {
  if (!assignerUserId) return [];
  const all = await getAll();
  return all.filter(
    (t) => t.status === 'submitted' && t.assigned_by === String(assignerUserId),
  );
}

/**
 * Tasks assigned to anyone in the set of `teamUserIds`. Used for the
 * "Team Tasks" view — caller computes the team via deptGraph.canAssignTo
 * and passes the resulting user_id list here.
 */
async function getByAssignedToMany(teamUserIds) {
  if (!Array.isArray(teamUserIds) || !teamUserIds.length) return [];
  const set = new Set(teamUserIds.map((x) => String(x)));
  const all = await getAll();
  return all.filter((t) => set.has(t.assigned_to));
}

async function append(task) {
  const taskId = task.task_id || idGenerator.generate('TASK');
  const now = new Date().toISOString();
  await sheets.appendRows(SHEET, [[
    taskId, task.title || '', task.description || '',
    task.assigned_to || '', task.assigned_by || '',
    task.status || 'pending', task.created_at || now,
    task.submitted_at || '', task.completed_at || '',
  ]]);
  return { ...task, task_id: taskId };
}

async function updateStatus(taskId, status, submittedAtOrCompletedAt) {
  const all = await getAll();
  const t = all.find((x) => x.task_id === taskId);
  if (!t) return false;
  const rowIndex = t.rowIndex;
  const now = new Date().toISOString();
  if (status === 'submitted') {
    await sheets.updateRange(SHEET, `F${rowIndex}:H${rowIndex}`, [[status, t.created_at, now]]);
  } else if (status === 'completed') {
    await sheets.updateRange(SHEET, `F${rowIndex}:I${rowIndex}`, [[status, t.created_at, t.submitted_at || '', submittedAtOrCompletedAt || now]]);
  } else {
    await sheets.updateRange(SHEET, `F${rowIndex}`, [[status]]);
  }
  return true;
}

module.exports = {
  getAll,
  getById,
  getByAssignedTo,
  getSubmittedPendingApproval,
  getSubmittedForAssigner,
  getByAssignedToMany,
  append,
  updateStatus,
  SHEET,
};
