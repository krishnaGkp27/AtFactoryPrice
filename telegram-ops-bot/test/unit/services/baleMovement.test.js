'use strict';

/**
 * BMV-1 (owner, 03-Aug-2026) — bale state history in its OWN sheet.
 *
 * "Please don't add any unnecessary columns in inventory sheet, but you can
 *  add in different sheet."
 *
 * So Inventory is untouched — its Status + Warehouse remain the current
 * truth — and every state change appends one row per BALE to the
 * **BaleMovements** sheet, which answers the two things Inventory never
 * could: *since when*, and *what came before*. The `Current` flag rides the
 * newest row of each bale, so "what is on the road and since when" is a
 * one-filter answer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const inventoryRepo = require(path.join(SRC, 'repositories/inventoryRepository'));
const movementsRepo = require(path.join(SRC, 'repositories/baleMovementsRepository'));
const movement = require(path.join(SRC, 'services/baleMovementLog'));

/** Inventory columns A..W — the schema BMV-1 must leave alone. */
function invRow(pkg, thanNo, status, wh, extra = {}) {
  return [pkg, '', '', extra.design || 'Rose', extra.shade || 'Red', String(thanNo), '30',
    status, wh, '100', '2026-01-01', extra.soldTo || '', extra.soldDate || '', '', '', '',
    'fabric', `BAL-${pkg}-${thanNo}`, '2026-01-01', '', '', extra.batch || 'Jul26', ''];
}

/** Fake both sheets: Inventory rows in, movement rows captured. */
function withSheets(invRows, movementRows, fn) {
  const orig = {
    read: sheets.readRange, update: sheets.updateRange,
    batch: sheets.batchUpdateRanges, append: sheets.appendRows,
  };
  const invWrites = [];
  const moved = [];
  const flagClears = [];
  const store = (movementRows || []).map((r) => [...r]);
  sheets.readRange = async (sheet, range) => {
    if (sheet === 'BaleMovements') return range.startsWith('A1') ? [movementsRepo.HEADERS] : store.map((r) => [...r]);
    return invRows.map((r) => [...r]);
  };
  sheets.updateRange = async (sheet, range, values) => {
    if (sheet === 'Inventory') invWrites.push({ range, values });
  };
  sheets.batchUpdateRanges = async (sheet, updates) => {
    if (sheet === 'Inventory') (updates || []).forEach((u) => invWrites.push(u));
    else (updates || []).forEach((u) => flagClears.push(u));
  };
  sheets.appendRows = async (sheet, rows) => {
    if (sheet === 'BaleMovements') (rows || []).forEach((r) => moved.push(movementsRepo._internals.parseRow(r, store.push(r) + 1)));
  };
  inventoryRepo.invalidateCache();
  return Promise.resolve(fn({ invWrites, moved, flagClears })).finally(() => {
    sheets.readRange = orig.read; sheets.updateRange = orig.update;
    sheets.batchUpdateRanges = orig.batch; sheets.appendRows = orig.append;
    inventoryRepo.invalidateCache();
  });
}

/* ── the Inventory sheet keeps its shape ───────────────────────────── */

test('BMV-1 adds NO columns to Inventory', () => {
  assert.equal(inventoryRepo.HEADERS.length, 23, 'Inventory stays A..W');
  assert.equal(inventoryRepo.HEADERS[inventoryRepo.HEADERS.length - 1], 'design_category');
  assert.ok(!inventoryRepo.HEADERS.includes('prev_state'));
  assert.ok(!inventoryRepo.HEADERS.includes('state_since'));
});

/* ── the label grammar ─────────────────────────────────────────────── */

test('a state label carries the state AND the warehouse', () => {
  assert.equal(movement.stateLabel('available', 'IDUMOTA'), 'available @ IDUMOTA');
  assert.equal(movement.stateLabel('sold', ''), 'sold');
});

test('MovedOn is a business DAY, never a machine timestamp', () => {
  assert.equal(movement.businessDay('2026-08-02'), '2026-08-02');
  assert.equal(movement.businessDay('2026-08-02T11:22:33.000Z'), '2026-08-02');
  assert.match(movement.businessDay(''), /^\d{4}-\d{2}-\d{2}$/, 'falls back to today');
});

/* ── every transition writes a movement row ────────────────────────── */

test('dispatch: one row per BALE, from-state remembers the source', async () => {
  await withSheets([invRow('869', 1, 'available', 'IDUMOTA'), invRow('869', 2, 'available', 'IDUMOTA')], [],
    async ({ invWrites, moved }) => {
      const res = await inventoryRepo.transitionBales(['869'], 'available', 'in_transit', 'Kano office', {
        on: '2026-08-02', fromWarehouse: 'IDUMOTA', kind: 'dispatch', ref: 'TR-20260802-001', user: 'abdul',
      });
      assert.equal(res.length, 2, 'both thans moved');
      // Inventory took only its usual writes — no new columns.
      assert.ok(invWrites.every((w) => /^[HIP]\d+$/.test(w.range)), `only H/I/P touched, got ${invWrites.map((w) => w.range)}`);
      assert.equal(moved.length, 1, 'one movement row for the bale, not per than');
      assert.deepEqual(
        { bale: moved[0].baleNo, from: moved[0].fromState, to: moved[0].toState, on: moved[0].movedOn, kind: moved[0].kind, thans: moved[0].thans },
        { bale: '869', from: 'available @ IDUMOTA', to: 'in_transit @ Kano office', on: '2026-08-02', kind: 'dispatch', thans: 2 },
      );
      assert.equal(moved[0].ref, 'TR-20260802-001');
      assert.equal(moved[0].user, 'abdul');
      assert.equal(moved[0].current, true, 'the new row is the current one');
      assert.equal(moved[0].container, 'Jul26');
    });
});

test('receive: the ORIGIN stays readable after arrival', async () => {
  await withSheets([invRow('869', 1, 'in_transit', 'Kano office')], [], async ({ moved }) => {
    await inventoryRepo.transitionBales(['869'], 'in_transit', 'available', null, {
      on: '2026-08-04', fromWarehouse: 'IDUMOTA', kind: 'receive', ref: 'TR-20260802-001',
    });
    assert.equal(moved[0].fromState, 'in_transit @ IDUMOTA', 'not the destination it was rewritten to');
    assert.equal(moved[0].toState, 'available @ Kano office');
    assert.equal(moved[0].kind, 'receive');
  });
});

test('sale: from-state is where it sold from, MovedOn is the sale date', async () => {
  await withSheets([invRow('1057', 1, 'available', 'Kano office')], [], async ({ moved }) => {
    const res = await inventoryRepo.markThanSold('1057', 1, 'OKESON', '2026-07-22');
    assert.ok(res);
    assert.equal(moved[0].fromState, 'available @ Kano office');
    assert.equal(moved[0].toState, 'sold @ Kano office');
    assert.equal(moved[0].movedOn, '2026-07-22');
    assert.equal(moved[0].kind, 'sale');
    assert.equal(moved[0].ref, 'OKESON');
  });
});

test('whole-bale sale logs ONE row carrying the than count', async () => {
  await withSheets([
    invRow('1062', 1, 'available', 'Kano office'),
    invRow('1062', 2, 'available', 'Kano office'),
    invRow('1062', 3, 'available', 'Kano office'),
  ], [], async ({ moved }) => {
    const res = await inventoryRepo.markPackageSold('1062', 'CJE', '2026-07-25');
    assert.equal(res.length, 3);
    assert.equal(moved.length, 1, 'one row for the bale');
    assert.equal(moved[0].thans, 3);
  });
});

test('return: sold → available is logged as a return', async () => {
  await withSheets([invRow('1057', 1, 'sold', 'Kano office', { soldTo: 'OKESON', soldDate: '2026-07-22' })], [],
    async ({ moved }) => {
      const res = await inventoryRepo.markThanAvailable('1057', 1, { on: '2026-07-30' });
      assert.ok(res);
      assert.equal(moved[0].fromState, 'sold @ Kano office');
      assert.equal(moved[0].kind, 'return');
      assert.equal(moved[0].ref, 'OKESON', 'the buyer it came back from');
      assert.equal(moved[0].movedOn, '2026-07-30');
    });
});

/* ── the Current flag ──────────────────────────────────────────────── */

test('a new movement clears the bale\'s previous Current flag', async () => {
  const prior = [['2026-08-02T00:00:00.000Z', '2026-08-02', '869', 'Rose', 'Red', 'Jul26', 2,
    'available @ IDUMOTA', 'in_transit @ Kano office', 'dispatch', 'TR-1', 'abdul', 'YES']];
  await withSheets([invRow('869', 1, 'in_transit', 'Kano office')], prior, async ({ moved, flagClears }) => {
    await inventoryRepo.transitionBales(['869'], 'in_transit', 'available', null, {
      on: '2026-08-04', fromWarehouse: 'IDUMOTA', kind: 'receive',
    });
    assert.equal(flagClears.length, 1, 'the old row is un-flagged');
    assert.match(flagClears[0].range, /^M2:M2$/, 'the Current cell of the prior row');
    assert.deepEqual(flagClears[0].values, [['']]);
    assert.equal(moved[0].current, true, 'the new row takes the flag');
  });
});

test('a re-used bale number in another container keeps its own flag', async () => {
  // Mar26 bale 869 is current; a Jul26 bale 869 moving must not clear it.
  const prior = [['2026-03-02T00:00:00.000Z', '2026-03-02', '869', 'Rose', 'Red', 'Mar26', 1,
    'available @ Lagos', 'sold @ Lagos', 'sale', 'X', 'u', 'YES']];
  await withSheets([invRow('869', 1, 'available', 'IDUMOTA', { batch: 'Jul26' })], prior,
    async ({ flagClears }) => {
      await inventoryRepo.transitionBales(['869'], 'available', 'in_transit', 'Kano office', {
        on: '2026-08-02', fromWarehouse: 'IDUMOTA', kind: 'dispatch',
      });
      assert.equal(flagClears.length, 0, 'the Mar26 bale is a different physical bale');
    });
});

/* ── failure containment ───────────────────────────────────────────── */

test('a failed movement write never undoes a physical move', async () => {
  const origAppend = sheets.appendRows;
  await withSheets([invRow('869', 1, 'available', 'IDUMOTA')], [], async ({ invWrites }) => {
    sheets.appendRows = async () => { throw new Error('BaleMovements unreachable'); };
    const res = await inventoryRepo.transitionBales(['869'], 'available', 'in_transit', 'Kano office', {
      on: '2026-08-02', fromWarehouse: 'IDUMOTA', kind: 'dispatch',
    });
    assert.equal(res.length, 1, 'the bale still moved');
    assert.ok(invWrites.length >= 2, 'and Inventory still got its status write');
  });
  sheets.appendRows = origAppend;
});

test('intake writes no movement row — it is a birth, not a transition', async () => {
  await withSheets([], [], async ({ moved }) => {
    await inventoryRepo.appendBale([{
      packageNo: '900', design: 'Rose', shade: 'Red', thanNo: 1,
      yards: 30, warehouse: 'IDUMOTA', dateReceived: '2026-07-12',
    }]);
    assert.equal(moved.length, 0, 'GoodsReceipts is already the intake record');
  });
});

/* ── reading it back ───────────────────────────────────────────────── */

test('historyFor returns a bale\'s whole chain', async () => {
  const rows = [
    ['t1', '2026-08-02', '869', 'Rose', 'Red', 'Jul26', 2, 'available @ IDUMOTA', 'in_transit @ Kano office', 'dispatch', 'TR-1', 'abdul', ''],
    ['t2', '2026-08-04', '869', 'Rose', 'Red', 'Jul26', 2, 'in_transit @ IDUMOTA', 'available @ Kano office', 'receive', 'TR-1', 'musa', 'YES'],
    ['t3', '2026-08-05', '870', 'Rose', 'Red', 'Jul26', 1, 'available @ Lagos', 'sold @ Lagos', 'sale', 'CJE', 'x', 'YES'],
  ];
  await withSheets([], rows, async () => {
    const hist = await movementsRepo.historyFor('869');
    assert.equal(hist.length, 2, 'both hops, and only this bale');
    assert.deepEqual(hist.map((h) => h.kind), ['dispatch', 'receive']);
    const current = await movementsRepo.currentRows();
    assert.equal(current.length, 2, 'one current row per bale');
  });
});

/* ── defects found by the BMV-1b adversarial review ────────────────── */

test('REVIEW-1: two same-numbered bales from different containers each get their own row', async () => {
  // §5 permits a printed number to be re-used across arrivals. Grouping on
  // design|number alone collapsed them into ONE row: the second bale got no
  // row and kept a stale Current flag, and Thans was inflated.
  await withSheets([
    invRow('869', 1, 'available', 'IDUMOTA', { batch: 'Mar26' }),
    invRow('869', 2, 'available', 'IDUMOTA', { batch: 'Mar26' }),
    invRow('869', 1, 'available', 'IDUMOTA', { batch: 'Jul26' }),
  ], [], async ({ moved }) => {
    await inventoryRepo.transitionBales(['869'], 'available', 'in_transit', 'Kano office', {
      on: '2026-08-02', fromWarehouse: 'IDUMOTA', kind: 'dispatch', ref: 'TR-1',
    });
    assert.equal(moved.length, 2, 'one row per PHYSICAL bale');
    const byContainer = Object.fromEntries(moved.map((m) => [m.container, m]));
    assert.equal(byContainer.Mar26.thans, 2, 'Mar26 keeps its own than count');
    assert.equal(byContainer.Jul26.thans, 1, 'Jul26 is not folded into it');
  });
});

test('REVIEW-2: an unscoped batch logs each bale at ITS OWN warehouse', async () => {
  // /revert_packages 870 takes no warehouse: the same printed number can be
  // sold in two stores. Deriving one warehouse from the first row filed the
  // Kano bale's return under Lagos.
  await withSheets([
    invRow('870', 1, 'sold', 'Kano office', { batch: 'Mar26', soldTo: 'ALPHA', soldDate: '2026-07-01' }),
    invRow('870', 1, 'sold', 'Lagos office', { batch: 'Jul26', soldTo: 'BETA', soldDate: '2026-07-02' }),
  ], [], async ({ moved }) => {
    const res = await inventoryRepo.markPackageAvailable('870', { on: '2026-08-03' });
    assert.equal(res.length, 2, 'both flipped in Inventory');
    assert.equal(moved.length, 2, 'and both logged');
    const states = moved.map((m) => `${m.fromState} → ${m.toState}`).sort();
    assert.deepEqual(states, [
      'sold @ Kano office → available @ Kano office',
      'sold @ Lagos office → available @ Lagos office',
    ], 'neither bale is filed under the other store');
  });
});

test('REVIEW-3: movement appends are serialized so a bale cannot end with two Current rows', async () => {
  const prior = [['t', '2026-08-01', '869', 'Rose', 'Red', 'Jul26', 1,
    'available @ IDUMOTA', 'available @ IDUMOTA', 'x', '', '', 'YES']];
  await withSheets([invRow('869', 1, 'available', 'IDUMOTA')], prior, async ({ moved, flagClears }) => {
    // Two writers race; the mutex must make the second see the first's work.
    await Promise.all([
      movement.record([{ packageNo: '869', design: 'Rose', shade: 'Red', arrivalBatch: 'Jul26', warehouse: 'IDUMOTA', status: 'available', thanNo: 1 }],
        { to: 'in_transit', toWarehouse: 'Kano office', on: '2026-08-02', kind: 'dispatch' }),
      movement.record([{ packageNo: '869', design: 'Rose', shade: 'Red', arrivalBatch: 'Jul26', warehouse: 'IDUMOTA', status: 'available', thanNo: 1 }],
        { to: 'in_transit', toWarehouse: 'Kano office', on: '2026-08-02', kind: 'dispatch' }),
    ]);
    assert.equal(moved.length, 2, 'both movements recorded');
    // The second run must have found and cleared the first run's flag.
    assert.ok(flagClears.length >= 2, `each run swept the prior flag, got ${flagClears.length}`);
  });
});
