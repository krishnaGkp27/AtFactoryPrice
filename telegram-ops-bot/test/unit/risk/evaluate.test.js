'use strict';

/**
 * Policy snapshot + behavior suite for src/risk/evaluate.js.
 *
 * READ-ONLY by design: this suite asserts the CURRENT approval semantics so
 * any future edit to the (sacred) policy tables or the evaluate() gate is a
 * conscious, reviewed change. It does NOT modify any policy — per the repo
 * rule that approval semantics are never changed without explicit instruction.
 *
 * evaluate() consults auth.isAdmin(userId) at call time, so we stub that one
 * function per-test (offline, no Sheets/network) and restore it afterward.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const risk = require('../../../src/risk/evaluate');
const auth = require('../../../src/middlewares/auth');

/** Run fn with auth.isAdmin forced to a fixed verdict, then restore. */
async function asAdmin(isAdmin, fn) {
  const original = auth.isAdmin;
  auth.isAdmin = () => isAdmin;
  try {
    return await fn();
  } finally {
    auth.isAdmin = original;
  }
}

// ── Policy table invariants (the sacred sets) ──────────────────────────────

test('policy tables — structural invariants', async (t) => {
  await t.test('all three exports are non-empty string arrays', () => {
    for (const list of [risk.WRITE_ACTIONS, risk.ALWAYS_APPROVAL_ACTIONS, risk.SUPER_ADMIN_APPROVAL_ACTIONS]) {
      assert.ok(Array.isArray(list) && list.length > 0);
      assert.ok(list.every((a) => typeof a === 'string' && a.length > 0));
    }
  });

  await t.test('no duplicate entries within a list', () => {
    for (const list of [risk.WRITE_ACTIONS, risk.ALWAYS_APPROVAL_ACTIONS, risk.SUPER_ADMIN_APPROVAL_ACTIONS]) {
      assert.equal(new Set(list).size, list.length);
    }
  });
});

test('policy tables — sacred membership', async (t) => {
  await t.test('sale/return/revert family always requires approval', () => {
    const sacred = [
      'sell_than', 'sell_package', 'sell_batch', 'sell_mixed', 'sell',
      'return_than', 'return_package', 'revert_sale_bundle',
      'record_payment', 'update_price', 'supply_request',
    ];
    for (const a of sacred) {
      assert.ok(risk.ALWAYS_APPROVAL_ACTIONS.includes(a), `${a} must be dual-admin gated`);
    }
  });

  await t.test('high-trust mutations are dual-admin gated', () => {
    for (const a of ['add_warehouse', 'rename_warehouse', 'bulk_receive_goods', 'add_user', 'promote_admin', 'deactivate_user', 'finalize_landed_cost']) {
      assert.ok(risk.ALWAYS_APPROVAL_ACTIONS.includes(a), `${a} must be in ALWAYS_APPROVAL_ACTIONS`);
    }
  });

  await t.test('promote_admin additionally requires a super-admin approver', () => {
    assert.deepEqual(risk.SUPER_ADMIN_APPROVAL_ACTIONS, ['promote_admin']);
  });
});

// ── evaluate() behavior ────────────────────────────────────────────────────

test('evaluate() — always-approval actions', async (t) => {
  await t.test('admin still needs a 2nd admin', async () => {
    await asAdmin(true, async () => {
      const r = await risk.evaluate({ action: 'sell_package', userId: '1' });
      assert.equal(r.risk, 'approval_required');
      assert.match(r.reason, /2nd admin/i);
    });
  });

  await t.test('employee needs an admin', async () => {
    await asAdmin(false, async () => {
      const r = await risk.evaluate({ action: 'sell_package', userId: '2' });
      assert.equal(r.risk, 'approval_required');
      assert.match(r.reason, /require admin approval/i);
    });
  });
});

test('evaluate() — plain write actions', async (t) => {
  await t.test('admin executes directly (safe)', async () => {
    await asAdmin(true, async () => {
      const r = await risk.evaluate({ action: 'add_customer', userId: '1' });
      assert.equal(r.risk, 'safe');
    });
  });

  await t.test('employee needs admin approval', async () => {
    await asAdmin(false, async () => {
      const r = await risk.evaluate({ action: 'add_customer', userId: '2' });
      assert.equal(r.risk, 'approval_required');
    });
  });
});

test('evaluate() — non-write actions are safe for everyone', async (t) => {
  await t.test('admin', async () => {
    await asAdmin(true, async () => {
      assert.equal((await risk.evaluate({ action: 'check_stock', userId: '1' })).risk, 'safe');
    });
  });

  await t.test('employee', async () => {
    await asAdmin(false, async () => {
      assert.equal((await risk.evaluate({ action: 'check_stock', userId: '2' })).risk, 'safe');
    });
  });
});
