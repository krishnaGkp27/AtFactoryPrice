'use strict';

/**
 * EDB-1 — the plan is pure and the executor is exact: cell updates on the
 * rows that changed, appended rows for new thans (uid generated, intake
 * fields copied), and a refusal when the bale moved since the proposal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');

const HEADER = ['PackageNo', 'Indent', 'CSNo', 'Design', 'Shade', 'ThanNo', 'Yards', 'Status', 'Warehouse',
  'PricePerYard', 'DateReceived', 'SoldTo', 'SoldDate', 'NetMtrs', 'NetWeight', 'UpdatedAt',
  'ProductType', 'bale_uid', 'addedAt', 'grn_id', 'bin_location', 'arrival_batch', 'design_category'];
const row = (than, yards, status = 'available', soldTo = '', soldDate = '') => ['6061', 'ST/1321', '', '9043-A', '6', String(than), String(yards), status, 'Kano office',
  '3500', '2026-02-10', soldTo, soldDate, '', '', '', 'fabric', `BAL-20260210-6061-${than}`, '2026-02-10', 'GRN-7', 'A3', 'Feb26', 'Senator'];

const sheets = createFakeSheets({ Inventory: [HEADER, row(1, 60, 'sold', 'Qaribullah', '2026-08-18'), row(2, 30, 'sold', 'Ahmad', '2026-02-27'), row(3, 25), row(4, 24), row(5, 27, 'sold', 'Qaribullah', '2026-08-06')] });
installFakeSheets(sheets);

const svc = require(path.join(SRC, 'services/baleEditService'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const { baleKey } = require(path.join(SRC, 'services/baleIdentity'));
require(path.join(SRC, 'repositories/auditLogRepository')).append = async () => {};

async function bale() {
  inventoryRepository.invalidateCache();
  return (await inventoryRepository.getAll(true)).filter((r) => r.packageNo === '6061');
}

test('buildPlan: yards, header and adds, pure and honest about sold rows', async () => {
  const snap = svc.snapshotOf(await bale());
  assert.equal(snap.length, 5);
  assert.equal(snap[0].thanNo, 1);
  const plan = svc.buildPlan(snap, { yards: { [snap[0].rowIndex]: '30', [snap[2].rowIndex]: 25 }, add: [{ yards: '30' }], header: { design: '9043-A', shade: ' 6 ', indent: 'ST/1321-B' } });
  assert.deepEqual(plan.header, { indent: 'ST/1321-B' }, 'unchanged header values are not changes');
  assert.equal(plan.yardChanges.length, 1, 'a same-value yards edit is not a change');
  assert.equal(plan.yardChanges[0].from, 60);
  assert.equal(plan.yardChanges[0].to, 30);
  assert.equal(plan.yardChanges[0].status, 'sold');
  assert.deepEqual(plan.adds, [{ thanNo: 6, yards: 30 }], 'the next free than number');
  assert.deepEqual(plan.before, { thans: 5, yards: 166 });
  assert.deepEqual(plan.after, { thans: 6, yards: 166 }, '60 → 30 + a new 30 keeps the label total');
  assert.equal(plan.soldYardsChanged, true);
  assert.equal(plan.changeCount, 3);
  assert.equal(svc.buildPlan(snap, {}).changeCount, 0);
  assert.deepEqual(svc.describePlan(plan), ['indent: → ST/1321-B', '#1: 60 → 30 yd (sold → Qaribullah)', '+ #6: 30 yd (new, available)']);
});

test('parseYards accepts what the sheet can hold and nothing else', () => {
  assert.equal(svc.parseYards('30'), 30);
  assert.equal(svc.parseYards('27.55'), 27.6);
  assert.equal(svc.parseYards('1,200'), 1200);
  assert.equal(svc.parseYards('0'), null);
  assert.equal(svc.parseYards('-5'), null);
  assert.equal(svc.parseYards('abc'), null);
  assert.equal(svc.parseYards(String(svc.MAX_YARDS + 1)), null);
});

test('groupPhysical tells two physical bales with one number apart (store + container)', () => {
  const rows = [
    { packageNo: '77', design: 'A', warehouse: 'Kano office', arrivalBatch: 'Feb26', thanNo: 1 },
    { packageNo: '77', design: 'A', warehouse: 'Kano office', arrivalBatch: 'Feb26', thanNo: 2 },
    { packageNo: '77', design: 'B', warehouse: 'IDUMOTA', arrivalBatch: '', thanNo: 1 },
  ];
  assert.equal(svc.groupPhysical(rows).size, 2);
});

test('apply: cells updated on the changed rows, a new than appended with uid + copied intake fields', async () => {
  const rows = await bale();
  const snap = svc.snapshotOf(rows);
  const aj = {
    action: 'edit_bale', packageNo: '6061', warehouse: 'Kano office', baleKey: baleKey(rows[0]),
    snapshot: snap, edits: { yards: { [snap[0].rowIndex]: 30 }, add: [{ yards: 30 }], header: {} },
  };
  const r = await svc.apply(aj, '888');
  assert.equal(r.ok, true, r.message);
  assert.equal(r.updated, 1);
  assert.equal(r.appended, 1);
  const sheet = sheets._store.get('Inventory');
  const than1 = sheet.find((x) => x[0] === '6061' && x[5] === '1');
  assert.equal(String(than1[6]), '30', 'yards cell (G) rewritten');
  assert.equal(than1[7], 'sold', 'status untouched');
  assert.equal(than1[11], 'Qaribullah', 'customer untouched');
  assert.ok(than1[15], 'UpdatedAt stamped');
  const than6 = sheet.find((x) => x[0] === '6061' && String(x[5]) === '6');
  assert.ok(than6, 'than 6 appended at the bottom');
  assert.equal(than6[7], 'available');
  assert.equal(String(than6[6]), '30');
  assert.equal(than6[3], '9043-A'); assert.equal(than6[4], '6'); assert.equal(than6[1], 'ST/1321');
  assert.equal(than6[8], 'Kano office'); assert.equal(String(than6[9]), '3500');
  assert.equal(than6[19], 'GRN-7'); assert.equal(than6[21], 'Feb26'); assert.equal(than6[22], 'Senator');
  assert.match(than6[17], /^BAL-\d{8}-6061-/, 'a generated uid in the bot’s own format');
  assert.equal(sheet.indexOf(than6), sheet.length - 1, 'appended, never inserted');
  const after = await bale();
  assert.equal(after.length, 6);
  assert.equal(after.reduce((s, x) => s + x.yards, 0), 166, 'label total holds');
});

test('apply refuses when the bale moved since the edit was proposed', async () => {
  const rows = await bale();
  const snap = svc.snapshotOf(rows);
  const aj = { action: 'edit_bale', packageNo: '6061', warehouse: 'Kano office', baleKey: baleKey(rows[0]), snapshot: snap, edits: { yards: { [snap[2].rowIndex]: 26 } } };
  // Someone sold than 3 in between.
  const sheet = sheets._store.get('Inventory');
  const than3 = sheet.find((x) => x[0] === '6061' && x[5] === '3');
  than3[7] = 'sold'; than3[11] = 'Musa';
  inventoryRepository.invalidateCache();
  const r = await svc.apply(aj, '888');
  assert.equal(r.ok, false);
  assert.match(r.message, /changed since this edit was proposed/);
  assert.match(r.message, /than 3 changed \(available 25 yd → sold 25 yd\)/);
  assert.equal(String(than3[6]), '25', 'nothing written');
});
