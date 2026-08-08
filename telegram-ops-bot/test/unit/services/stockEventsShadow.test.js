'use strict';

/**
 * STK-PG Phase 1 — the SHADOW stock-event ledger.
 *
 * Pinned: the sheet stays the source of truth (a PG failure never blocks
 * or undoes a mutation — fail OPEN); every engine op emits one event per
 * physical bale with the authority attached; migrations apply exactly
 * once; withTransaction commits and rolls back on one client.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const pool = require(path.join(SRC, 'db/postgresPool'));
const migrations = require(path.join(SRC, 'db/migrations'));
const stockEventsRepository = require(path.join(SRC, 'repositories/stockEventsRepository'));
const engine = require(path.join(SRC, 'services/stockEngine'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));

/** Fake ONE pooled client capturing queries; wired through the pool stubs. */
function fakePg() {
  const q = [];
  const client = { query: async (text, params) => { q.push({ text: String(text).trim(), params }); return { rows: [] }; } };
  return { q, client };
}

function withPool(fake, fn) {
  const orig = { enabled: pool.isEnabled, query: pool.query, tx: pool.withTransaction };
  pool.isEnabled = () => true;
  pool.query = async (text, params) => { fake.q.push({ text: String(text).trim(), params }); return { rows: [] }; };
  pool.withTransaction = async (cb) => cb(fake.client);
  return Promise.resolve(fn()).finally(() => {
    pool.isEnabled = orig.enabled; pool.query = orig.query; pool.withTransaction = orig.tx;
  });
}

test('record(): one event per PHYSICAL bale, buyers and containers intact', async () => {
  const fake = fakePg();
  await withPool(fake, async () => {
    const rows = [
      { packageNo: '869', design: '9060-A', shade: '01', arrivalBatch: 'Jul26', warehouse: 'IDUMOTA', thanNo: 1 },
      { packageNo: '869', design: '9060-A', shade: '01', arrivalBatch: 'Jul26', warehouse: 'IDUMOTA', thanNo: 2 },
      { packageNo: '869', design: '9060-A', shade: '01', arrivalBatch: 'Mar26', warehouse: 'IDUMOTA', thanNo: 1 },
    ];
    const n = await stockEventsRepository.record(rows, {
      event: 'sale', customer: 'OKSON', authority: 'approval',
      approvalId: 'REQ-1', actor: '777', businessDay: '2026-08-07',
    });
    assert.equal(n, 2, 'two containers = two physical bales = two events');
    const inserts = fake.q.filter((x) => /INSERT INTO stock_events/.test(x.text));
    assert.equal(inserts.length, 2);
    const jul = inserts.find((x) => x.params[4] === 'Jul26');
    assert.equal(jul.params[0], '2026-08-07');
    assert.equal(jul.params[1], 'sale');
    assert.equal(jul.params[8], 2, 'Jul26 bale carries its 2 thans');
    assert.equal(jul.params[9], 'OKSON');
    assert.equal(jul.params[11], 'REQ-1');
  });
});

test('record() fails OPEN: a PG error returns 0 and never throws', async () => {
  const orig = { enabled: pool.isEnabled, tx: pool.withTransaction };
  pool.isEnabled = () => true;
  pool.withTransaction = async () => { throw new Error('pg down'); };
  try {
    const n = await stockEventsRepository.record(
      [{ packageNo: '869', design: 'X', arrivalBatch: '' }],
      { event: 'sale', authority: 'admin' });
    assert.equal(n, 0, 'shadow write reports 0, the sheet write already stood');
  } finally {
    pool.isEnabled = orig.enabled; pool.withTransaction = orig.tx;
  }
});

test('engine ops emit shadow events; PG-off is a silent no-op', async () => {
  const events = [];
  const origRecord = stockEventsRepository.record;
  const origMark = inventoryRepository.markPackageAvailable;
  stockEventsRepository.record = async (rows, meta) => { events.push({ rows, meta }); return rows.length; };
  inventoryRepository.markPackageAvailable = async () => [
    { packageNo: '869', design: '9060-A', arrivalBatch: 'Jul26', warehouse: 'IDUMOTA', soldToPrior: 'ALPHA' },
    { packageNo: '869', design: '9060-A', arrivalBatch: 'Jul26', warehouse: 'IDUMOTA', soldToPrior: 'BETA' },
  ];
  try {
    await engine.returnPackage('869', { on: '2026-08-07' }, { event: 'correction', adminId: '777' });
    assert.equal(events.length, 2, 'one shadow event per BUYER');
    assert.deepEqual(events.map((e) => e.meta.customer).sort(), ['ALPHA', 'BETA']);
    assert.ok(events.every((e) => e.meta.event === 'correction'));
    assert.ok(events.every((e) => e.meta.authority === 'admin'));
    assert.ok(events.every((e) => e.meta.businessDay === '2026-08-07'));
  } finally {
    stockEventsRepository.record = origRecord;
    inventoryRepository.markPackageAvailable = origMark;
  }
});

test('a shadow failure never disturbs the mutation result', async () => {
  const origRecord = stockEventsRepository.record;
  const origMark = inventoryRepository.markThanAvailable;
  stockEventsRepository.record = async () => { throw new Error('boom'); };
  inventoryRepository.markThanAvailable = async () => ({ packageNo: '869', design: 'X', soldToPrior: 'A' });
  try {
    const out = await engine.returnThan('869', 1, {}, { event: 'return', adminId: '777' });
    assert.equal(out.packageNo, '869', 'the real result comes back untouched');
  } finally {
    stockEventsRepository.record = origRecord;
    inventoryRepository.markThanAvailable = origMark;
  }
});

test('migrations apply once, in order, inside transactions', async () => {
  const fake = fakePg();
  await withPool(fake, async () => {
    const out = await migrations.migrate();
    assert.equal(out.applied.length, migrations._internals.MIGRATIONS.length, 'fresh db applies all');
    const marker = fake.q.find((x) => /INSERT INTO schema_migrations/.test(x.text));
    assert.equal(marker.params[0], '001_stock_events');
  });
  // Already-applied run: SELECT returns the ids → nothing re-applies.
  const fake2 = fakePg();
  const orig = { enabled: pool.isEnabled, query: pool.query, tx: pool.withTransaction };
  pool.isEnabled = () => true;
  pool.query = async (text) => (/SELECT id FROM schema_migrations/.test(String(text))
    ? { rows: migrations._internals.MIGRATIONS.map((m) => ({ id: m.id })) }
    : { rows: [] });
  pool.withTransaction = async (cb) => cb(fake2.client);
  try {
    const out2 = await migrations.migrate();
    assert.deepEqual(out2.applied, [], 'nothing re-applies');
    assert.equal(fake2.q.length, 0, 'no migration SQL touched the db');
  } finally {
    pool.isEnabled = orig.enabled; pool.query = orig.query; pool.withTransaction = orig.tx;
  }
});

test('withTransaction commits on success and rolls back on throw', async () => {
  const seq = [];
  const client = { query: async (t) => { seq.push(String(t).split(' ')[0]); return { rows: [] }; }, release: () => seq.push('RELEASE') };
  const origGet = pool.getPool;
  pool.getPool = () => ({ connect: async () => client });
  try {
    await pool.withTransaction(async (c) => c.query('INSERT x'));
    assert.deepEqual(seq, ['BEGIN', 'INSERT', 'COMMIT', 'RELEASE']);
    seq.length = 0;
    await assert.rejects(() => pool.withTransaction(async () => { throw new Error('nope'); }), /nope/);
    assert.deepEqual(seq, ['BEGIN', 'ROLLBACK', 'RELEASE'], 'rolled back and released');
  } finally {
    pool.getPool = origGet;
  }
});
