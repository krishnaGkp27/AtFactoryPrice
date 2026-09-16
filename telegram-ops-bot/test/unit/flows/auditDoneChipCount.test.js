'use strict';

/**
 * AUD-C1 (owner, 16-Sep-2026) — a green (reconciled) chip shows the figure
 * the auditor entered that day, to ADMINS ONLY: "Go ahead with admins only".
 * Auditors' chips stay blind (WAU-3), exactly as before.
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
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

const { doneChipLabel, renderChecklist, SESSION_TYPE } = flow._internals;
const WH = 'IDUMOTA';
const AT = '2026-08-20T09:00:00.000Z';

test('doneChipLabel: admin sees the figure in rule-6c grammar, auditor sees the old blind label', () => {
  const d = { design: '9006', reconciledAt: '2026-08-20', countedBales: 12, countedThans: 3 };
  assert.equal(doneChipLabel(d, true), '✅ 9006 · 12B + 3t · 20-Aug-26');
  assert.equal(doneChipLabel(d, false), '✅ 9006 (done 20-Aug-26)');
  assert.equal(doneChipLabel({ ...d, countedThans: 0 }, true), '✅ 9006 · 12B · 20-Aug-26');
  assert.equal(doneChipLabel({ ...d, countedBales: 0, countedThans: 21 }, true), '✅ 9006 · 21t · 20-Aug-26');
});

test('doneChipLabel: a legacy tick-box row has no figure — the admin chip is design · date', () => {
  const d = { design: '9006', reconciledAt: '2026-08-20', countedBales: null, countedThans: null };
  assert.equal(doneChipLabel(d, true), '✅ 9006 · 20-Aug-26');
});

test('doneChipLabel: a long onboarding code drops the year on that chip alone', () => {
  const d = { design: '402/9059 (08)', reconciledAt: '2026-08-20', countedBales: 12, countedThans: 3 };
  const label = doneChipLabel(d, true);
  assert.equal(label, '✅ 402/9059 (08) · 12B + 3t · 20-Aug');
  // The year is the only thing the locked grammar lets the chip give up; a
  // 13-char code still lands at 36 — Telegram trims the tail, which is the
  // date, never the figure.
  assert.ok(label.length < '✅ 402/9059 (08) · 12B + 3t · 20-Aug-26'.length);
  assert.equal(doneChipLabel({ ...d, design: '9006' }, true).endsWith('20-Aug-26'), true, 'short codes keep the year');
});

test('renderChecklist: the real picker prints the recorded count for the admin and stays blind for an auditor', async () => {
  inventoryRepository.getAll = async () => [{ packageNo: 'P1', design: '9006', shade: 'X', thanNo: 1, yards: 60, status: 'available', warehouse: WH }];
  stockTakesRepository.rowsForDay = async () => [];
  stockTakesRepository.latestFor = async () => new Map([['9006', {
    design: '9006', audited_at: AT, sheet_bales: 1, sheet_bundles: 0, counted_bales: 1, counted_bundles: 0,
  }]]);
  const labelsFor = async (userId) => {
    sessionStore.clear(userId);
    sessionStore.set(userId, { type: SESSION_TYPE, warehouse: WH, location: 'Lagos' });
    const bot = createFakeBot();
    await renderChecklist(bot, userId, userId);
    const sent = bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
    return sent[sent.length - 1].args.opts.reply_markup.inline_keyboard.flat().map((b) => b.text);
  };
  const admin = await labelsFor('777');
  assert.ok(admin.includes('✅ 9006 · 1B · 20-Aug-26'), `admin chip, got ${admin}`);
  const auditor = await labelsFor('4242');
  assert.ok(auditor.includes('✅ 9006 (done 20-Aug-26)'), `auditor chip unchanged, got ${auditor}`);
  assert.ok(!auditor.some((l) => /1B/.test(l)), 'no figure reaches the auditor');
});
