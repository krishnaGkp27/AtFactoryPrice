'use strict';

/**
 * SEN-1 — the Consistency Sentinel (specs/DATA-INTEGRITY_PLAN.md §2).
 *
 * Each of the seven checks is pinned with one DRIFTED fixture (the exact
 * corruption class the 07-Aug audit said nothing detects) and one CLEAN
 * one. Plus: the sentinel is read-only (no sheet writers touched), silent
 * when clean, and OFF when SENTINEL_ENABLED=0.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const sentinel = require(path.join(SRC, 'services/consistencySentinel'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const baleMovementsRepository = require(path.join(SRC, 'repositories/baleMovementsRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));
const baleAuditReport = require(path.join(SRC, 'services/baleAuditReport'));

const {
  checkSoldHaveSaleMovements, checkReturnsAreApproved, checkInTransit,
  checkCurrentFlags, checkSoldToResolves, checkRequestIdUniqueness,
} = sentinel._internals;

function invRow(extra = {}) {
  return {
    packageNo: '869', design: '9060-A', shade: '01', thanNo: 1, yards: 30,
    status: 'sold', warehouse: 'IDUMOTA', soldTo: 'OKSON', soldDate: '2026-08-05',
    arrivalBatch: 'Jul26', baleUid: 'BAL-869-1', ...extra,
  };
}

function move(extra = {}) {
  return {
    movedOn: '2026-08-05', baleNo: '869', design: '9060-A', shade: '01',
    container: 'Jul26', thans: 1, kind: 'sale', ref: 'OKSON', current: true, ...extra,
  };
}

/* ── C1 ── */
test('C1 flags a sold row with no sale movement; a logged one is clean', () => {
  const drift = checkSoldHaveSaleMovements({ inventory: [invRow()], movements: [] });
  assert.equal(drift.length, 1);
  assert.match(drift[0], /Bale 869 .*no sale movement/);
  const clean = checkSoldHaveSaleMovements({ inventory: [invRow()], movements: [move()] });
  assert.deepEqual(clean, []);
  // Pre-cutoff sales are out of scope: the movement log did not exist.
  const old = checkSoldHaveSaleMovements({ inventory: [invRow({ soldDate: '2026-07-20' })], movements: [] });
  assert.deepEqual(old, []);
});

/* ── C2 ── */
test('C2 flags an unapproved return; an approved one (and a correction) is clean', () => {
  const ret = move({ kind: 'return' });
  const drift = checkReturnsAreApproved({ movements: [ret], resolved: [] });
  assert.equal(drift.length, 1);
  assert.match(drift[0], /no approved return/);
  const clean = checkReturnsAreApproved({
    movements: [ret],
    resolved: [{ requestId: 'R1', status: 'approved', actionJSON: { action: 'return_package', packageNo: '869' } }],
  });
  assert.deepEqual(clean, []);
  // A revert_sale_bundle covers the ORIGINAL sale's bales via saleRefId.
  const viaRevert = checkReturnsAreApproved({
    movements: [ret],
    resolved: [
      { requestId: 'S1', status: 'approved', actionJSON: { action: 'sale_bundle', items: [{ packageNo: '869' }] } },
      { requestId: 'R2', status: 'approved', actionJSON: { action: 'revert_sale_bundle', saleRefId: 'S1' } },
    ],
  });
  assert.deepEqual(viaRevert, []);
  // Corrections are NOT returns and never need approval (RET-2).
  const corr = checkReturnsAreApproved({ movements: [move({ kind: 'correction' })], resolved: [] });
  assert.deepEqual(corr, []);
});

/* ── C3 ── */
test('C3 flags stranded in-transit rows and transfers claiming landed bales', () => {
  const transit = invRow({ status: 'in_transit', warehouse: 'Kano office', soldTo: '', soldDate: '' });
  // No open transfer at all → stranded.
  const stranded = checkInTransit({ inventory: [transit], pending: [] });
  assert.equal(stranded.length, 1);
  assert.match(stranded[0], /NO open transfer claiming it/);
  // Claimed by an open transfer → clean.
  const openTr = { requestId: 'TR-1', actionJSON: { action: 'transfer_stock', stage: 'in_transit', baleUids: ['BAL-869-1'], from: 'IDUMOTA', to: 'Kano office' } };
  assert.deepEqual(checkInTransit({ inventory: [transit], pending: [openTr] }), []);
  // Transfer claims a uid that is no longer on the road → direction B.
  const landed = checkInTransit({ inventory: [], pending: [openTr] });
  assert.equal(landed.length, 1);
  assert.match(landed[0], /not in_transit any more/);
  // Legacy uid-less transfer open → unverifiable wording, not a hard claim.
  const legacy = checkInTransit({
    inventory: [transit],
    pending: [{ requestId: 'TR-2', actionJSON: { action: 'transfer_stock', stage: 'in_transit' } }],
  });
  assert.match(legacy[0], /unverifiable/);
});

/* ── C4 ── */
test('C4 flags zero and double Current flags; exactly one is clean', () => {
  const two = checkCurrentFlags({ movements: [move(), move({ kind: 'receive' })] });
  assert.equal(two.length, 1);
  assert.match(two[0], /2 Current rows/);
  const zero = checkCurrentFlags({ movements: [move({ current: false })] });
  assert.match(zero[0], /NO Current row/);
  const one = checkCurrentFlags({ movements: [move(), move({ kind: 'receive', current: false })] });
  assert.deepEqual(one, []);
  // Same printed number in two containers = two bales, one flag EACH.
  const twoBales = checkCurrentFlags({ movements: [move(), move({ container: 'Mar26' })] });
  assert.deepEqual(twoBales, []);
});

/* ── C5 ── */
test('C5 flags a soldTo that resolves to no customer', async () => {
  const orig = customerEntity.resolve;
  customerEntity.resolve = async ({ name }) => (name === 'OKSON' ? { name: 'OKSON' } : null);
  try {
    const drift = await checkSoldToResolves({ inventory: [invRow(), invRow({ soldTo: 'OKS0N-TYPO', packageNo: '870' })] });
    assert.equal(drift.length, 1);
    assert.match(drift[0], /"OKS0N-TYPO" on 1 sold row/);
  } finally {
    customerEntity.resolve = orig;
  }
});

/* ── C7 ── */
test('C7 flags a requestId reused across queue rows', () => {
  const drift = checkRequestIdUniqueness({
    pending: [{ requestId: 'REQ-1' }],
    resolved: [{ requestId: 'REQ-1' }, { requestId: 'REQ-2' }],
  });
  assert.equal(drift.length, 1);
  assert.match(drift[0], /REQ-1 appears on 2/);
});

/* ── sweep ── */
test('sweep DMs admins on drift, is silent when clean, and honours the kill switch', async () => {
  const origs = {
    inv: inventoryRepository.getAll, mov: baleMovementsRepository.getAll,
    pend: approvalQueueRepository.getAllPending, res: approvalQueueRepository.getResolved,
    set: settingsRepository.getAll, audit: auditLogRepository.append,
    resolve: customerEntity.resolve, dup: baleAuditReport._internals.computeDuplicates,
  };
  const audits = [];
  inventoryRepository.getAll = async () => [invRow()];
  baleMovementsRepository.getAll = async () => []; // C1 drift: sale unlogged
  approvalQueueRepository.getAllPending = async () => [];
  approvalQueueRepository.getResolved = async () => [];
  settingsRepository.getAll = async () => ({});
  auditLogRepository.append = async (type, data) => { audits.push({ type, data }); };
  customerEntity.resolve = async () => ({ name: 'OKSON' });
  // C6 goes through baleAuditReport, which re-reads inventory itself — the
  // stubbed getAll serves it the same snapshot.
  try {
    const sent = [];
    const bot = { sendMessage: async (to, text) => { sent.push({ to: String(to), text }); } };
    const out = await sentinel.sweep(bot);
    assert.equal(out.ok, true);
    assert.equal(out.totalFindings, 1, 'exactly the C1 drift');
    assert.equal(sent.length, 1, 'one DM per admin');
    assert.equal(sent[0].to, '777');
    assert.match(sent[0].text, /⚠️ C1/);
    assert.match(sent[0].text, /✅ C4/, 'clean checks still listed as ticks');
    assert.equal(audits[0].type, 'sentinel_run');
    assert.equal(audits[0].data.C1, 1);

    // Clean run → no DM, still audit-logged.
    baleMovementsRepository.getAll = async () => [move()];
    sent.length = 0;
    const clean = await sentinel.sweep(bot);
    assert.equal(clean.totalFindings, 0);
    assert.equal(sent.length, 0, 'silent when clean');

    // Kill switch.
    settingsRepository.getAll = async () => ({ SENTINEL_ENABLED: '0' });
    const off = await sentinel.sweep(bot);
    assert.equal(off.skipped, 'disabled');
  } finally {
    inventoryRepository.getAll = origs.inv;
    baleMovementsRepository.getAll = origs.mov;
    approvalQueueRepository.getAllPending = origs.pend;
    approvalQueueRepository.getResolved = origs.res;
    settingsRepository.getAll = origs.set;
    auditLogRepository.append = origs.audit;
    customerEntity.resolve = origs.resolve;
  }
});
