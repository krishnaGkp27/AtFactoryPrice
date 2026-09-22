'use strict';
/**
 * TRF-20 — load identity and the ghost census, pinned on rows shaped like
 * the owner's 20-Sep-2026 export (references, dates and loads are real).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../../src/services/transferGhosts');

const ten9031 = Array.from({ length: 10 }, (_, i) => ({ design: '9031-D', shade: String(i + 1), qty: 1 }));
const row = (requestId, createdAt, status, stage, aj = {}) => ({
  requestId, user: '7430648262', status, createdAt,
  actionJSON: { action: 'transfer_stock', from: 'Lagos', to: 'Kano office', lines: ten9031, stage, ...aj },
});

const ROWS = [
  // 18-Sep: one load raised three times; the third was dispatched.
  row('TR-20260918-001', '2026-09-18T13:00:03Z', 'pending', 'requested', { }),
  row('TR-20260918-002', '2026-09-18T13:12:34Z', 'pending', 'requested'),
  row('TR-20260918-003', '2026-09-18T15:03:30Z', 'pending', 'in_transit'),
  // 10-Aug: parked for admin review; the same load was received the same evening.
  row('TR-20260810-001', '2026-08-10T10:12:31Z', 'pending', 'admin_review', { from: 'IDUMOTA', lines: [{ design: '202/201', shade: '1', qty: 1 }] }),
  row('TR-20260810-014', '2026-08-10T20:28:26Z', 'approved', 'in_transit', { from: 'IDUMOTA', lines: [{ design: '202/201', shade: '1', qty: 1 }] }),
  // 10-Aug: declined then re-raised and received — the re-raise is NOT a ghost.
  row('TR-20260810-002', '2026-08-10T10:16:20Z', 'rejected', 'requested', { from: 'Kano office', to: 'IDUMOTA', lines: [{ design: '9006', shade: '7', qty: 1 }] }),
  row('TR-20260810-003', '2026-08-10T10:17:14Z', 'approved', 'in_transit', { from: 'Kano office', to: 'IDUMOTA', lines: [{ design: '9006', shade: '7', qty: 1 }] }),
  // Unique loads: never ghosts.
  row('TR-20260810-005', '2026-08-10T10:36:00Z', 'pending', 'admin_review', { from: 'Kano office', to: 'IDUMOTA', lines: [{ design: '77008', shade: '1', qty: 2 }] }),
  row('TR-20260921-001', '2026-09-21T00:10:00Z', 'pending', 'requested', { to: 'IDUMOTA', lines: [{ design: '9043-A', shade: '8', qty: 1 }] }),
  // Not a transfer at all.
  { requestId: 'x', status: 'pending', createdAt: '2026-09-01', actionJSON: { action: 'sale_bundle' } },
];

test('loadKey: route + line multiset, order- and case-insensitive, requester ignored', () => {
  const a = g.loadKey({ from: 'Lagos', to: 'Kano office', lines: [{ design: '9006', shade: '3', qty: 2 }, { design: '77014', shade: '1', qty: 1 }] });
  const b = g.loadKey({ from: 'lagos ', to: 'KANO OFFICE', lines: [{ design: '77014', shade: '1', qty: '1' }, { design: '9006', shade: '3', qty: 2 }, { design: 'zero', shade: '9', qty: 0 }] });
  assert.equal(a, b);
  assert.notEqual(a, g.loadKey({ from: 'Lagos', to: 'Kano office', lines: [{ design: '9006', shade: '3', qty: 3 }] }), 'a different quantity is a different load');
  assert.notEqual(a, g.loadKey({ from: 'Kano office', to: 'Lagos', lines: [{ design: '9006', shade: '3', qty: 2 }, { design: '77014', shade: '1', qty: 1 }] }), 'the reverse route is a different load');
});

test('findIdenticalOpen: returns the OLDEST open twin, ignores closed rows and knowing duplicates', () => {
  const open = ROWS.filter((r) => r.status === 'pending');
  const hit = g.findIdenticalOpen(open, { from: 'Lagos', to: 'Kano office', lines: ten9031 });
  assert.equal(hit.requestId, 'TR-20260918-001', 'the first one raised is the one to open');
  assert.equal(g.findIdenticalOpen(open, { from: 'Lagos', to: 'Kano office', lines: [{ design: '9999', shade: '1', qty: 1 }] }), null);
  const marked = open.map((r) => ({ ...r, actionJSON: { ...r.actionJSON, duplicateOf: 'TR-x' } }));
  assert.equal(g.findIdenticalOpen(marked, { from: 'Lagos', to: 'Kano office', lines: ten9031 }), null, 'a row sent anyway never blocks the next send');
});

test('findGhosts: the 18-Sep twins and the 10-Aug parked row are ghosts; re-raises and unique loads are not', () => {
  const found = g.findGhosts(ROWS);
  assert.deepEqual(found.map((f) => f.ghost.requestId), ['TR-20260810-001', 'TR-20260918-001', 'TR-20260918-002']);
  const byGhost = Object.fromEntries(found.map((f) => [f.ghost.requestId, f]));
  assert.equal(byGhost['TR-20260918-001'].twin.requestId, 'TR-20260918-003');
  assert.match(byGhost['TR-20260918-001'].reason, /in transit/);
  assert.equal(byGhost['TR-20260810-001'].twin.requestId, 'TR-20260810-014');
  assert.match(byGhost['TR-20260810-001'].reason, /received/);
  assert.ok(!found.some((f) => f.ghost.requestId === 'TR-20260810-003'), 'a re-raise after a decline is the real transfer');
  assert.ok(!found.some((f) => f.ghost.requestId === 'TR-20260921-001'), 'a unique load is never a ghost');
  assert.ok(!found.some((f) => f.ghost.requestId === 'TR-20260918-003'), 'an in-transit row is never a ghost');
});

test('staleOpen: old open rows that are not ghosts', () => {
  const now = Date.parse('2026-09-22T00:00:00Z');
  const stale = g.staleOpen(ROWS, 14, now).map((r) => r.requestId);
  assert.deepEqual(stale, ['TR-20260810-005'], 'six weeks at admin review, unique load');
  assert.ok(!stale.includes('TR-20260810-001'), 'ghosts are listed as ghosts, not as stale');
});
