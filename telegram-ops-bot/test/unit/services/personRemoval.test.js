'use strict';

/**
 * RMV-1 Phase B (owner, 16-Aug-2026) — removing a person, behind two admins.
 *
 * The owner's decisions, from the removal impact analysis:
 *   2 — `inactive` is the word; the reason lives elsewhere.
 *   3 — reversible: a two-admin Restore beside Remove.
 *   4 — an outstanding balance is DISCLOSED on the card, never a gate.
 *
 * Pinned here:
 *  - all three removal actions need TWO admin taps, asserted through
 *    requiredAdminApprovals rather than list membership (the PAY-1 lesson:
 *    a test that checks the list can pass while the gate is open);
 *  - approval flips BOTH registers and leaves the node bound — CON-1 made a
 *    customer exist in two places, so removal must move both or re-open the
 *    split-brain from the other side;
 *  - history is never rewritten;
 *  - removing an already-removed customer fails LOUD (CUS-2), and so does
 *    restoring an active one;
 *  - the money line appears on the card and does not block;
 *  - an admin cannot remove themselves, and the last admin cannot go.
 */

process.env.ADMIN_IDS = '777,778';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '../../../src');
const riskEvaluate = require(path.join(SRC, 'risk/evaluate'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const inventoryService = require(path.join(SRC, 'services/inventoryService'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const contactsRepository = require(path.join(SRC, 'repositories/contactsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));

/* ── the gate ── */

test('all three removal actions need two admin taps — asserted on the matrix, not the list', () => {
  for (const action of ['remove_customer', 'restore_customer', 'deactivate_user']) {
    assert.ok(riskEvaluate.ALWAYS_APPROVAL_ACTIONS.includes(action), `${action} ALWAYS-gated`);
    assert.ok(riskEvaluate.DUAL_ADMIN_ACTIONS.includes(action), `${action} dual`);
    assert.equal(
      riskEvaluate.requiredAdminApprovals({ action, requesterIsAdmin: false, adminCount: 3 }), 2,
      `${action}: an employee request needs two distinct admins`);
    assert.equal(
      riskEvaluate.requiredAdminApprovals({ action, requesterIsAdmin: true, adminCount: 3 }), 1,
      `${action}: an admin requester still needs a second pair of eyes`);
  }
  // Degrades rather than deadlocking a one-admin deployment.
  assert.equal(
    riskEvaluate.requiredAdminApprovals({ action: 'remove_customer', requesterIsAdmin: false, adminCount: 1 }), 1);
});

/* ── the card (decision 4) ── */

test('the card discloses the debt and the history, and never claims to erase either', async () => {
  const card = await approvalCards.buildCardFromActionJSON({
    action: 'remove_customer', name: 'Mr femi', customer_id: 'AFP-C-2',
    phone: '+2348012345678', category: 'Wholesale', outstanding_balance: 250000,
    supply_count: 12, last_supply_date: '2026-07-04', network_children: 3,
    reason: 'Shop closed',
  });
  assert.match(card, /Remove customer — Mr femi/);
  assert.match(card, /Owes ₦250,000/, 'the debt is on the card the admins decide from');
  assert.match(card, /does not clear it/, 'and it is explicit that removal settles nothing');
  assert.match(card, /12 supply records/);
  assert.match(card, /History is never rewritten/);
  assert.match(card, /3 person\(s\) sit under them/, 'the network children are disclosed');
  assert.match(card, /Reason: Shop closed/);
  assert.match(card, /Two admins must approve/);

  // CARD-3 grammar — a line only when it has something to say.
  const bare = await approvalCards.buildCardFromActionJSON({
    action: 'remove_customer', name: 'Quiet One', customer_id: 'AFP-C-9',
  });
  assert.doesNotMatch(bare, /Owes/, 'no money line when nothing is owed');
  assert.doesNotMatch(bare, /supply record/, 'no history line when there is none');
  assert.doesNotMatch(bare, /sit under them/, 'no network line when nobody does');

  const restore = await approvalCards.buildCardFromActionJSON({
    action: 'restore_customer', name: 'Mr femi', customer_id: 'AFP-C-2',
  });
  assert.match(restore, /Restore customer — Mr femi/);
  assert.match(restore, /return to pickers/);
});

/* ── the executor ── */

let customers = [];
let contacts = [];
let updates = [];
let contactUpdates = [];
let audits = [];

function stubRepos() {
  // The shared executor tail marks the queue row approved — a removal branch
  // must reach it, or the request stays pending and can execute twice.
  approvalQueueRepository.updateStatus = async () => true;
  customersRepository.getAll = async () => customers;
  customersRepository.updateRow = async (id, fields) => { updates.push({ id, fields }); return true; };
  contactsRepository.findByCustomerId = async (cid) => contacts.find((c) => c.customer_id === cid) || null;
  contactsRepository.update = async (id, patch) => { contactUpdates.push({ id, patch }); return true; };
  auditLogRepository.append = async (a, d, by) => { audits.push({ a, d, by }); };
}

function reset() {
  customers = [{
    customer_id: 'AFP-C-2', name: 'Mr femi', status: 'Active',
    notes: 'met at market', outstanding_balance: 250000,
  }];
  contacts = [{ contact_id: 'CON-7', customer_id: 'AFP-C-2', name: 'Mr femi', status: 'active' }];
  updates = []; contactUpdates = []; audits = [];
  stubRepos();
}

function queue(action, aj = {}) {
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'R-1', user: '888', status: 'pending',
    actionJSON: { action, customer_id: 'AFP-C-2', name: 'Mr femi', ...aj },
  }]);
}

test('approving a removal flips BOTH registers, and the node stays bound', async () => {
  reset();
  queue('remove_customer', { reason: 'Shop closed' });
  const res = await inventoryService.executeApprovedAction('R-1', 'Ajeet ‖ John');

  assert.equal(res.ok, true);
  assert.equal(updates.length, 1, 'the Customers row moved');
  assert.equal(updates[0].fields.status, 'inactive', 'to the ONE agreed word');
  assert.match(updates[0].fields.notes, /met at market/, 'the existing note survives');
  assert.match(updates[0].fields.notes, /\[removed \d{4}-\d{2}-\d{2}: Shop closed\]/,
    'the why is stamped for a human reading the sheet');

  assert.equal(contactUpdates.length, 1, 'the bound node moved too — no split-brain');
  assert.equal(contactUpdates[0].id, 'CON-7');
  assert.equal(contactUpdates[0].patch.status, 'inactive');

  // Two lines: this removal's own, plus the shared tail's approval_approved.
  const removalAudit = audits.find((x) => x.a === 'remove_customer');
  assert.ok(removalAudit, 'the removal is on the audit trail under its own action');
  assert.equal(removalAudit.d.reason, 'Shop closed');
  assert.equal(removalAudit.d.outstanding_at_action, 250000, 'what they owed at the moment of removal');
  assert.ok(audits.some((x) => x.a === 'approval_approved'), 'and the approval itself is logged');
  assert.match(res.message, /Every sale on record is untouched/);
});

test('the queue row is marked approved — a removal card cannot be executed twice', async () => {
  reset();
  const marked = [];
  approvalQueueRepository.updateStatus = async (id, status) => { marked.push({ id, status }); return true; };
  queue('remove_customer');
  await inventoryService.executeApprovedAction('R-1', 'Ajeet ‖ John');
  assert.deepEqual(marked.map((m) => [m.id, m.status]), [['R-1', 'approved']],
    'the branch reaches the shared tail; returning early would leave it pending for ever');
});

test('restore puts both registers back — decision 3, removal is not a one-way door', async () => {
  reset();
  customers[0].status = 'inactive';
  contacts[0].status = 'inactive';
  queue('restore_customer', { reason: 'Reopened' });
  const res = await inventoryService.executeApprovedAction('R-1', 'Ajeet ‖ John');

  assert.equal(res.ok, true);
  assert.equal(updates[0].fields.status, 'Active');
  assert.equal(contactUpdates[0].patch.status, 'active');
  assert.match(res.message, /restored and active again/);
});

test('a no-op fails LOUD, both ways — an approval never reports success for nothing', async () => {
  reset();
  customers[0].status = 'inactive';
  queue('remove_customer');
  const res = await inventoryService.executeApprovedAction('R-1', 'Ajeet ‖ John');
  assert.equal(res.ok, false, 'removing an already-removed customer is refused');
  assert.match(res.message, /already removed/);
  assert.equal(updates.length, 0, 'and nothing was written');

  reset();
  queue('restore_customer');
  const res2 = await inventoryService.executeApprovedAction('R-1', 'Ajeet ‖ John');
  assert.equal(res2.ok, false, 'restoring an active customer is refused');
  assert.match(res2.message, /already active/);
});

test('a missing node is reported, not swallowed — the registers must not drift silently', async () => {
  reset();
  contacts = [];
  queue('remove_customer');
  const res = await inventoryService.executeApprovedAction('R-1', 'Ajeet ‖ John');
  assert.equal(res.ok, true, 'the customer register is already correct, so the approval stands');
  assert.match(res.message, /network node was not found/, 'but the admin is told the two are out of step');
  assert.equal(audits[0].d.node_moved, false);
});

test('a vanished customer is refused rather than half-written', async () => {
  reset();
  customers = [];
  queue('remove_customer');
  const res = await inventoryService.executeApprovedAction('R-1', 'Ajeet ‖ John');
  assert.equal(res.ok, false);
  assert.match(res.message, /no longer exists/);
});

/* ── employee guards ── */

test('an admin cannot remove themselves, and the last admin cannot go', async () => {
  const users = [
    { user_id: '900', name: 'Solo Admin', role: 'admin', status: 'active' },
    { user_id: '901', name: 'Worker', role: 'employee', status: 'active' },
  ];
  usersRepository.getAll = async () => users;
  usersRepository.findByUserId = async (id) => users.find((u) => u.user_id === String(id)) || null;
  usersRepository.updateStatus = async () => true;
  auditLogRepository.append = async () => {};
  approvalQueueRepository.updateStatus = async () => true;

  // Self-target: the requester is the target.
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'R-S', user: '900', status: 'pending',
    actionJSON: { action: 'deactivate_user', telegram_id: '900' },
  }]);
  const selfRes = await inventoryService.executeApprovedAction('R-S', 'Ajeet');
  assert.equal(selfRes.ok, false, 'nobody removes themselves');
  assert.match(selfRes.message, /cannot remove yourself/i);

  // Last admin: raised by someone else, but 900 is the only active admin and
  // no env admin covers the gap.
  const realAdminIds = require(path.join(SRC, 'config')).access.adminIds;
  require(path.join(SRC, 'config')).access.adminIds = [];
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'R-L', user: '901', status: 'pending',
    actionJSON: { action: 'deactivate_user', telegram_id: '900' },
  }]);
  try {
    const lastRes = await inventoryService.executeApprovedAction('R-L', 'Ajeet');
    assert.equal(lastRes.ok, false, 'the business is never left with no admin');
    assert.match(lastRes.message, /last active admin/);
  } finally {
    require(path.join(SRC, 'config')).access.adminIds = realAdminIds;
  }

  // A non-admin is removable as before.
  approvalQueueRepository.getAllPending = async () => ([{
    requestId: 'R-W', user: '900', status: 'pending',
    actionJSON: { action: 'deactivate_user', telegram_id: '901' },
  }]);
  const workerRes = await inventoryService.executeApprovedAction('R-W', 'Ajeet');
  assert.notEqual(workerRes.ok, false, 'an ordinary employee still deactivates');
});
