/**
 * Task workflow state machine (TG-7.5 Phase C — commit 2).
 *
 * Single funnel through which EVERY task lifecycle change must pass.
 * Responsibilities, in this order:
 *
 *   1. Look up the legal transitions for the task's current status.
 *   2. Reject illegal events with `IllegalTransitionError`.
 *   3. Enforce actor role (`doer` / `assigner_or_admin`).
 *   4. Enforce the 3-round cap on counter_timeline + renegotiate.
 *   5. Compute the minimal field patch (status + just the timestamps /
 *      counters that this event actually changes).
 *   6. Persist the patch via tasksRepository.updateFields.
 *   7. Write exactly one append-only row to TaskEvents.
 *
 * The bot UI never calls tasksRepository.updateStatus / updateFields
 * directly anymore for status changes — it goes through `transition()`.
 * That makes the TaskEvents log the unambiguous source of truth for
 * downstream performance analysis (planned vs actual durations,
 * negotiation latency, approval lag, Gantt timelines later).
 *
 * Pure engine — no Telegram side-effects, no message rendering. Safe
 * to unit-test offline (see scripts/smoke.js S8).
 */

'use strict';

const tasksRepository = require('../repositories/tasksRepository');
const taskEventsRepository = require('../repositories/taskEventsRepository');
const config = require('../config');

const STATUSES = tasksRepository.STATUSES;

const MAX_NEGOTIATION_ROUNDS = 3;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class IllegalTransitionError extends Error {
  constructor(event, fromStatus, taskId) {
    super(`Illegal transition: event="${event}" not allowed from status="${fromStatus}" (task ${taskId})`);
    this.name = 'IllegalTransitionError';
    this.code = 'ILLEGAL_TRANSITION';
    this.event = event;
    this.fromStatus = fromStatus;
    this.taskId = taskId;
  }
}

class NotActorError extends Error {
  constructor(event, expectedRole, actorUserId, taskId) {
    super(`NotActor: event="${event}" requires role="${expectedRole}" but actor=${actorUserId} (task ${taskId})`);
    this.name = 'NotActorError';
    this.code = 'NOT_ACTOR';
    this.event = event;
    this.expectedRole = expectedRole;
    this.actorUserId = actorUserId;
    this.taskId = taskId;
  }
}

class RoundsExhaustedError extends Error {
  constructor(event, rounds, taskId) {
    super(`Rounds exhausted: event="${event}" rejected; already at ${rounds}/${MAX_NEGOTIATION_ROUNDS} negotiation rounds (task ${taskId})`);
    this.name = 'RoundsExhaustedError';
    this.code = 'ROUNDS_EXHAUSTED';
    this.event = event;
    this.rounds = rounds;
    this.taskId = taskId;
  }
}

class TaskNotFoundError extends Error {
  constructor(taskId) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
    this.code = 'TASK_NOT_FOUND';
    this.taskId = taskId;
  }
}

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------
//
// Each entry describes ONE legal (status, event) pair. `to` may be a
// function (task, meta) => nextStatus to support a branching target
// (used by accept_timeline → incentivized vs salaried).
//
// `actorRole`:
//    'doer'                = actor must equal task.assigned_to
//    'assigner_or_admin'   = actor must equal task.assigned_by OR be admin
//    'system'              = no actor check (reserved; not currently used)
//
// `bumpsRounds: true` increments negotiation_rounds and enforces the cap.
// `setsTimestamps: [...]` lists the timestamp columns to stamp with `now`.
// `patchExtras(meta)` returns any other tasksRepository field patches
//    (e.g. proposed_hours, proposed_deadline from meta).
//
// `eventType` is the short tag written to TaskEvents.event_type.
// ---------------------------------------------------------------------------

const TRANSITIONS = Object.freeze({
  [STATUSES.ASSIGNED]: {
    propose_timeline: {
      to: STATUSES.AWAITING_TIMELINE_ACK,
      actorRole: 'doer',
      eventType: 'doer_proposed_timeline',
      setsTimestamps: ['accepted_at'],
      patchExtras: (meta) => ({
        proposed_hours: meta?.hours != null ? Number(meta.hours) : null,
        proposed_deadline: meta?.deadline || '',
      }),
    },
    decline: {
      to: STATUSES.DECLINED,
      actorRole: 'doer',
      eventType: 'doer_declined',
    },
    cancel: {
      to: STATUSES.CANCELLED,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_cancelled',
    },
  },

  [STATUSES.AWAITING_TIMELINE_ACK]: {
    // commit 3.5 — incentive is set BEFORE accept_timeline (for
    // incentivized track). accept_timeline therefore always goes
    // straight to awaiting_final_ack. The AWAITING_INCENTIVE state
    // below is kept for legacy / safety but the new UI never reaches
    // it.
    accept_timeline: {
      to: STATUSES.AWAITING_FINAL_ACK,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_accepted_timeline',
      setsTimestamps: ['timeline_agreed_at'],
    },
    // Self-transition: setting / changing the incentive amount during
    // negotiation. Status stays awaiting_timeline_ack; the audit log
    // records the change. Amount itself is written to the Incentives
    // sheet by the caller, not by the engine.
    set_incentive: {
      to: STATUSES.AWAITING_TIMELINE_ACK,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_set_incentive',
    },
    counter_timeline: {
      to: STATUSES.ASSIGNED,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_countered_timeline',
      bumpsRounds: true,
    },
    cancel: {
      to: STATUSES.CANCELLED,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_cancelled',
    },
  },

  [STATUSES.AWAITING_INCENTIVE]: {
    set_incentive: {
      to: STATUSES.AWAITING_FINAL_ACK,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_set_incentive',
      // Incentive amount itself is NOT stored on the Tasks sheet (kept
      // separate in Incentives). We only record that the event happened
      // and the amount is captured in meta (used for the TaskEvents row).
    },
    cancel: {
      to: STATUSES.CANCELLED,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_cancelled',
    },
  },

  [STATUSES.AWAITING_FINAL_ACK]: {
    final_ack: {
      to: STATUSES.ACTIVE,
      actorRole: 'doer',
      eventType: 'doer_final_ack',
      setsTimestamps: ['started_at'],
    },
    renegotiate: {
      to: STATUSES.ASSIGNED,
      actorRole: 'doer',
      eventType: 'doer_renegotiated',
      bumpsRounds: true,
    },
    cancel: {
      to: STATUSES.CANCELLED,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_cancelled',
    },
  },

  [STATUSES.ACTIVE]: {
    mark_done: {
      to: STATUSES.SUBMITTED,
      actorRole: 'doer',
      eventType: 'doer_marked_done',
      setsTimestamps: ['submitted_at'],
    },
    cancel: {
      to: STATUSES.CANCELLED,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_cancelled',
    },
  },

  [STATUSES.SUBMITTED]: {
    approve: {
      to: STATUSES.COMPLETED,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_approved',
      setsTimestamps: ['completed_at', 'approved_at'],
    },
    reject: {
      to: STATUSES.ACTIVE,
      actorRole: 'assigner_or_admin',
      eventType: 'assigner_rejected',
    },
  },

  // Terminal states — no outgoing edges.
  [STATUSES.COMPLETED]: {},
  [STATUSES.DECLINED]: {},
  [STATUSES.CANCELLED]: {},
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAdmin(userId) {
  const ids = (config && config.access && config.access.adminIds) || [];
  return ids.includes(String(userId));
}

function assertActorRole(transition, task, actorUserId) {
  const aid = String(actorUserId || '');
  if (transition.actorRole === 'doer') {
    if (aid !== String(task.assigned_to)) {
      throw new NotActorError(transition.eventType, 'doer', aid, task.task_id);
    }
  } else if (transition.actorRole === 'assigner_or_admin') {
    if (aid !== String(task.assigned_by) && !isAdmin(aid)) {
      throw new NotActorError(transition.eventType, 'assigner_or_admin', aid, task.task_id);
    }
  } else if (transition.actorRole === 'system') {
    // no-op
  } else {
    throw new Error(`taskStateMachine: unknown actorRole=${transition.actorRole}`);
  }
}

function resolveTarget(transition, task, meta) {
  return typeof transition.to === 'function' ? transition.to(task, meta) : transition.to;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a brand-new task. Wraps tasksRepository.append, then writes the
 * `assigned` event row so the audit log has a clean origin entry for
 * every task that ever existed.
 *
 * @param {Object}   spec
 * @param {string}   spec.title              required
 * @param {string}   spec.assigned_to        required  (Telegram user id)
 * @param {string}   spec.assigned_by        required  (Telegram user id)
 * @param {string} [spec.description]
 * @param {string} [spec.track]              'incentivized' | 'salaried' (default 'salaried')
 * @param {string} [spec.priority]           default 'normal'
 * @returns {Promise<Object>} the created task row (as stored).
 */
async function create(spec) {
  if (!spec || !spec.title || !spec.assigned_to || !spec.assigned_by) {
    throw new Error('taskStateMachine.create: title, assigned_to, assigned_by are required');
  }
  const created = await tasksRepository.append({
    title: spec.title,
    description: spec.description || '',
    assigned_to: spec.assigned_to,
    assigned_by: spec.assigned_by,
    status: STATUSES.ASSIGNED,
    track: spec.track || 'salaried',
    priority: spec.priority || 'normal',
  });
  await taskEventsRepository.append({
    task_id: created.task_id,
    event_type: 'assigned',
    from_status: '',
    to_status: STATUSES.ASSIGNED,
    actor_user_id: spec.assigned_by,
    meta: {
      track: created.track,
      priority: created.priority,
    },
  });
  return created;
}

/**
 * Apply a transition event to a task.
 *
 * @param {string} taskId
 * @param {string} event         one of the TRANSITIONS keys
 * @param {string} actorUserId   Telegram user id of the caller
 * @param {Object} [meta]        event-specific payload; stored in
 *                               TaskEvents.meta_json and may feed
 *                               patchExtras for the Tasks update
 *
 * @returns {Promise<{ task: Object, event: Object }>} updated task +
 *          the audit-log row that was just written.
 *
 * @throws {TaskNotFoundError|IllegalTransitionError|NotActorError|RoundsExhaustedError}
 */
async function transition(taskId, event, actorUserId, meta = {}) {
  const task = await tasksRepository.getById(taskId);
  if (!task) throw new TaskNotFoundError(taskId);

  const fromStatus = task.status;
  const transitionsForStatus = TRANSITIONS[fromStatus];
  if (!transitionsForStatus) {
    throw new IllegalTransitionError(event, fromStatus, taskId);
  }
  const t = transitionsForStatus[event];
  if (!t) throw new IllegalTransitionError(event, fromStatus, taskId);

  assertActorRole(t, task, actorUserId);

  if (t.bumpsRounds && task.negotiation_rounds >= MAX_NEGOTIATION_ROUNDS) {
    throw new RoundsExhaustedError(event, task.negotiation_rounds, taskId);
  }

  const toStatus = resolveTarget(t, task, meta);
  const nowIso = new Date().toISOString();

  const patch = { status: toStatus };
  if (Array.isArray(t.setsTimestamps)) {
    for (const col of t.setsTimestamps) patch[col] = nowIso;
  }
  if (typeof t.patchExtras === 'function') {
    const extras = t.patchExtras(meta) || {};
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined) patch[k] = v;
    }
  }
  if (t.bumpsRounds) {
    patch.negotiation_rounds = (task.negotiation_rounds || 0) + 1;
  }
  patch.last_event_at = nowIso;

  await tasksRepository.updateFields(taskId, patch);

  // Compose the audit row. We DROP undefined values and any incentive
  // amount from meta to be safe — money lives only in the Incentives
  // sheet. Callers that wish to log the amount in meta_json may do so
  // explicitly (e.g. set_incentive does, since admin Tasks views never
  // read TaskEvents.meta_json — only the finance Incentives report does).
  const eventRow = await taskEventsRepository.append({
    task_id: taskId,
    event_type: t.eventType,
    from_status: fromStatus,
    to_status: toStatus,
    actor_user_id: actorUserId,
    at: nowIso,
    meta: meta && Object.keys(meta).length ? meta : undefined,
  });

  return {
    task: { ...task, ...patch, rowIndex: task.rowIndex },
    event: eventRow,
  };
}

/**
 * Convenience predicate. Returns true if `event` is currently legal
 * for `task` (status + actor + rounds-cap). Does NOT mutate anything.
 * Useful for building UIs that hide impossible buttons.
 */
function canTransition(task, event, actorUserId) {
  if (!task) return false;
  const set = TRANSITIONS[task.status];
  if (!set) return false;
  const t = set[event];
  if (!t) return false;
  try {
    assertActorRole(t, task, actorUserId);
  } catch (_) {
    return false;
  }
  if (t.bumpsRounds && task.negotiation_rounds >= MAX_NEGOTIATION_ROUNDS) {
    return false;
  }
  return true;
}

module.exports = {
  MAX_NEGOTIATION_ROUNDS,
  TRANSITIONS,
  STATUSES,
  // public api
  create,
  transition,
  canTransition,
  // errors (exported so callers can pattern-match)
  IllegalTransitionError,
  NotActorError,
  RoundsExhaustedError,
  TaskNotFoundError,
};
