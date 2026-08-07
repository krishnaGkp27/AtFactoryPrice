'use strict';

/**
 * AUD-F1 (owner, 07-Aug-2026) — full re-audit + delta report.
 *
 * "Right now if I ask the offline sheet for warehouse Idumota, it shows me
 *  the list of all the items which are already reconciled. Since the sale
 *  happens every time quantity changes, make an arrangement of a chip,
 *  getting me the complete sheet of all design present in that warehouse
 *  for reconciliation." Plus: "a report against it, only showing what
 *  increases and what decreases."
 *
 * Pinned here:
 *  - the FULL sheet includes reconciled designs (the default sheet still
 *    excludes them); locked designs stay off both;
 *  - a fresh count of an already-reconciled design is COMPARED, not thrown
 *    away: a match refreshes the reconciliation, a difference takes the
 *    normal mismatch path (before AUD-F1, `already` returned before the
 *    comparison — a disagreeing re-count vanished);
 *  - the delta report goes to ADMINS only, lists ONLY increases/decreases,
 *    and the auditor's own blind reply never carries book numbers.
 */

process.env.ADMIN_IDS = '777';
process.env.WAREHOUSE_AUDIT_ENABLED = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const { createFakeBot } = require(path.join(__dirname, '..', '..', 'helpers', 'fakeBot'));
const flow = require(path.join(SRC, 'flows/warehouseAuditFlow'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const stockTakesRepository = require(path.join(SRC, 'repositories/stockTakesRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

const { sendOfflineTemplate, reconcileDesign, buildDeltaReport, SESSION_TYPE } = flow._internals;

const WH = 'IDUMOTA';
const ADMIN = '777';
const AUDITOR = '888';

approvalCards.resolveUserLabel = async () => 'Muhammad';

function bale(pkg, design, thans = 1) {
  return Array.from({ length: thans }, (_, i) => ({
    packageNo: pkg, design, shade: 'X', thanNo: i + 1, yards: 60,
    status: 'available', warehouse: WH,
  }));
}

let appended = [];
function seed({ designs, reconciled = {} }) {
  appended = [];
  inventoryRepository.getAll = async () => designs.flatMap(([d, p, t]) => bale(p, d, t || 1));
  stockTakesRepository.rowsForDay = async () => [];
  stockTakesRepository.appendMany = async (rows) => {
    appended.push(...rows);
    return rows.map((r, i) => ({ ...r, stocktake_id: `ST-${i}` }));
  };
  stockTakesRepository.latestFor = async () => {
    const m = new Map();
    for (const [d, at] of Object.entries(reconciled)) {
      m.set(d.toUpperCase(), { design: d, audited_at: at, sheet_bales: 1, sheet_bundles: 0 });
    }
    return m;
  };
}

function texts(bot) {
  return bot.callsTo('sendMessage').map((c) => ({ to: String(c.args.chatId), text: String(c.args.text || '') }));
}

test('the FULL sheet lists reconciled designs; the default sheet still hides them', async () => {
  seed({
    designs: [['9037', 'P1'], ['9045', 'P2']],
    reconciled: { 9037: '2026-08-01T09:00:00.000Z' },
  });
  sessionStore.clear(AUDITOR);
  sessionStore.set(AUDITOR, {
    type: SESSION_TYPE, warehouse: WH,
    _checklist: [
      { design: '9037', reconciled: true },
      { design: '9045', reconciled: false },
    ],
  });
  const bot1 = createFakeBot();
  await sendOfflineTemplate(bot1, AUDITOR, AUDITOR, {});
  const def = texts(bot1).map((t) => t.text).join('\n');
  assert.ok(!/9037 =/.test(def), 'default sheet: reconciled design stays off');
  assert.ok(/9045 =/.test(def));

  const bot2 = createFakeBot();
  await sendOfflineTemplate(bot2, AUDITOR, AUDITOR, { full: true });
  const full = texts(bot2).map((t) => t.text).join('\n');
  assert.ok(/9037 =/.test(full), 'FULL sheet: reconciled design is back on');
  assert.ok(/9045 =/.test(full));
  assert.match(full, /FULL count sheet — all 2 designs/);
  sessionStore.clear(AUDITOR);
});

test('a matching re-count of a reconciled design refreshes it; a differing one is NOT thrown away', async () => {
  seed({
    designs: [['9037', 'P1']],
    reconciled: { 9037: '2026-08-01T09:00:00.000Z' },
  });
  // Matches book (1 sealed bale, 0 bundles) → re-verified row appended.
  const same = await reconcileDesign({ warehouse: WH, design: '9037', bales: 1, bundles: 0, auditor: AUDITOR });
  assert.equal(same.status, 'already');
  assert.equal(appended.length, 1, 'the re-count is RECORDED, not skipped');
  assert.equal(appended[0].result, 'reconciled');
  assert.equal(appended[0].note, 're-verified');

  // Differs from book → the old code returned `already` before comparing.
  appended = [];
  const diff = await reconcileDesign({ warehouse: WH, design: '9037', bales: 3, bundles: 0, auditor: AUDITOR });
  assert.equal(diff.status, 'recount', 'a disagreeing fresh count enters the mismatch path');
  assert.equal(appended[0].result, 'mismatch');
});

test('the batch sends admins a delta report — increases and decreases only — and keeps the auditor blind', async () => {
  seed({
    designs: [['9037', 'P1'], ['9045', 'P2', 2], ['9060', 'P3']],
    reconciled: {},
  });
  const bot = createFakeBot();
  // 9037 counted 1 (book 1 → match); 9045 counted 3 bales (book: one bale of
  // 2 thans = 1 sealed bale → ↑2B); 9060 counted 0+2 (book 1B → ↓1B ↑2bd).
  await flow.handleBatchText(bot, {
    from: { id: AUDITOR }, chat: { id: AUDITOR },
    text: `AUDIT ${WH}\n9037 = 1\n9045 = 3\n9060 = 0+2`,
  });
  const msgs = texts(bot);
  const toAdmin = msgs.filter((m) => m.to === ADMIN).map((m) => m.text).join('\n');
  const toAuditor = msgs.filter((m) => m.to === AUDITOR).map((m) => m.text).join('\n');

  assert.match(toAdmin, /Audit delta — IDUMOTA · counted by Muhammad/);
  assert.match(toAdmin, /9045: ↑2B \(book 1B → counted 3B\)/, `got:\n${toAdmin}`);
  assert.match(toAdmin, /9060: ↓1B, ↑2 bundles \(book 1B → counted 0B\+2bd\)/, `got:\n${toAdmin}`);
  assert.ok(!/9037:/.test(toAdmin), 'matches never get a delta line');
  assert.match(toAdmin, /✅ 1 matched the book exactly/);

  // The auditor's reply stays blind: statuses only, no book numbers.
  assert.match(toAuditor, /Audit results — IDUMOTA/);
  assert.ok(!/book/i.test(toAuditor), 'no book figures reach the counter');
  assert.ok(!/↑|↓/.test(toAuditor), 'no deltas reach the counter');
});

test('buildDeltaReport with no deltas says so instead of listing matches', () => {
  const text = buildDeltaReport({
    warehouse: WH, auditorLabel: 'Muhammad', deltas: [], matched: 12, unknown: 0, locked: 0,
  });
  assert.match(text, /No increases, no decreases\./);
  assert.match(text, /✅ 12 matched the book exactly/);
});
