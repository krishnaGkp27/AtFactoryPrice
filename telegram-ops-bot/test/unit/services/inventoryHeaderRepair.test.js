'use strict';

/**
 * INV-HDR1 — the guarded one-off that clears the two orphan Inventory
 * headers (X1 `prev_state`, Y1 `state_since`) left behind by the reverted
 * 480d46e. Owner-approved 03-Aug-2026.
 *
 * The whole value of this repair is what it REFUSES to do, so most of these
 * tests are about the guards.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const repair = require(path.join(SRC, 'services/inventoryHeaderRepair'));

const BASE_23 = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status',
  'Warehouse', 'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight',
  'UpdatedAt', 'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch',
  'design_category'];

function withSheet({ header, xyRows = [], readThrows = false }, fn) {
  const orig = { read: sheets.readRange, update: sheets.updateRange };
  const origAudit = auditLogRepository.append;
  const writes = [];
  const audits = [];
  sheets.readRange = async (sheet, range) => {
    if (readThrows) throw new Error('Sheets unreachable');
    if (range.startsWith('A1')) return [header];
    if (range.startsWith('X2')) return xyRows;
    return [];
  };
  sheets.updateRange = async (sheet, range, values) => { writes.push({ sheet, range, values }); };
  auditLogRepository.append = async (evt, payload) => { audits.push({ evt, payload }); };
  return Promise.resolve(fn(writes, audits)).finally(() => {
    sheets.readRange = orig.read; sheets.updateRange = orig.update;
    auditLogRepository.append = origAudit;
  });
}

test('clears X1:Y1 when the orphans are there and both columns are empty', async () => {
  await withSheet({ header: [...BASE_23, 'prev_state', 'state_since'], xyRows: [['', ''], ['', '']] },
    async (writes, audits) => {
      const res = await repair.repair(null);
      assert.equal(res.cleared, true);
      assert.equal(writes.length, 1, 'exactly one write');
      assert.equal(writes[0].range, 'X1:Y1', 'only the two header cells');
      assert.deepEqual(writes[0].values, [['', '']]);
      assert.equal(audits[0].evt, 'inventory.header_repaired');
    });
});

test('REFUSES when any cell under the columns holds data', async () => {
  await withSheet({
    header: [...BASE_23, 'prev_state', 'state_since'],
    xyRows: [['', ''], ['available @ IDUMOTA', '2026-08-02'], ['', '']],
  }, async (writes) => {
    const res = await repair.repair(null);
    assert.equal(res.cleared, false);
    assert.equal(res.dataCells, 2, 'counts what it found');
    assert.match(res.reason, /hold data/);
    assert.equal(writes.length, 0, 'nothing written');
  });
});

test('REFUSES when the headers are something else — those columns belong to someone', async () => {
  await withSheet({ header: [...BASE_23, 'landed_cost', 'supplier_ref'], xyRows: [] },
    async (writes) => {
      const res = await repair.repair(null);
      assert.equal(res.cleared, false);
      assert.match(res.reason, /no orphan headers/);
      assert.equal(writes.length, 0);
    });
});

test('REFUSES when something was added after the orphans', async () => {
  await withSheet({ header: [...BASE_23, 'prev_state', 'state_since', 'something_new'], xyRows: [] },
    async (writes) => {
      const res = await repair.repair(null);
      assert.equal(res.cleared, false);
      assert.match(res.reason, /refusing/);
      assert.equal(writes.length, 0);
    });
});

test('REFUSES when the emptiness check cannot be made', async () => {
  const orig = { read: sheets.readRange, update: sheets.updateRange };
  const writes = [];
  sheets.readRange = async (sheet, range) => {
    if (range.startsWith('A1')) return [[...BASE_23, 'prev_state', 'state_since']];
    throw new Error('range read failed');
  };
  sheets.updateRange = async (s2, range, values) => { writes.push({ range, values }); };
  try {
    const res = await repair.repair(null);
    assert.equal(res.cleared, false);
    assert.match(res.reason, /could not verify/);
    assert.equal(writes.length, 0, 'never clears on an unverified sheet');
  } finally {
    sheets.readRange = orig.read; sheets.updateRange = orig.update;
  }
});

test('is a no-op on a clean sheet, so it is safe to leave wired', async () => {
  await withSheet({ header: BASE_23, xyRows: [] }, async (writes) => {
    const res = await repair.repair(null);
    assert.equal(res.cleared, false);
    assert.equal(writes.length, 0);
    // And a second run behaves identically — idempotent.
    const again = await repair.repair(null);
    assert.equal(again.cleared, false);
    assert.equal(writes.length, 0);
  });
});

test('survives an unreadable sheet without throwing', async () => {
  await withSheet({ header: [], readThrows: true }, async (writes) => {
    const res = await repair.repair(null);
    assert.equal(res.cleared, false);
    assert.match(res.reason, /header read failed/);
    assert.equal(writes.length, 0);
  });
});
