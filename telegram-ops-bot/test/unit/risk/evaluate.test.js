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

  await t.test('employee needs TWO admins on dual actions (DUAL-1)', async () => {
    await asAdmin(false, async () => {
      const r = await risk.evaluate({ action: 'sell_package', userId: '2' });
      assert.equal(r.risk, 'approval_required');
      assert.match(r.reason, /require two-admin approval/i);
    });
  });

  await t.test('employee needs a single admin on non-dual always actions', async () => {
    await asAdmin(false, async () => {
      const r = await risk.evaluate({ action: 'supply_request', userId: '2' });
      assert.equal(r.risk, 'approval_required');
      assert.match(r.reason, /require admin approval/i);
    });
  });
});

// ── DUAL-1 policy (specs/DUAL-1_TWO_ADMIN_APPROVAL.md) ─────────────────────

test('DUAL-1 — dual-admin policy tables', async (t) => {
  await t.test('every dual action is also in ALWAYS_APPROVAL_ACTIONS', () => {
    for (const a of risk.DUAL_ADMIN_ACTIONS) {
      assert.ok(risk.ALWAYS_APPROVAL_ACTIONS.includes(a), `${a} must be ALWAYS-gated`);
    }
  });

  await t.test('inventory writes formerly admin-direct are now ALWAYS-gated', () => {
    for (const a of ['add', 'add_stock', 'transfer_than', 'transfer_package', 'transfer_batch',
      'receive_goods', 'set_forex_rate', 'add_bank', 'remove_bank', 'record_office_expense']) {
      assert.ok(risk.ALWAYS_APPROVAL_ACTIONS.includes(a), `${a} must be in ALWAYS_APPROVAL_ACTIONS`);
      assert.ok(risk.DUAL_ADMIN_ACTIONS.includes(a), `${a} must be in DUAL_ADMIN_ACTIONS`);
    }
  });

  await t.test('staged flows stay out of the dual list (owner decision #3)', () => {
    assert.ok(!risk.DUAL_ADMIN_ACTIONS.includes('supply_request'));
  });

  await t.test('requiredAdminApprovals matrix', () => {
    // Non-dual action → always a single approval tap.
    assert.equal(risk.requiredAdminApprovals({ action: 'add_contact', requesterIsAdmin: false, adminCount: 5 }), 1);
    // Admin requester counts as the 1st admin → one other approver.
    assert.equal(risk.requiredAdminApprovals({ action: 'receive_goods', requesterIsAdmin: true, adminCount: 5 }), 1);
    // Employee requester → two distinct admin approvers.
    assert.equal(risk.requiredAdminApprovals({ action: 'receive_goods', requesterIsAdmin: false, adminCount: 3 }), 2);
    // Degrades instead of deadlocking a 1-admin deployment.
    assert.equal(risk.requiredAdminApprovals({ action: 'receive_goods', requesterIsAdmin: false, adminCount: 1 }), 1);
    assert.equal(risk.requiredAdminApprovals({ action: 'receive_goods', requesterIsAdmin: false, adminCount: 0 }), 1);
    // Unknown headcount → strict default of 2.
    assert.equal(risk.requiredAdminApprovals({ action: 'receive_goods', requesterIsAdmin: false, adminCount: undefined }), 2);
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
