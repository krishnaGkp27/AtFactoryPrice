'use strict';

/**
 * REP-2 — one-off guarded bale swap for transfer 02Aug·01 (owner, 02-Aug).
 * The repair must: match ONLY the fingerprinted transfer, swap wrong→right
 * rows under strict state guards, rewrite the queue row's logged lists,
 * handle both in-transit and already-received states, skip pairs it cannot
 * prove, and no-op once repaired (idempotent).
 */

process.env.ADMIN_IDS = '777';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const transferRepair = require(path.join(SRC, 'services/transferRepair'));

const WRONGS = ['867', '842', '873', '863'];
const RIGHTS = ['869', '843', '874', '864'];
const SHADES = { 867: '7', 842: '2', 873: '8', 863: '6', 869: '7', 843: '2', 874: '8', 864: '6' };

let _seq = 1;
function invRow(pkg, status, wh, design = '77014', shade = null) {
  _seq += 1;
  return {
    rowIndex: _seq, baleUid: `U-${pkg}-${_seq}`, packageNo: String(pkg), design,
    shade: shade != null ? shade : (SHADES[pkg] || '6'),
    warehouse: wh, status, productType: 'fabric', yards: 100,
  };
}

let invStore = [];
let queueRow = null;
let audits = [];
let ajPatches = [];

function seed({ status = 'pending', stage = 'in_transit' } = {}) {
  _seq = 1;
  audits = [];
  ajPatches = [];
  // Wrong bales flipped by the dispatch: in_transit @ Kano (or available @
  // Kano once received). Right bales untouched: available @ IDUMOTA.
  const wrongStatus = status === 'pending' ? 'in_transit' : 'available';
  invStore = [
    ...WRONGS.map((p) => invRow(p, wrongStatus, 'Kano office')),
    ...RIGHTS.map((p) => invRow(p, 'available', 'IDUMOTA')),
    invRow('903', wrongStatus, 'Kano office', '77016', '6'),
    // Decoys: same numbers elsewhere must never be touched.
    invRow('869', 'available', 'Lagos'),
    invRow('867', 'sold', 'IDUMOTA'),
  ];
  queueRow = {
    rowIndex: 3,
    requestId: 'TR-20260802-001',
    status,
    actionJSON: {
      action: 'transfer_stock', from: 'IDUMOTA', to: 'Kano office', stage,
      dispatcher: 'abdul', receiver: 'musa',
      lines: [
        { design: '77014', shade: '7', qty: 1 }, { design: '77014', shade: '2', qty: 1 },
        { design: '77014', shade: '8', qty: 1 }, { design: '77014', shade: '6', qty: 1 },
        { design: '77016', shade: '6', qty: 1 },
      ],
      bales: ['867', '842', '873', '863', '903'],
      baleUids: ['U-867-2', 'U-842-3', 'U-873-4', 'U-863-5', 'U-903-10'],
      dispatched: [
        { design: '77014', shade: '7', requested: 1, sent: 1, bales: ['867'] },
        { design: '77014', shade: '2', requested: 1, sent: 1, bales: ['842'] },
        { design: '77014', shade: '8', requested: 1, sent: 1, bales: ['873'] },
        { design: '77014', shade: '6', requested: 1, sent: 1, bales: ['863'] },
        { design: '77016', shade: '6', requested: 1, sent: 1, bales: ['903'] },
      ],
    },
  };

  inventoryRepository.getAll = async () => JSON.parse(JSON.stringify(invStore));
  inventoryRepository.ensureRowUids = async (rows) => new Map(rows.map((r) => [r.rowIndex, r.baleUid]));
  inventoryRepository.transitionBales = async (pkgs, from, to, wh, opts = {}) => {
    const uidSet = Array.isArray(opts.uids) && opts.uids.length ? new Set(opts.uids.map(String)) : null;
    const set = new Set((pkgs || []).map(String));
    const low = (v) => String(v == null ? '' : v).trim().toLowerCase();
    const rows = invStore.filter((r) => r.status === from
      && (uidSet ? uidSet.has(String(r.baleUid))
        : (set.has(String(r.packageNo)) && (!opts.warehouse || low(r.warehouse) === low(opts.warehouse)))));
    rows.forEach((r) => { r.status = to; if (wh != null) r.warehouse = wh; });
    return rows.map((r) => ({ ...r }));
  };
  approvalQueueRepository.getAllWithRowIndex = async () => (queueRow ? [JSON.parse(JSON.stringify(queueRow))] : []);
  approvalQueueRepository.updateActionJSON = async (id, patch) => {
    ajPatches.push({ id, patch });
    queueRow.actionJSON = { ...queueRow.actionJSON, ...patch };
    return true;
  };
  auditLogRepository.append = async (evt, data) => { audits.push({ evt, data }); };
}

function rowOf(pkg, wh) {
  const low = (v) => String(v).toLowerCase();
  return invStore.find((r) => r.packageNo === String(pkg) && low(r.warehouse) === low(wh));
}

test('in-transit swap: rights go in_transit @ Kano, wrongs come home available', async () => {
  seed();
  const res = await transferRepair.repair(null);
  assert.equal(res.done, true);
  assert.equal(res.swapped.length, 4);
  for (const w of WRONGS) {
    const r = rowOf(w, 'IDUMOTA');
    assert.ok(r && r.status === 'available', `${w} back available @ IDUMOTA`);
  }
  for (const p of RIGHTS) {
    const r = rowOf(p, 'Kano office');
    assert.ok(r && r.status === 'in_transit', `${p} now in_transit @ Kano`);
  }
  // 903 untouched; decoys untouched (looked up by uid — the swap moves the
  // real rows into the same pkg+warehouse coordinates as the decoys).
  assert.equal(rowOf('903', 'Kano office').status, 'in_transit');
  const decoyLagos = invStore.find((r) => r.baleUid === 'U-869-11');
  const decoySold = invStore.find((r) => r.baleUid === 'U-867-12');
  assert.deepEqual([decoyLagos.status, decoyLagos.warehouse], ['available', 'Lagos']);
  assert.deepEqual([decoySold.status, decoySold.warehouse], ['sold', 'IDUMOTA']);
  // Queue row rewritten so receive flips the corrected rows.
  const aj = queueRow.actionJSON;
  assert.deepEqual([...aj.bales].sort(), ['843', '864', '869', '874', '903']);
  assert.deepEqual([...aj.baleUids].sort(), ['U-843-7', 'U-864-9', 'U-869-6', 'U-874-8', 'U-903-10']);
  assert.deepEqual(aj.dispatched.map((d) => d.bales[0]), ['869', '843', '874', '864', '903']);
  assert.ok(aj.repairedAt && aj.repairNote);
  assert.equal(audits.filter((a) => a.evt === 'transfer.bale_repair').length, 1);
});

test('already-received swap: rights land available @ Kano, wrongs return available @ IDUMOTA', async () => {
  seed({ status: 'approved' });
  const res = await transferRepair.repair(null);
  assert.equal(res.done, true);
  assert.equal(res.swapped.length, 4);
  for (const p of RIGHTS) assert.equal(rowOf(p, 'Kano office').status, 'available');
  for (const w of WRONGS) assert.equal(rowOf(w, 'IDUMOTA').status, 'available');
});

test('rejected transfer is reported, never touched', async () => {
  seed({ status: 'rejected' });
  const res = await transferRepair.repair(null);
  assert.equal(res.done, false);
  assert.match(res.reason, /rejected/);
  assert.equal(rowOf('869', 'IDUMOTA').status, 'available');
});

test('a right bale not available at source guards that pair out, others still swap', async () => {
  seed();
  const r869 = rowOf('869', 'IDUMOTA');
  r869.status = 'sold'; // 869 got sold before the repair ran
  const res = await transferRepair.repair(null);
  assert.equal(res.done, true);
  assert.equal(res.swapped.length, 3);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /869 not available/);
  // 867 stays as dispatch left it — its replacement could not be claimed.
  assert.equal(rowOf('867', 'Kano office').status, 'in_transit');
  assert.ok(queueRow.actionJSON.bales.includes('867'));
  assert.ok(queueRow.actionJSON.bales.includes('843'));
});

test('fingerprint mismatch (different bale set) is a no-op', async () => {
  seed();
  queueRow.actionJSON.bales = ['867', '842', '873', '863', '999'];
  const res = await transferRepair.repair(null);
  assert.equal(res.done, false);
  assert.match(res.reason, /no matching transfer/);
});

test('idempotent: a second run after the swap finds nothing', async () => {
  seed();
  const first = await transferRepair.repair(null);
  assert.equal(first.done, true);
  const second = await transferRepair.repair(null);
  assert.equal(second.done, false);
  assert.match(second.reason, /no matching transfer/);
  assert.equal(ajPatches.length, 1, 'queue row rewritten exactly once');
});
