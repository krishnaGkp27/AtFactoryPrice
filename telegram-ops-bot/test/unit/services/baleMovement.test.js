'use strict';

/**
 * BMV-1 (owner, 03-Aug-2026) — the bale's movement memory.
 *
 * "I want maximum 2 attributes saved in inventory sheet: the previous state
 *  with the timestamp it started transition. Any further rollover will
 *  update those 2 fields, with the current state logged at proper place."
 *  → the log is the existing AuditLog sheet (owner's ruling).
 *
 * So the ROW holds ONE hop:
 *   X prev_state   "<status> @ <warehouse it was in / came from>"
 *   Y state_since  the BUSINESS date the current state began
 * and every transition appends one `bale.moved` row per BALE to AuditLog.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const inventoryRepo = require(path.join(SRC, 'repositories/inventoryRepository'));
const movement = require(path.join(SRC, 'services/baleMovementLog'));

/** Inventory columns A..Y; only the read ones matter here. */
function invRow(pkg, thanNo, status, wh, extra = {}) {
  return [pkg, '', '', extra.design || 'Rose', extra.shade || 'Red', String(thanNo), '30',
    status, wh, '100', '2026-01-01', extra.soldTo || '', extra.soldDate || '', '', '', '',
    'fabric', `BAL-${pkg}-${thanNo}`, '2026-01-01', '', '', extra.batch || 'Jul26', '',
    extra.prevState || '', extra.stateSince || ''];
}

/** Capture every sheet write + AuditLog append for one call. */
function withSheet(rows, fn) {
  const orig = {
    read: sheets.readRange, update: sheets.updateRange,
    batch: sheets.batchUpdateRanges, append: sheets.appendRows,
  };
  const writes = [];
  const logged = [];
  sheets.readRange = async () => rows.map((r) => [...r]);
  sheets.updateRange = async (sheet, range, values) => { writes.push({ sheet, range, values }); };
  sheets.batchUpdateRanges = async (sheet, updates) => {
    (updates || []).forEach((u) => writes.push({ sheet, ...u }));
  };
  sheets.appendRows = async (sheet, rs) => {
    if (sheet === 'AuditLog') (rs || []).forEach((r) => logged.push({ type: r[1], payload: JSON.parse(r[2]), user: r[3] }));
    else (rs || []).forEach((r) => writes.push({ sheet, appended: r }));
  };
  inventoryRepo.invalidateCache();
  return Promise.resolve(fn(writes, logged)).finally(() => {
    sheets.readRange = orig.read; sheets.updateRange = orig.update;
    sheets.batchUpdateRanges = orig.batch; sheets.appendRows = orig.append;
    inventoryRepo.invalidateCache();
  });
}

const pair = (writes) => writes.filter((w) => /^X\d+:Y\d+$/.test(w.range || ''));

/* ── the label grammar ─────────────────────────────────────────────── */

test('prev_state carries the state AND the warehouse it was in', () => {
  assert.equal(movement.stateLabel('available', 'IDUMOTA'), 'available @ IDUMOTA');
  assert.equal(movement.stateLabel('sold', ''), 'sold');
});

test('state_since is a business DAY, never a machine timestamp', () => {
  assert.equal(movement.businessDay('2026-08-02'), '2026-08-02');
  assert.equal(movement.businessDay('2026-08-02T11:22:33.000Z'), '2026-08-02');
  assert.match(movement.businessDay(''), /^\d{4}-\d{2}-\d{2}$/, 'falls back to today');
});

test('pairFor can override the warehouse — an in-transit row holds the DESTINATION', () => {
  const row = { status: 'in_transit', warehouse: 'Kano office' };
  const p = movement.pairFor(row, { on: '2026-08-04', fromWarehouse: 'IDUMOTA' });
  assert.equal(p.prevState, 'in_transit @ IDUMOTA', 'the origin survives the arrival');
  assert.equal(p.stateSince, '2026-08-04');
});

/* ── every transition stamps the pair and logs the hop ─────────────── */

test('dispatch: prev_state remembers the source, state_since is the departure day', async () => {
  await withSheet([invRow('869', 1, 'available', 'IDUMOTA'), invRow('869', 2, 'available', 'IDUMOTA')],
    async (writes, logged) => {
      const moved = await inventoryRepo.transitionBales(['869'], 'available', 'in_transit', 'Kano office', {
        on: '2026-08-02', fromWarehouse: 'IDUMOTA', kind: 'dispatch', ref: 'TR-20260802-001', user: 'abdul',
      });
      assert.equal(moved.length, 2, 'both thans moved');
      const pairs = pair(writes);
      assert.equal(pairs.length, 2, 'one X:Y write per row');
      assert.deepEqual(pairs[0].values[0], ['available @ IDUMOTA', '2026-08-02']);
      // One log row per BALE, not per than.
      assert.equal(logged.length, 1, 'one bale.moved row for the bale');
      assert.equal(logged[0].type, 'bale.moved');
      assert.deepEqual(
        { bale: logged[0].payload.bale, from: logged[0].payload.from, to: logged[0].payload.to, on: logged[0].payload.on, kind: logged[0].payload.kind, thans: logged[0].payload.thans },
        { bale: '869', from: 'available @ IDUMOTA', to: 'in_transit @ Kano office', on: '2026-08-02', kind: 'dispatch', thans: 2 },
      );
      assert.equal(logged[0].payload.ref, 'TR-20260802-001');
      assert.equal(logged[0].user, 'abdul');
    });
});

test('receive: the ORIGIN is still visible on the row after arrival', async () => {
  await withSheet([invRow('869', 1, 'in_transit', 'Kano office')], async (writes, logged) => {
    await inventoryRepo.transitionBales(['869'], 'in_transit', 'available', null, {
      on: '2026-08-04', fromWarehouse: 'IDUMOTA', kind: 'receive', ref: 'TR-20260802-001',
    });
    assert.deepEqual(pair(writes)[0].values[0], ['in_transit @ IDUMOTA', '2026-08-04']);
    assert.equal(logged[0].payload.to, 'available @ Kano office');
    assert.equal(logged[0].payload.kind, 'receive');
  });
});

test('sale: prev_state is where it was sold from, state_since is the sale date', async () => {
  await withSheet([invRow('1057', 1, 'available', 'Kano office')], async (writes, logged) => {
    const res = await inventoryRepo.markThanSold('1057', 1, 'OKESON', '2026-07-22');
    assert.ok(res);
    assert.deepEqual(pair(writes)[0].values[0], ['available @ Kano office', '2026-07-22']);
    assert.equal(logged[0].payload.kind, 'sale');
    assert.equal(logged[0].payload.to, 'sold @ Kano office');
    assert.equal(logged[0].payload.ref, 'OKESON');
  });
});

test('whole-bale sale logs ONE row carrying the than count', async () => {
  await withSheet([
    invRow('1062', 1, 'available', 'Kano office'),
    invRow('1062', 2, 'available', 'Kano office'),
    invRow('1062', 3, 'available', 'Kano office'),
  ], async (writes, logged) => {
    const res = await inventoryRepo.markPackageSold('1062', 'CJE', '2026-07-25');
    assert.equal(res.length, 3);
    assert.equal(pair(writes).length, 3, 'every than row keeps its own pair');
    assert.equal(logged.length, 1, 'one log row for the bale');
    assert.equal(logged[0].payload.thans, 3);
    assert.deepEqual(logged[0].payload.thanNos, [1, 2, 3]);
  });
});

test('return: sold → available is logged as a return, not a movement', async () => {
  await withSheet([invRow('1057', 1, 'sold', 'Kano office', { soldTo: 'OKESON', soldDate: '2026-07-22' })],
    async (writes, logged) => {
      const res = await inventoryRepo.markThanAvailable('1057', 1, { on: '2026-07-30' });
      assert.ok(res);
      assert.deepEqual(pair(writes)[0].values[0], ['sold @ Kano office', '2026-07-30']);
      assert.equal(logged[0].payload.kind, 'return');
      assert.equal(logged[0].payload.ref, 'OKESON', 'the buyer it came back from');
    });
});

test('a rollover REPLACES the pair — the row keeps one hop, the log keeps the chain', async () => {
  // The row already carries a dispatch pair; receiving must overwrite it.
  await withSheet([invRow('869', 1, 'in_transit', 'Kano office',
    { prevState: 'available @ IDUMOTA', stateSince: '2026-08-02' })], async (writes, logged) => {
    await inventoryRepo.transitionBales(['869'], 'in_transit', 'available', null, {
      on: '2026-08-04', fromWarehouse: 'IDUMOTA', kind: 'receive',
    });
    assert.deepEqual(pair(writes)[0].values[0], ['in_transit @ IDUMOTA', '2026-08-04'],
      'the older hop is gone from the row');
    assert.equal(logged.length, 1, 'and preserved in the log instead');
  });
});

test('a failed log never undoes a physical move', async () => {
  const origAppend = sheets.appendRows;
  await withSheet([invRow('869', 1, 'available', 'IDUMOTA')], async (writes) => {
    sheets.appendRows = async () => { throw new Error('AuditLog unreachable'); };
    const moved = await inventoryRepo.transitionBales(['869'], 'available', 'in_transit', 'Kano office', {
      on: '2026-08-02', fromWarehouse: 'IDUMOTA', kind: 'dispatch',
    });
    assert.equal(moved.length, 1, 'the bale still moved');
    assert.equal(pair(writes).length, 1, 'and the row still got its pair');
  });
  sheets.appendRows = origAppend;
});

test('parseRow reads the two columns back', async () => {
  await withSheet([invRow('869', 1, 'available', 'Kano office',
    { prevState: 'in_transit @ IDUMOTA', stateSince: '2026-08-04' })], async () => {
    const all = await inventoryRepo.getAll(true);
    assert.equal(all[0].prevState, 'in_transit @ IDUMOTA');
    assert.equal(all[0].stateSince, '2026-08-04');
  });
});
