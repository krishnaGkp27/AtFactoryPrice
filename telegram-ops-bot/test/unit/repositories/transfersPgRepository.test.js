'use strict';
/** TRF-20 (6/8) — the transfers table mirror: shape, fail-open, the SQL it sends. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const SRC = path.join(__dirname, '..', '..', '..', 'src');
const pool = require(path.join(SRC, 'db/postgresPool'));
const repo = require(path.join(SRC, 'repositories/transfersPgRepository'));
const ghosts = require(path.join(SRC, 'services/transferGhosts'));

function withPool(fake, fn) {
  const orig = { enabled: pool.isEnabled, query: pool.query };
  pool.isEnabled = () => true;
  pool.query = async (text, params) => { fake.q.push({ text: String(text).trim(), params }); return { rows: fake.rows || [] }; };
  return Promise.resolve(fn()).finally(() => { pool.isEnabled = orig.enabled; pool.query = orig.query; });
}
const lines = [{ design: '9031-D', shade: '2', qty: 6 }, { design: '9031-D', shade: '1', qty: 4 }];
const row = (status, stage, extra = {}) => ({
  requestId: 'TR-20260918-002', user: '7430648262', status, createdAt: '2026-09-18T13:12:34.000Z',
  resolvedAt: status === 'pending' ? '' : '2026-09-19T10:00:00.000Z', approver: status === 'pending' ? '' : 'Krishna',
  actionJSON: { action: 'transfer_stock', from: 'Lagos', to: 'Kano office', lines, stage, dispatcher: 'abdul', receiver: 'musa', ...extra },
});

test('shape: status says what happened, stage says where it sits; the load hash matches the guard\'s identity', () => {
  const s = repo._internals.shape(row('pending', 'requested', { idemKey: 'K-1' }));
  assert.equal(s.ref, 'TR-20260918-002');
  assert.equal(s.idem_key, 'K-1');
  assert.deepEqual([s.from_wh, s.to_wh, s.stage, s.status], ['Lagos', 'Kano office', 'requested', 'pending']);
  assert.equal(s.lines_hash, ghosts.linesKey(lines), 'same canonical multiset the Send guard uses');
  assert.equal(s.decided_at, null); assert.equal(s.decided_by, null); assert.equal(s.duplicate_of, null);
  assert.equal(repo._internals.shape(row('pending', 'requested')).idem_key, null, 'no key on a pre-TRF-20 row');
  assert.equal(repo._internals.statusOf(row('approved', 'in_transit')), 'received', 'the sheet\'s approved means received');
  assert.equal(repo._internals.statusOf(row('rejected', 'requested')), 'declined');
  assert.equal(repo._internals.statusOf(row('rejected', 'in_transit')), 'reverted', 'rejected after dispatch means the bales went home');
  const d = repo._internals.shape(row('approved', 'in_transit', { duplicateOf: 'TR-20260918-001' }));
  assert.equal(d.duplicate_of, 'TR-20260918-001'); assert.equal(d.decided_by, 'Krishna'); assert.match(d.decided_at, /^2026-09-19/);
});

test('upsert: fails open when Postgres is off, and sends ONE insert-or-update keyed by ref when on', async () => {
  const origEnabled = pool.isEnabled; pool.isEnabled = () => false;
  try { assert.equal(await repo.upsert(row('pending', 'requested')), false, 'off = no write, no throw'); }
  finally { pool.isEnabled = origEnabled; }
  const fake = { q: [] };
  await withPool(fake, async () => {
    assert.equal(await repo.upsert(row('pending', 'admin_review', { idemKey: 'K-9' })), true);
  });
  assert.equal(fake.q.length, 1);
  const [call] = fake.q;
  assert.match(call.text, /INSERT INTO transfers/);
  assert.match(call.text, /ON CONFLICT \(ref\) DO UPDATE/);
  assert.equal(call.params[0], 'TR-20260918-002');
  assert.equal(call.params[1], 'K-9');
  assert.equal(call.params[6], 'admin_review');
  assert.equal(call.params[7], 'pending');
  assert.equal(call.params[5], ghosts.linesKey(lines));
  assert.deepEqual(JSON.parse(call.params[4]), lines);
});

test('upsert: a database error is a warning, never a throw — the sheet stays the truth', async () => {
  const orig = { enabled: pool.isEnabled, query: pool.query };
  pool.isEnabled = () => true; pool.query = async () => { throw new Error('duplicate key value violates unique constraint "transfers_one_open_per_load"'); };
  try { assert.equal(await repo.upsert(row('pending', 'requested')), false); }
  finally { pool.isEnabled = orig.enabled; pool.query = orig.query; }
});

test('event: one trail row per lifecycle step', async () => {
  const fake = { q: [] };
  await withPool(fake, async () => {
    assert.equal(await repo.event('TR-20260918-002', 'dispatched', 'abdul', { bales: ['1', '2'] }), true);
  });
  assert.match(fake.q[0].text, /INSERT INTO transfer_events/);
  assert.deepEqual(fake.q[0].params.slice(0, 3), ['TR-20260918-002', 'dispatched', 'abdul']);
  assert.deepEqual(JSON.parse(fake.q[0].params[3]), { bales: ['1', '2'] });
});
