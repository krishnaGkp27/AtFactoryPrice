'use strict';

/**
 * MYP-1 §16 — the allocation cap: never more than the warehouse actually
 * holds at write time. Stubbed at the repository seams; the service under
 * test is the ONE door both the bot flow and the web matrix use.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const inventoryRepository = require('../../../src/repositories/inventoryRepository');
const allocRepo = require('../../../src/repositories/marketerAllocationsRepository');
const auditLogRepository = require('../../../src/repositories/auditLogRepository');

const ROWS = [
  { packageNo: '701', design: '9037', warehouse: 'Kano office', status: 'available' },
  { packageNo: '702', design: '9037', warehouse: 'Kano office', status: 'available' },
  { packageNo: '703', design: '9037', warehouse: 'Kano office', status: 'available' },
  { packageNo: '801', design: '9037', warehouse: 'Lagos office', status: 'available' },
  { packageNo: '600', design: '9037', warehouse: 'Kano office', status: 'sold', soldTo: 'Owaibula', soldDate: '2026-07-12' },
];
inventoryRepository.getAll = async () => ROWS;
inventoryRepository.getSoldRows = async () => ROWS.filter((r) => r.status === 'sold');

let saved = [];
allocRepo.setAllocation = async (rec) => { saved.push(rec); return { updated: false, qty: rec.qty }; };
let audits = [];
auditLogRepository.append = async (ev, meta, uid) => { audits.push({ ev, meta, uid }); };

const allocationService = require('../../../src/services/allocationService');

test('qty equal to the warehouse count saves; one more is refused with the live number', async () => {
  saved = [];
  const ok = await allocationService.setAllocation({
    personId: '900', personName: 'Owaibula', design: '9037', qty: 3,
    updatedBy: '777', warehouse: 'Kano office',
  });
  assert.equal(ok.ok, true);
  assert.equal(saved.length, 1);

  const over = await allocationService.setAllocation({
    personId: '900', personName: 'Owaibula', design: '9037', qty: 4,
    updatedBy: '777', warehouse: 'Kano office',
  });
  assert.equal(over.ok, false);
  assert.equal(over.cap, 3);
  assert.match(over.reason, /Only 3 bales/);
  assert.equal(saved.length, 1, 'the refused write never reached the sheet');
});

test('warehouse null caps against ALL warehouses; qty 0 (remove) always passes', async () => {
  saved = [];
  const ok = await allocationService.setAllocation({
    personId: '900', personName: 'O', design: '9037', qty: 4, updatedBy: '777', warehouse: null,
  });
  assert.equal(ok.ok, true, '4 <= 3 Kano + 1 Lagos');
  const zero = await allocationService.setAllocation({
    personId: '900', personName: 'O', design: '9037', qty: 0, updatedBy: '777', warehouse: 'Kano office',
  });
  assert.equal(zero.ok, true, 'removal never needs stock');
});

test('every write is audited; setMode stores the * row without touching designs', async () => {
  saved = []; audits = [];
  await allocationService.setAllocation({ personId: '900', personName: 'O', design: '9037', qty: 1, updatedBy: '777', warehouse: 'Kano office' });
  assert.equal(audits[0].ev, 'marketer_allocation');
  const r = await allocationService.setMode('900', 'O', 'curated', '777');
  assert.equal(r.mode, 'curated');
  const star = saved.find((x) => x.design === '*');
  assert.ok(star && star.notes === 'curated');
});

test('junk input refused before any read', async () => {
  const bad = await allocationService.setAllocation({ personId: '', design: '', qty: -1 });
  assert.equal(bad.ok, false);
});
