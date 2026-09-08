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

test('C2: RET-4 — an approved return_thans is an approved return, not a wolf', () => {
  // Every RET-4 movement is written by markThanAvailable with kind 'return'.
  // Without return_thans in C2's approved-return set, the sentinel would
  // accuse every single multi-than return once it aged past the recency
  // window — crying wolf on the door RET-4 just shipped.
  const ret = move({ kind: 'return' });
  const clean = checkReturnsAreApproved({
    movements: [ret],
    resolved: [{ requestId: 'R4', status: 'approved', actionJSON: { action: 'return_thans', packageNo: '869', thanNos: [1, 4] } }],
  });
  assert.deepEqual(clean, []);
  // The negative still holds: the same movement with no approved row is drift.
  const drift = checkReturnsAreApproved({ movements: [ret], resolved: [] });
  assert.equal(drift.length, 1);
  // And a PENDING return_thans row does not whitelist anything.
  const pending = checkReturnsAreApproved({
    movements: [ret],
    resolved: [{ requestId: 'R4', status: 'pending', actionJSON: { action: 'return_thans', packageNo: '869' } }],
  });
  assert.equal(pending.length, 1);
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
    queueRows: [{ requestId: 'REQ-1' }, { requestId: 'REQ-1' }, { requestId: 'REQ-2' }],
  });
  assert.equal(drift.length, 1);
  assert.match(drift[0], /REQ-1 appears on 2/);
});

/* ── sweep ── */
test('sweep DMs admins on drift, is silent when clean, and honours the kill switch', async () => {
  const origs = {
    inv: inventoryRepository.getAll, mov: baleMovementsRepository.getAllStrict,
    rows: approvalQueueRepository.getAllWithRowIndex,
    set: settingsRepository.getAll, audit: auditLogRepository.append,
    resolve: customerEntity.resolve, dup: baleAuditReport._internals.computeDuplicates,
  };
  const audits = [];
  inventoryRepository.getAll = async () => [invRow()];
  baleMovementsRepository.getAllStrict = async () => []; // C1 drift: sale unlogged
  approvalQueueRepository.getAllWithRowIndex = async () => [];
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
    baleMovementsRepository.getAllStrict = async () => [move()];
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
    baleMovementsRepository.getAllStrict = origs.mov;
    approvalQueueRepository.getAllWithRowIndex = origs.rows;
    settingsRepository.getAll = origs.set;
    auditLogRepository.append = origs.audit;
    customerEntity.resolve = origs.resolve;
  }
});

/* ── SEN-1b: the adversarial-review regressions ── */

test('a FAILED sheet read aborts the sweep — it never fabricates drift', async () => {
  const origs = {
    inv: inventoryRepository.getAll, mov: baleMovementsRepository.getAllStrict,
    rows: approvalQueueRepository.getAllWithRowIndex, set: settingsRepository.getAll,
  };
  inventoryRepository.getAll = async () => [invRow()];
  baleMovementsRepository.getAllStrict = async () => { throw new Error('quota'); };
  approvalQueueRepository.getAllWithRowIndex = async () => [];
  settingsRepository.getAll = async () => ({});
  try {
    const sent = [];
    const bot = { sendMessage: async (to, text) => { sent.push(text); } };
    const out = await sentinel.sweep(bot);
    assert.equal(out.ok, false, 'the sweep reports failure');
    assert.equal(sent.length, 0, 'and accuses NOBODY');
  } finally {
    inventoryRepository.getAll = origs.inv;
    baleMovementsRepository.getAllStrict = origs.mov;
    approvalQueueRepository.getAllWithRowIndex = origs.rows;
    settingsRepository.getAll = origs.set;
  }
});

test('C1 tolerates container backfill: a sale logged with a blank container still matches', () => {
  // The movement was appended BEFORE the arrival_batch backfill stamped
  // the row — frozen container '' vs current 'Jul26' must not accuse.
  const clean = checkSoldHaveSaleMovements({
    inventory: [invRow({ arrivalBatch: 'Jul26' })],
    movements: [move({ container: '' })],
  });
  assert.deepEqual(clean, []);
  // And the reverse: row still blank, movement stamped.
  const clean2 = checkSoldHaveSaleMovements({
    inventory: [invRow({ arrivalBatch: '' })],
    movements: [move({ container: 'Jul26' })],
  });
  assert.deepEqual(clean2, []);
});

test('C1 skips junk soldDate values instead of accusing legacy rows', () => {
  // normDay returns raw junk unparsed; 'TBD' sorts after the cutoff and
  // used to be pulled INTO the check.
  for (const bad of ['TBD', 'pending', '03/13/2026']) {
    const out = checkSoldHaveSaleMovements({ inventory: [invRow({ soldDate: bad })], movements: [] });
    assert.deepEqual(out, [], `soldDate '${bad}' must be out of scope`);
  }
});

test('rows and movements written inside the grace window are skipped (mid-write sweep)', () => {
  const now = Date.now();
  const fresh = new Date(now - 60 * 1000).toISOString();
  // C1: sold row flipped 1 min ago — the movement append may be in flight.
  const c1 = checkSoldHaveSaleMovements({ inventory: [invRow({ updatedAt: fresh })], movements: [], now });
  assert.deepEqual(c1, []);
  // C4: the append clears flags before appending — a fresh bale with 0
  // flags is healthy, not a crash.
  const c4 = checkCurrentFlags({ movements: [move({ current: false, timestamp: fresh })], now });
  assert.deepEqual(c4, []);
  // C2: the queue row flips to approved a few calls after the movement.
  const c2 = checkReturnsAreApproved({ movements: [move({ kind: 'return', timestamp: fresh })], resolved: [], now });
  assert.deepEqual(c2, []);
});

test('C2 date window: an approved return years away no longer whitelists a recycled number', () => {
  const ret = move({ kind: 'return', movedOn: '2026-08-05' });
  const farAway = checkReturnsAreApproved({
    movements: [ret],
    resolved: [{ requestId: 'R1', status: 'approved', resolvedAt: '2026-01-01T09:00:00.000Z', actionJSON: { action: 'return_package', packageNo: '869' } }],
  });
  assert.equal(farAway.length, 1, 'six months apart is not the same return');
  const near = checkReturnsAreApproved({
    movements: [ret],
    resolved: [{ requestId: 'R1', status: 'approved', resolvedAt: '2026-08-04T09:00:00.000Z', actionJSON: { action: 'return_package', packageNo: '869' } }],
  });
  assert.deepEqual(near, [], 'a day apart is the same return');
});

/* ── C8 (APF-1): the executed-but-unresolved zombie detector ── */

test('C8 flags an old pending sale whose stock is gone; fresh or live ones are clean', () => {
  const { checkPendingSalesAlreadySold } = sentinel._internals;
  const now = Date.now();
  const oldRow = (extra = {}) => ({
    requestId: 'R-9CEB', status: 'pending',
    createdAt: new Date(now - 3 * 86400000).toISOString(),
    actionJSON: { action: 'sale_bundle', items: [{ packageNo: '516' }] }, ...extra,
  });
  // Bale 516 has no available rows anywhere → zombie.
  const drift = checkPendingSalesAlreadySold({ inventory: [], pending: [oldRow()], now });
  assert.equal(drift.length, 1);
  assert.match(drift[0], /R-9CEB is pending for 3d but every bale in it is already sold/);
  // Same request with the bale still available → clean (a normal pending sale).
  const live = checkPendingSalesAlreadySold({
    inventory: [invRow({ packageNo: '516', status: 'available', soldTo: '', soldDate: '' })],
    pending: [oldRow()], now,
  });
  assert.deepEqual(live, []);
  // Under an hour old → mid-enrichment grace, never flagged.
  const fresh = checkPendingSalesAlreadySold({
    inventory: [], now,
    pending: [oldRow({ createdAt: new Date(now - 10 * 60000).toISOString() })],
  });
  assert.deepEqual(fresh, []);
  // Non-sale pending rows are out of scope.
  const other = checkPendingSalesAlreadySold({
    inventory: [], now,
    pending: [oldRow({ actionJSON: { action: 'transfer_stock', stage: 'requested' } })],
  });
  assert.deepEqual(other, []);
});

/* ── ISC-1 Phase 1b: C9 / C10 / C11, the hand-edit alarm ── */

test('C9 aggregates unreadable sold dates: one total line plus examples, never one line per row', () => {
  const { checkSoldDatesReadable, C9_EXAMPLES } = sentinel._internals;
  const junk = invRow({ rowIndex: 4012, soldDate: 'cashmere 12-February-2026', soldTo: 'madam oshodi' });
  const one = checkSoldDatesReadable({ inventory: [junk, invRow({ rowIndex: 5, packageNo: '870' })] });
  assert.equal(one.count, 1, 'the ROW count rides beside the lines');
  assert.equal(one.findings.length, 2, 'total line + one example');
  assert.match(one.findings[0], /^1 sold row\(s\) carry a SoldDate the bot cannot read/);
  assert.equal(one.findings[1], 'row 4012 · 9060-A/869 #1 · "cashmere 12-February-2026"');
  // 105 junk rows (today's count) → 1 + 5 lines, not 105 — but count says 105.
  const many = Array.from({ length: 105 }, (_, i) => invRow({
    rowIndex: 100 + i, soldDate: `cashmere 2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
  }));
  const agg = checkSoldDatesReadable({ inventory: many });
  assert.equal(agg.findings.length, 1 + C9_EXAMPLES);
  assert.equal(agg.count, 105);
  assert.match(agg.findings[0], /^105 sold row\(s\)/);
  assert.match(agg.findings[0], /first 5 below/);
  assert.match(agg.findings[1], /^row 100 · /);
});

test('checkCount: an aggregated check reports its row count; every other check its line count', () => {
  const { checkCount } = sentinel._internals;
  assert.equal(checkCount({ findings: ['a', 'b', 'c'] }), 3, 'no count → lines');
  assert.equal(checkCount({ findings: ['total', 'e1', 'e2'], count: 105 }), 105);
  assert.equal(checkCount({ findings: [], count: 0 }), 0);
  assert.equal(checkCount({ findings: ['x'], count: -1 }), 1, 'a nonsense count falls back to the lines');
  assert.equal(sentinel.checkCount, checkCount, 'exported for the 🩺 tile');
});

test('C9 never accuses a readable date in any of the four shapes, a blank date, or junk on an available row', () => {
  const { checkSoldDatesReadable } = sentinel._internals;
  const clean = [
    invRow({ soldDate: '2026-08-05' }), invRow({ soldDate: '22-April-2026' }),
    invRow({ soldDate: '07 April 2026' }), invRow({ soldDate: '13-04-2026' }),
    invRow({ soldDate: '' }),
    invRow({ status: 'available', soldTo: '', soldDate: 'TBD' }),
  ];
  assert.deepEqual(checkSoldDatesReadable({ inventory: clean }), { count: 0, findings: [] });
});

test('C9 count reaches every surface: DM header and line, totalFindings, and the AuditLog sentinel_run row', async () => {
  const origs = {
    inv: inventoryRepository.getAll, mov: baleMovementsRepository.getAllStrict,
    rows: approvalQueueRepository.getAllWithRowIndex, set: settingsRepository.getAll,
    audit: auditLogRepository.append, resolve: customerEntity.resolve,
  };
  // 105 junk-dated sold thans of one bale, each its own real uid (C10 clean),
  // one shade (C11 clean); a junk day is outside C1's window by design.
  inventoryRepository.getAll = async () => Array.from({ length: 105 }, (_, i) => invRow({
    rowIndex: 100 + i, thanNo: i + 1, baleUid: `BAL-869-${i + 1}`,
    soldDate: `cashmere 2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
  }));
  baleMovementsRepository.getAllStrict = async () => [];
  approvalQueueRepository.getAllWithRowIndex = async () => [];
  settingsRepository.getAll = async () => ({});
  const audits = [];
  auditLogRepository.append = async (type, data) => { audits.push({ type, data }); };
  customerEntity.resolve = async () => ({ name: 'OKSON' });
  try {
    const sent = [];
    const bot = { sendMessage: async (to, text) => { sent.push({ to: String(to), text }); } };
    const out = await sentinel.sweep(bot);
    assert.equal(out.ok, true);
    assert.equal(out.totalFindings, 105, 'rows, not lines');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /🩺 Data Health — 105 issue\(s\) found/);
    assert.match(sent[0].text, /⚠️ C9 Every sale carries a readable date — 105:/);
    const c9Lines = sent[0].text.split('\n').filter((l) => /^ {3}• /.test(l));
    assert.equal(c9Lines.length, 1 + sentinel._internals.C9_EXAMPLES, 'still a total plus five examples, never 105 lines');
    assert.ok(!/…and \d+ more — open 🩺 Data Health/.test(sent[0].text), 'six lines fit under the DM cap — no "more" tail');
    assert.equal(audits[0].type, 'sentinel_run');
    assert.equal(audits[0].data.C9, 105, 'the run-history row carries the row count');
    assert.equal(audits[0].data.C10, 0);
  } finally {
    inventoryRepository.getAll = origs.inv;
    baleMovementsRepository.getAllStrict = origs.mov;
    approvalQueueRepository.getAllWithRowIndex = origs.rows;
    settingsRepository.getAll = origs.set;
    auditLogRepository.append = origs.audit;
    customerEntity.resolve = origs.resolve;
  }
});

test('C10 flags one real uid on two rows; synthetic legacy uids and distinct uids are clean', () => {
  const { checkUidsUnique } = sentinel._internals;
  const dup = [
    invRow({ rowIndex: 5201, packageNo: '864', design: '77014', thanNo: 4, baleUid: 'BAL-20260713-864-bjwg' }),
    invRow({ rowIndex: 5202, packageNo: '864', design: '77014', thanNo: 5, baleUid: 'BAL-20260713-864-bjwg' }),
    invRow({ rowIndex: 5203, packageNo: '864', design: '77014', thanNo: 3, baleUid: 'BAL-20260713-864-k2m9' }),
  ];
  const drift = checkUidsUnique({ inventory: dup });
  assert.equal(drift.length, 1);
  assert.equal(drift[0], 'bale_uid BAL-20260713-864-bjwg sits on 2 rows (5201, 5202) — 77014/864 thans #4, #5');
  // The parser's positional stand-in on two legacy rows is a backfill job, not drift.
  const legacy = [
    invRow({ rowIndex: 30, baleUid: 'BAL-LEGACY-30', _legacy: true }),
    invRow({ rowIndex: 31, baleUid: 'BAL-LEGACY-30', _legacy: true }),
  ];
  assert.deepEqual(checkUidsUnique({ inventory: legacy }), []);
  assert.deepEqual(checkUidsUnique({ inventory: [dup[0], dup[2]] }), []);
});

test("C11 flags '4-5' vs '4-5.' inside one design; '4-5' vs '4-6', and one shade across two designs, are clean", () => {
  const { checkShadeSpellings } = sentinel._internals;
  const drift = checkShadeSpellings({
    inventory: [
      invRow({ rowIndex: 40, design: '75142', shade: '4-5' }),
      invRow({ rowIndex: 41, design: '75142', shade: '4-5.' }),
      invRow({ rowIndex: 42, design: '75142', shade: '4-5.' }),
    ],
  });
  assert.equal(drift.length, 1);
  assert.equal(drift[0], '75142: one shade spelled two ways — "4-5" (1 row) vs "4-5." (2 rows)');
  const clean = checkShadeSpellings({
    inventory: [
      invRow({ rowIndex: 40, design: '75142', shade: '4-5' }),
      invRow({ rowIndex: 43, design: '75142', shade: '4-6' }),
      invRow({ rowIndex: 44, design: '77018', shade: '4-5.' }),
      invRow({ rowIndex: 45, design: '9037-D', shade: '' }),
    ],
  });
  assert.deepEqual(clean, []);
});

test('runAll carries C9–C11 on the same snapshot, after C8, and they tick when clean', async () => {
  const origs = {
    inv: inventoryRepository.getAll, mov: baleMovementsRepository.getAllStrict,
    rows: approvalQueueRepository.getAllWithRowIndex, resolve: customerEntity.resolve,
  };
  inventoryRepository.getAll = async () => [
    invRow({ rowIndex: 2 }),
    invRow({ rowIndex: 3, packageNo: '870', baleUid: 'BAL-870-1', soldDate: 'cashmere 12-February-2026' }),
  ];
  baleMovementsRepository.getAllStrict = async () => [move(), move({ baleNo: '870', current: true })];
  approvalQueueRepository.getAllWithRowIndex = async () => [];
  customerEntity.resolve = async () => ({ name: 'OKSON' });
  try {
    const out = await sentinel.runAll();
    const ids = out.checks.map((c) => c.id);
    assert.deepEqual(ids.slice(-3), ['C9', 'C10', 'C11']);
    assert.equal(ids.indexOf('C9'), ids.indexOf('C8') + 1);
    const byId = Object.fromEntries(out.checks.map((c) => [c.id, c]));
    assert.equal(byId.C9.findings.length, 2, 'total line + one example for the one junk date');
    assert.equal(byId.C9.count, 1, 'one junk row — the count the report shows');
    assert.deepEqual(byId.C10.findings, []);
    assert.deepEqual(byId.C11.findings, []);
    assert.equal(out.totalFindings, 1, 'C9 counts one row, not two lines');
    assert.match(sentinel.buildReport(out), /⚠️ C9 Every sale carries a readable date — 1:/);
    assert.match(sentinel.buildReport(out), /✅ C10 Every bale_uid is unique/);
  } finally {
    inventoryRepository.getAll = origs.inv;
    baleMovementsRepository.getAllStrict = origs.mov;
    approvalQueueRepository.getAllWithRowIndex = origs.rows;
    customerEntity.resolve = origs.resolve;
  }
});
