'use strict';

/**
 * PAY-2 — payment_reasons: the reason behind every payment request.
 *
 * Pinned: parameterised INSERT into the right table/columns with the chip
 * key computed; FAIL OPEN (a PG error returns the neutral value and never
 * throws); PG-off never touches the pool; the chip query's shape; the
 * backfill script's selection rules (they feed this table, hence here);
 * migration 002 rides the append-only runner.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const pool = require(path.join(SRC, 'db/postgresPool'));
const migrations = require(path.join(SRC, 'db/migrations'));
const repo = require(path.join(SRC, 'repositories/paymentReasonsRepository'));
const { planBackfill, renderTable } = require('../../../scripts/backfill-payment-reasons');

/** Fake pool capturing SQL + params; `answer(text, params)` supplies rows. */
function fakePg(answer) {
  const q = [];
  const reply = async (text, params) => {
    q.push({ text: String(text).trim(), params });
    return { rows: answer ? (answer(String(text), params) || []) : [] };
  };
  return { q, client: { query: reply }, reply };
}

function withPool(fake, fn, { throwOn } = {}) {
  const orig = { enabled: pool.isEnabled, query: pool.query, tx: pool.withTransaction };
  pool.isEnabled = () => true;
  pool.query = throwOn ? async () => { throw new Error(throwOn); } : fake.reply;
  pool.withTransaction = throwOn ? async () => { throw new Error(throwOn); } : async (cb) => cb(fake.client);
  return Promise.resolve(fn()).finally(() => {
    pool.isEnabled = orig.enabled; pool.query = orig.query; pool.withTransaction = orig.tx;
  });
}

function withPoolOff(fn) {
  const orig = { enabled: pool.isEnabled, query: pool.query, tx: pool.withTransaction };
  let touched = 0;
  pool.isEnabled = () => false;
  pool.query = async () => { touched += 1; return { rows: [] }; };
  pool.withTransaction = async () => { touched += 1; return null; };
  return Promise.resolve(fn(() => touched)).finally(() => {
    pool.isEnabled = orig.enabled; pool.query = orig.query; pool.withTransaction = orig.tx;
  });
}

const ARGS = {
  paymentId: 'PAY-260909-0001', approvalRequestId: 'REQ-1', requesterId: '555',
  requesterName: 'Abdul', payeeName: 'Abdul', payeeType: 'employee',
  amountNgn: 4000, reasonText: '  Transport   to Idumota!! ',
};

test('record(): parameterised INSERT into payment_reasons with the chip key computed', async () => {
  const fake = fakePg((text) => (/INSERT INTO payment_reasons/.test(text) ? [{ id: '17' }] : []));
  await withPool(fake, async () => {
    const id = await repo.record(ARGS);
    assert.equal(id, 17);
    assert.equal(fake.q.length, 1);
    const ins = fake.q[0];
    assert.match(ins.text, /INSERT INTO payment_reasons/);
    assert.match(ins.text, /\(payment_id, approval_request_id, requester_id, requester_name,\s+payee_name, payee_type, amount_ngn, reason_text, reason_key, raised_at\)/);
    assert.match(ins.text, /RETURNING id/);
    assert.ok(!/'/.test(ins.text.replace(/COALESCE\(\$10::timestamptz, now\(\)\)/, '')), 'no literals interpolated');
    assert.deepEqual(ins.params, [
      'PAY-260909-0001', 'REQ-1', '555', 'Abdul', 'Abdul', 'employee', 4000,
      'Transport   to Idumota!!', 'transport to idumota', null,
    ]);
  });
});

test('record(): the backfill may pin raised_at; live writes leave it to now()', async () => {
  const fake = fakePg(() => [{ id: 1 }]);
  await withPool(fake, async () => {
    await repo.record({ ...ARGS, raisedAt: '2026-09-01T10:00:00.000Z' });
    assert.equal(fake.q[0].params[9], '2026-09-01T10:00:00.000Z');
  });
});

test('record(): bad input is refused with null and never reaches the pool', async () => {
  const fake = fakePg();
  await withPool(fake, async () => {
    assert.equal(await repo.record({ ...ARGS, reasonText: '   ' }), null, 'blank reason');
    assert.equal(await repo.record({ ...ARGS, paymentId: '' }), null, 'no payment id');
    assert.equal(await repo.record({ ...ARGS, requesterId: undefined }), null, 'no requester');
    assert.equal(await repo.record({ ...ARGS, amountNgn: 'abc' }), null, 'amount not a number');
    assert.equal(await repo.record(undefined), null, 'no args at all');
    assert.equal(fake.q.length, 0);
  });
});

test('record() fails OPEN: a PG error returns null and never throws', async () => {
  const fake = fakePg();
  await withPool(fake, async () => {
    assert.equal(await repo.record(ARGS), null);
  }, { throwOn: 'pg down' });
});

test('PG off: every read and write returns its neutral value without touching the pool', async () => {
  await withPoolOff(async (touched) => {
    assert.equal(await repo.record(ARGS), null);
    assert.equal(await repo.forPayment('PAY-1'), null);
    assert.deepEqual(await repo.topForRequester('555'), []);
    assert.deepEqual(await repo.listByRange('2026-09-01', '2026-09-02'), []);
    assert.deepEqual([...await repo.existingPaymentIds()], []);
    assert.equal(touched(), 0);
  });
});

test('forPayment(): the latest row for the payment, shaped; null when none', async () => {
  const at = new Date('2026-09-09T12:00:00Z');
  const fake = fakePg((text, params) => (params[0] === 'PAY-1'
    ? [{ id: '3', payment_id: 'PAY-1', amount_ngn: '4000.00', reason_text: 'Transport to Idumota', reason_key: 'transport to idumota', raised_at: at }]
    : []));
  await withPool(fake, async () => {
    const row = await repo.forPayment('PAY-1');
    assert.equal(row.id, 3);
    assert.equal(row.amount_ngn, 4000);
    assert.equal(row.raised_at, '2026-09-09T12:00:00.000Z');
    assert.match(fake.q[0].text, /FROM payment_reasons\s+WHERE payment_id = \$1\s+ORDER BY raised_at DESC, id DESC\s+LIMIT 1/);
    assert.equal(await repo.forPayment('PAY-9'), null);
  });
  await withPool(fakePg(), async () => {
    assert.equal(await repo.forPayment('PAY-1'), null, 'fail open');
  }, { throwOn: 'pg down' });
});

test('topForRequester(): repeating reasons only, most used then most recent, latest spelling, limit clamped', async () => {
  const fake = fakePg(() => [
    { reason_key: 'transport to idumota', uses: '3', last_at: new Date('2026-09-09T10:00:00Z'), reason_text: 'Transport to Idumota' },
    { reason_key: 'loading at the warehouse', uses: 2, last_at: '2026-09-08T10:00:00.000Z', reason_text: 'Loading at the warehouse' },
  ]);
  await withPool(fake, async () => {
    const out = await repo.topForRequester('555');
    assert.deepEqual(out, [
      { reason_text: 'Transport to Idumota', reason_key: 'transport to idumota', uses: 3, last_at: '2026-09-09T10:00:00.000Z' },
      { reason_text: 'Loading at the warehouse', reason_key: 'loading at the warehouse', uses: 2, last_at: '2026-09-08T10:00:00.000Z' },
    ]);
    const sql = fake.q[0].text;
    assert.match(sql, /WHERE requester_id = \$1 AND reason_key <> ''/);
    assert.match(sql, /HAVING COUNT\(\*\) >= 2/);
    assert.match(sql, /ORDER BY uses DESC, last_at DESC/);
    assert.match(sql, /ARRAY_AGG\(reason_text ORDER BY raised_at DESC, id DESC\)\)\[1\]/, 'latest spelling wins');
    assert.deepEqual(fake.q[0].params, ['555', 4], 'default limit 4');
    await repo.topForRequester('555', 999);
    assert.equal(fake.q[1].params[1], 50, 'clamped');
    await repo.topForRequester('555', 0);
    assert.equal(fake.q[2].params[1], 4, 'nonsense limit falls back');
  });
  await withPool(fakePg(), async () => {
    assert.deepEqual(await repo.topForRequester('555'), [], 'fail open');
  }, { throwOn: 'pg down' });
});

test('listByRange(): half-open window, oldest first, rows shaped', async () => {
  const fake = fakePg(() => [{ id: '1', amount_ngn: '12.50', raised_at: new Date('2026-09-01T00:00:00Z') }]);
  await withPool(fake, async () => {
    const rows = await repo.listByRange('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount_ngn, 12.5);
    assert.equal(rows[0].raised_at, '2026-09-01T00:00:00.000Z');
    assert.match(fake.q[0].text, /raised_at >= \$1::timestamptz AND raised_at < \$2::timestamptz/);
    assert.match(fake.q[0].text, /ORDER BY raised_at ASC, id ASC/);
    assert.deepEqual(fake.q[0].params, ['2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z']);
  });
  await withPool(fakePg(), async () => {
    assert.deepEqual(await repo.listByRange('a', 'b'), [], 'fail open');
  }, { throwOn: 'pg down' });
});

test('existingPaymentIds(): one DISTINCT round trip → a Set; empty on error', async () => {
  const fake = fakePg(() => [{ payment_id: 'PAY-1' }, { payment_id: 'PAY-2' }]);
  await withPool(fake, async () => {
    const set = await repo.existingPaymentIds();
    assert.deepEqual([...set].sort(), ['PAY-1', 'PAY-2']);
    assert.match(fake.q[0].text, /SELECT DISTINCT payment_id FROM payment_reasons/);
  });
  await withPool(fakePg(), async () => {
    assert.deepEqual([...await repo.existingPaymentIds()], []);
  }, { throwOn: 'pg down' });
});

// ── the backfill script's pure plan (it feeds this table) ─────────────────

const QUEUE = [
  { rowIndex: 2, requestId: 'REQ-1', user: '555', createdAt: '2026-09-01T10:00:00.000Z', status: 'approved',
    actionJSON: { action: 'request_payment', payment_id: 'PAY-1', payee_name: 'Abdul', payee_type: 'employee', amount_ngn: 4000, reason: 'Transport to Idumota' } },
  { rowIndex: 3, requestId: 'REQ-2', user: '556', createdAt: '2026-09-02T10:00:00.000Z', status: 'pending',
    actionJSON: { action: 'request_payment', payment_id: 'PAY-2', payee_name: 'Musa', payee_type: 'contractor', amount_ngn: 9000, reason: 'Loading' } },
  { rowIndex: 4, requestId: 'REQ-3', user: '555', createdAt: '2026-08-20T10:00:00.000Z', status: 'done',
    actionJSON: { action: 'request_payment', payment_id: 'PAY-3', payee_name: 'Abdul', amount_ngn: 100 } },
  { rowIndex: 5, requestId: 'REQ-4', user: '555', createdAt: '', status: 'pending',
    actionJSON: { action: 'request_payment', reason: 'no id' } },
  { rowIndex: 6, requestId: 'REQ-5', user: '555', createdAt: '', status: 'approved',
    actionJSON: { action: 'sell_bale', reason: 'not a payment' } },
  { rowIndex: 7, requestId: 'REQ-6', user: '555', createdAt: '', status: 'approved', actionJSON: {} },
  { rowIndex: 8, requestId: 'REQ-1', user: '555', createdAt: '2026-09-01T10:00:00.000Z', status: 'approved',
    actionJSON: { action: 'request_payment', payment_id: 'PAY-1', reason: 'Transport to Idumota' } },
];

test('backfill plan: only request_payment rows with a reason and no PG row yet; names from Users; raised_at from the queue', () => {
  const plan = planBackfill({
    rows: QUEUE, existing: new Set(['PAY-2']), namesById: new Map([['555', 'Abdul']]),
  });
  assert.deepEqual(plan.inserts, [{
    paymentId: 'PAY-1', approvalRequestId: 'REQ-1', requesterId: '555', requesterName: 'Abdul',
    payeeName: 'Abdul', payeeType: 'employee', amountNgn: 4000, reasonText: 'Transport to Idumota',
    raisedAt: '2026-09-01T10:00:00.000Z',
  }]);
  assert.deepEqual(plan.skipped.map((s) => [s.paymentId, s.why]), [
    ['PAY-2', 'already in payment_reasons'],
    ['PAY-3', 'no reason on payload (pre-PAY-2)'],
    ['', 'no payment_id on payload'],
    ['PAY-1', 'duplicate queue row'],
  ]);
});

test('backfill plan: an unknown requester keeps an empty name, never an invented one; no rows → empty plan', () => {
  const plan = planBackfill({ rows: QUEUE.slice(0, 1), existing: new Set() });
  assert.equal(plan.inserts[0].requesterName, '');
  assert.deepEqual(planBackfill({ rows: [], existing: new Set() }), { inserts: [], skipped: [] });
});

test('backfill table: dry-run says so and names --commit; commit mode says INSERT', () => {
  const plan = planBackfill({ rows: QUEUE, existing: new Set(), namesById: new Map() });
  const dry = renderTable(plan).join('\n');
  assert.match(dry, /payment_id\s+request\s+requester\s+payee\s+amount\s+reason\s+action/);
  assert.match(dry, /PAY-1 .*would insert/);
  assert.match(dry, /2 to insert · 3 skipped/);
  assert.match(dry, /DRY RUN — nothing written\. Re-run with --commit/);
  const wet = renderTable(plan, { commit: true }).join('\n');
  assert.match(wet, /PAY-1 .*INSERT/);
  assert.match(wet, /COMMIT — /);
  assert.doesNotMatch(wet, /DRY RUN/);
});

// ── migration 002 rides the append-only runner ────────────────────────────

test('migration 002_payment_reasons is appended after 001 and creates the three PAY-2 tables', async () => {
  const ids = migrations._internals.MIGRATIONS.map((m) => m.id);
  assert.equal(ids[0], '001_stock_events', 'shipped step untouched');
  assert.equal(ids[ids.length - 1], '002_payment_reasons');
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  const m = migrations._internals.MIGRATIONS.find((x) => x.id === '002_payment_reasons');
  for (const t of ['payment_reason_codes', 'payment_reasons', 'payment_events']) {
    assert.match(m.sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`), t);
  }
  assert.match(m.sql, /kind IN \('raised','signed','approved','finance_card_sent','reminder_sent','done','declined','rejected','notified'\)/);
  assert.match(m.sql, /reason_code_id INTEGER REFERENCES payment_reason_codes\(id\)/);
  assert.match(m.sql, /payment_reasons_requester_idx ON payment_reasons \(requester_id, reason_key\)/);
  assert.match(m.sql, /payment_events_payment_idx ON payment_events \(payment_id, kind\)/);

  // A fresh db applies EVERY step, 001 then 002, each marked in its own transaction.
  const fake = fakePg();
  await withPool(fake, async () => {
    const out = await migrations.migrate();
    assert.deepEqual(out.applied, ids);
    const markers = fake.q.filter((x) => /INSERT INTO schema_migrations/.test(x.text)).map((x) => x.params[0]);
    assert.deepEqual(markers, ids);
    const ddl = fake.q.filter((x) => /CREATE TABLE IF NOT EXISTS payment_events/.test(x.text));
    assert.equal(ddl.length, 1);
  });
});
