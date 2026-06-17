'use strict';

/**
 * Unit suite for src/flows/taskStateMachine.js — the PURE surface of the task
 * engine: canTransition(), the transition table invariants, STATUSES, and the
 * typed error classes. No I/O, no mocks.
 *
 * transition()/create() persist via tasksRepository + taskEventsRepository
 * (Sheets) and are exercised by smoke S8 at the integration tier.
 *
 * ADMIN_IDS is seeded before requiring the engine so the assigner_or_admin
 * admin branch is reachable offline (config reads env at load time; the test
 * runner isolates each file in its own process).
 */

process.env.ADMIN_IDS = process.env.ADMIN_IDS || '777';

const test = require('node:test');
const assert = require('node:assert/strict');

const sm = require('../../../src/flows/taskStateMachine');
const S = sm.STATUSES;

const ADMIN_ID = String(process.env.ADMIN_IDS).split(',')[0];
const DOER = 'doer-1';
const ASSIGNER = 'assigner-1';

/** Minimal task row. */
function task(status, over = {}) {
  return {
    task_id: 'TASK-1',
    status,
    assigned_to: DOER,
    assigned_by: ASSIGNER,
    negotiation_rounds: 0,
    priority: 'normal',
    ...over,
  };
}

test('canTransition() — actor roles', async (t) => {
  await t.test('doer may propose_timeline from assigned', () => {
    assert.equal(sm.canTransition(task(S.ASSIGNED), 'propose_timeline', DOER), true);
  });

  await t.test('assigner may NOT propose_timeline (doer-only event)', () => {
    assert.equal(sm.canTransition(task(S.ASSIGNED), 'propose_timeline', ASSIGNER), false);
  });

  await t.test('assigner may cancel from assigned', () => {
    assert.equal(sm.canTransition(task(S.ASSIGNED), 'cancel', ASSIGNER), true);
  });

  await t.test('an admin satisfies assigner_or_admin', () => {
    assert.equal(sm.canTransition(task(S.ASSIGNED), 'cancel', ADMIN_ID), true);
  });

  await t.test('a stranger satisfies no role', () => {
    assert.equal(sm.canTransition(task(S.ASSIGNED), 'cancel', 'nobody'), false);
  });
});

test('canTransition() — legality', async (t) => {
  await t.test('rejects an event illegal for the current status', () => {
    assert.equal(sm.canTransition(task(S.ASSIGNED), 'approve', ASSIGNER), false);
  });

  await t.test('drop is illegal once submitted', () => {
    assert.equal(sm.canTransition(task(S.SUBMITTED), 'drop', ASSIGNER), false);
  });

  await t.test('approve is legal from submitted', () => {
    assert.equal(sm.canTransition(task(S.SUBMITTED), 'approve', ASSIGNER), true);
  });

  await t.test('terminal states have no legal events', () => {
    for (const term of [S.COMPLETED, S.DECLINED, S.CANCELLED, S.DROPPED]) {
      assert.equal(sm.canTransition(task(term), 'approve', ASSIGNER), false);
      assert.equal(sm.canTransition(task(term), 'cancel', ASSIGNER), false);
    }
  });

  await t.test('null task / unknown status are not transitionable', () => {
    assert.equal(sm.canTransition(null, 'cancel', ASSIGNER), false);
    assert.equal(sm.canTransition(task('bogus_status'), 'cancel', ASSIGNER), false);
  });

  await t.test('update_priority is a legal self-transition mid-lifecycle', () => {
    assert.equal(sm.canTransition(task(S.ACTIVE), 'update_priority', ASSIGNER), true);
  });
});

test('canTransition() — negotiation rounds cap', async (t) => {
  await t.test('renegotiate allowed below the cap', () => {
    assert.equal(
      sm.canTransition(task(S.AWAITING_FINAL_ACK, { negotiation_rounds: 0 }), 'renegotiate', DOER),
      true,
    );
  });

  await t.test('renegotiate blocked at the cap', () => {
    assert.equal(
      sm.canTransition(task(S.AWAITING_FINAL_ACK, { negotiation_rounds: sm.MAX_NEGOTIATION_ROUNDS }), 'renegotiate', DOER),
      false,
    );
  });
});

test('transition table — invariants', async (t) => {
  const ROLES = new Set(['doer', 'assigner_or_admin', 'system']);

  await t.test('every transition has a valid role, eventType, and target', () => {
    for (const [status, events] of Object.entries(sm.TRANSITIONS)) {
      for (const [event, def] of Object.entries(events)) {
        assert.ok(ROLES.has(def.actorRole), `${status}.${event} actorRole`);
        assert.equal(typeof def.eventType, 'string', `${status}.${event} eventType`);
        assert.ok(
          typeof def.to === 'string' || typeof def.to === 'function',
          `${status}.${event} target`,
        );
      }
    }
  });

  await t.test('terminal states define no outgoing edges', () => {
    for (const term of [S.COMPLETED, S.DECLINED, S.CANCELLED, S.DROPPED]) {
      assert.deepEqual(Object.keys(sm.TRANSITIONS[term]), []);
    }
  });

  await t.test('MAX_NEGOTIATION_ROUNDS is 3', () => {
    assert.equal(sm.MAX_NEGOTIATION_ROUNDS, 3);
  });
});

test('error classes', async (t) => {
  await t.test('carry a stable code and extend Error', () => {
    const cases = [
      [new sm.IllegalTransitionError('e', 'assigned', 'T1'), 'ILLEGAL_TRANSITION'],
      [new sm.NotActorError('e', 'doer', 'u', 'T1'), 'NOT_ACTOR'],
      [new sm.RoundsExhaustedError('e', 3, 'T1'), 'ROUNDS_EXHAUSTED'],
      [new sm.TaskNotFoundError('T1'), 'TASK_NOT_FOUND'],
    ];
    for (const [err, code] of cases) {
      assert.ok(err instanceof Error);
      assert.equal(err.code, code);
      assert.equal(err.taskId, 'T1');
    }
  });
});
