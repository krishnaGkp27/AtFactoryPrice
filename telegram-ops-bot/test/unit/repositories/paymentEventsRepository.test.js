'use strict';

/**
 * PAY-2 — payment_events: the lifecycle trail.
 *
 * Pinned: parameterised INSERT into the right table/columns with detail
 * as jsonb; an unknown kind is refused before the pool; FAIL OPEN (a PG
 * error returns the neutral value, never throws); PG-off never touches the
 * pool; financeCardsFor reads only card + reminder rows with ids, deduped;
 * lastKindAt is an ISO string or null; KINDS matches the migration CHECK.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const pool = require(path.join(SRC, 'db/postgresPool'));
const migrations = require(path.join(SRC, 'db/migrations'));
const repo = require(path.join(SRC, 'repositories/paymentEventsRepository'));

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

test('KINDS is the migration CHECK list, frozen', () => {
  assert.deepEqual([...repo.KINDS], ['raised', 'signed', 'approved', 'finance_card_sent', 'reminder_sent',
    'done', 'declined', 'rejected', 'notified']);
  assert.ok(Object.isFrozen(repo.KINDS));
  const m = migrations._internals.MIGRATIONS.find((x) => x.id === '002_payment_reasons');
  const check = m.sql.match(/kind IN \(([^)]+)\)/)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(check, [...repo.KINDS], 'CHECK list and KINDS in step');
});

test('record(): parameterised INSERT into payment_events, detail as jsonb', async () => {
  const fake = fakePg((text) => (/INSERT INTO payment_events/.test(text) ? [{ id: '42' }] : []));
  await withPool(fake, async () => {
    const id = await repo.record({
      paymentId: 'PAY-1', approvalRequestId: 'REQ-1', kind: 'finance_card_sent',
      actorId: 999, actorName: 'Office', chatId: -100123, messageId: 77, detail: { copies: 1 },
    });
    assert.equal(id, 42);
    assert.equal(fake.q.length, 1);
    const ins = fake.q[0];
    assert.match(ins.text, /INSERT INTO payment_events/);
    assert.match(ins.text, /\(payment_id, approval_request_id, kind, actor_id, actor_name,\s+chat_id, message_id, detail\)/);
    assert.match(ins.text, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8::jsonb\)/);
    assert.match(ins.text, /RETURNING id/);
    assert.deepEqual(ins.params, ['PAY-1', 'REQ-1', 'finance_card_sent', '999', 'Office', '-100123', '77', '{"copies":1}']);
  });
});

test('record(): optional fields default to empty strings and {}', async () => {
  const fake = fakePg(() => [{ id: 1 }]);
  await withPool(fake, async () => {
    await repo.record({ paymentId: 'PAY-1', kind: 'raised' });
    assert.deepEqual(fake.q[0].params, ['PAY-1', '', 'raised', '', '', '', '', '{}']);
    await repo.record({ paymentId: 'PAY-1', kind: 'done', detail: 'not an object' });
    assert.equal(fake.q[1].params[7], '{}');
  });
});

test('record(): an unknown kind is refused with null before the pool is touched', async () => {
  const fake = fakePg();
  await withPool(fake, async () => {
    assert.equal(await repo.record({ paymentId: 'PAY-1', kind: 'paid' }), null);
    assert.equal(await repo.record({ paymentId: 'PAY-1', kind: '' }), null);
    assert.equal(await repo.record({ paymentId: 'PAY-1' }), null);
    assert.equal(await repo.record({ kind: 'raised' }), null, 'no payment id');
    assert.equal(await repo.record(undefined), null);
    assert.equal(fake.q.length, 0);
  });
});

test('record() fails OPEN: a PG error returns null and never throws', async () => {
  await withPool(fakePg(), async () => {
    assert.equal(await repo.record({ paymentId: 'PAY-1', kind: 'raised' }), null);
  }, { throwOn: 'pg down' });
});

test('PG off: every read and write returns its neutral value without touching the pool', async () => {
  await withPoolOff(async (touched) => {
    assert.equal(await repo.record({ paymentId: 'PAY-1', kind: 'raised' }), null);
    assert.deepEqual(await repo.forPayment('PAY-1'), []);
    assert.deepEqual(await repo.financeCardsFor('PAY-1'), []);
    assert.equal(await repo.lastKindAt('PAY-1', 'finance_card_sent'), null);
    assert.equal(touched(), 0);
  });
});

test('forPayment(): the trail in time order, rows shaped (Date → ISO, detail → object)', async () => {
  const fake = fakePg(() => [
    { id: '1', at: new Date('2026-09-09T10:00:00Z'), payment_id: 'PAY-1', kind: 'raised', detail: { a: 1 } },
    { id: '2', at: new Date('2026-09-09T10:05:00Z'), payment_id: 'PAY-1', kind: 'signed', detail: '{"b":2}' },
    { id: '3', at: new Date('2026-09-09T10:06:00Z'), payment_id: 'PAY-1', kind: 'approved', detail: null },
  ]);
  await withPool(fake, async () => {
    const rows = await repo.forPayment('PAY-1');
    assert.deepEqual(rows.map((r) => [r.id, r.at, r.kind, r.detail]), [
      [1, '2026-09-09T10:00:00.000Z', 'raised', { a: 1 }],
      [2, '2026-09-09T10:05:00.000Z', 'signed', { b: 2 }],
      [3, '2026-09-09T10:06:00.000Z', 'approved', {}],
    ]);
    assert.match(fake.q[0].text, /FROM payment_events\s+WHERE payment_id = \$1\s+ORDER BY at ASC, id ASC/);
    assert.deepEqual(fake.q[0].params, ['PAY-1']);
  });
  await withPool(fakePg(), async () => {
    assert.deepEqual(await repo.forPayment('PAY-1'), [], 'fail open');
  }, { throwOn: 'pg down' });
});

test('financeCardsFor(): card + reminder rows with ids only, deduped, as strings', async () => {
  const fake = fakePg(() => [
    { chat_id: '111', message_id: '5' },
    { chat_id: '222', message_id: '9' },
    { chat_id: '111', message_id: '5' },
  ]);
  await withPool(fake, async () => {
    const cards = await repo.financeCardsFor('PAY-1');
    assert.deepEqual(cards, [{ chat_id: '111', message_id: '5' }, { chat_id: '222', message_id: '9' }]);
    const sql = fake.q[0].text;
    assert.match(sql, /kind IN \('finance_card_sent', 'reminder_sent'\)/);
    assert.match(sql, /chat_id <> '' AND message_id <> ''/);
    assert.deepEqual(fake.q[0].params, ['PAY-1']);
  });
  await withPool(fakePg(), async () => {
    assert.deepEqual(await repo.financeCardsFor('PAY-1'), [], 'fail open');
  }, { throwOn: 'pg down' });
});

test('lastKindAt(): ISO string of the latest event of that kind; null when none or bad kind', async () => {
  const fake = fakePg((text, params) => (params[1] === 'finance_card_sent'
    ? [{ at: new Date('2026-09-09T11:00:00Z') }] : [{ at: null }]));
  await withPool(fake, async () => {
    assert.equal(await repo.lastKindAt('PAY-1', 'finance_card_sent'), '2026-09-09T11:00:00.000Z');
    assert.match(fake.q[0].text, /SELECT MAX\(at\) AS at FROM payment_events\s+WHERE payment_id = \$1 AND kind = \$2/);
    assert.deepEqual(fake.q[0].params, ['PAY-1', 'finance_card_sent']);
    assert.equal(await repo.lastKindAt('PAY-1', 'reminder_sent'), null, 'no such event yet');
    assert.equal(await repo.lastKindAt('PAY-1', 'paid'), null, 'bad kind');
    assert.equal(fake.q.length, 2, 'bad kind never reached the pool');
  });
  await withPool(fakePg(), async () => {
    assert.equal(await repo.lastKindAt('PAY-1', 'done'), null, 'fail open');
  }, { throwOn: 'pg down' });
});
