'use strict';

/**
 * CUR-1 §8 step 3 — SIDE A pinned (BUSINESS_RULES §17, rulings R8/R11).
 *
 * Money LEAVING the office (cash book, payment requests, task incentives)
 * always prints the naira symbol and never reads the sales-side CURRENCY
 * env. What these pin:
 *
 *   1. Byte-identity: the helpers each side-A file now routes through
 *      `money.expense` print exactly what the inline code printed before —
 *      `paymentService.fmtNaira` (whole naira) and the EXP-1 cash-book
 *      formatter `branchOpsService.fmtNgn` (kobo only when present), over
 *      the whole 2-dp domain the sheets store.
 *   2. R11: `incentivesRepository` writes the literal `NGN` no matter what
 *      the env says or the caller passes; a blank cell reads back as `NGN`.
 *   3. The env cannot relabel side A: with CURRENCY=USD the payouts queue,
 *      the payment line and the cash book still print `₦`.
 *   4. Source guards: no side-A file reaches `config.currency` or the
 *      deprecated `fmtMoneyShort` shim (S-CUR rule 2, pinned here in FAIL
 *      mode while the smoke lint is still in WARN mode).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const SRC = path.join(__dirname, '../../../src');
const config = require(path.join(SRC, 'config'));

// The sales-side env is deliberately NOT naira for this whole file: nothing
// on side A may notice.
config.currency = 'USD';

const money = require(path.join(SRC, 'utils/money'));
const { fmtQty } = require(path.join(SRC, 'utils/format'));

// Stub the sheet before any repository loads.
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
let INCENTIVE_ROWS = [];
let WRITES = [];
sheets.readRange = async (sheet) => (sheet === 'Incentives' ? INCENTIVE_ROWS : []);
sheets.appendRows = async (sheet, rows) => { WRITES.push({ op: 'append', sheet, rows }); };
sheets.updateRange = async (sheet, range, values) => { WRITES.push({ op: 'update', sheet, range, values }); };

const paymentService = require(path.join(SRC, 'services/paymentService'));
const branchOpsService = require(path.join(SRC, 'services/branchOpsService'));
const incentivesRepository = require(path.join(SRC, 'repositories/incentivesRepository'));
const { formatBranchReport } = require(path.join(SRC, 'services/eveningExpenseReport'));

/** The pre-CUR-1 bodies, verbatim, so identity is asserted against the past. */
const legacyFmtNaira = (amount) => `₦${Math.round(Number(amount) || 0).toLocaleString('en-NG')}`;
const legacyFmtNgn = (n) => `₦${fmtQty(n, { maxFraction: 2 })}`;
const legacyEveningNgn = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

/** A deterministic spread of 2-dp amounts: the domain every EXP-1 row lives in. */
function twoDpSamples() {
  const out = [0, 1, 800, 5500, 45000, 104000, 185400, 1512.5, 1512.25, 39.5, 110500, 0.1, 0.29, 1.15, 0.7,
    2.3, -5.5, 5_000_000, 50_000_000, 5000000.01, 12345678.9, 99.99, 100.1, 0.01];
  let x = 12345;
  for (let i = 0; i < 5000; i++) {
    x = (x * 1103515245 + 12345) % 2147483648; // LCG — repeatable, no Math.random
    out.push(Math.round((x % 1e8)) / 100);        // up to 2 dp
    out.push(Math.round((x % 1e6)) / 10);         // up to 1 dp
    out.push(x % 1e6);                            // integers
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1 · byte-identity of the routed helpers
// ---------------------------------------------------------------------------

test('paymentService.fmtNaira prints exactly what the inline body printed (whole naira)', () => {
  for (const n of [...twoDpSamples(), 45000.4, 45000.5, 0.49, null, undefined, '', '45000']) {
    assert.equal(paymentService.fmtNaira(n), legacyFmtNaira(n), `fmtNaira(${n})`);
  }
  assert.equal(paymentService.fmtNaira(45000), '₦45,000');
  assert.equal(paymentService.fmtNaira(250000), '₦250,000');
  assert.equal(paymentService.validateAmount('999999999').reason, 'That is over ₦100,000,000 — check the figure.');
});

test('branchOpsService.fmtNgn prints exactly what the inline cash-book formatter printed (kobo only when present)', () => {
  for (const n of [...twoDpSamples(), null, undefined, '', '1512.5']) {
    assert.equal(branchOpsService.fmtNgn(n), legacyFmtNgn(n), `fmtNgn(${n})`);
  }
  assert.equal(branchOpsService.fmtNgn(800), '₦800');
  assert.equal(branchOpsService.fmtNgn(1512.5), '₦1,512.5');
  assert.equal(branchOpsService.fmtNgn(1512.25), '₦1,512.25');
  assert.equal(branchOpsService.fmtNgn(5_000_000), '₦5,000,000');
  // The one documented difference: garbage is ₦0, not ₦NaN (money.js contract).
  assert.equal(branchOpsService.fmtNgn('abc'), '₦0');
  assert.equal(legacyFmtNgn('abc'), '₦NaN');
});

test('the evening report prints the same figures as before, kobo included', () => {
  const rep = {
    branch: 'Kano', date: '2026-09-09', filed: true, spent: 6500.5, balance: 43499.5, zeroDay: false,
    allowances: [{ name: 'Abdul', amount: 1000 }],
    office: [{ title: 'Fuel', amount: 5500.5 }],
    commissions: [],
    cashIn: [],
  };
  const text = formatBranchReport(rep, { filerName: 'Musa' });
  for (const n of [1000, 5500.5, 6500.5, 43499.5]) {
    assert.ok(text.includes(legacyEveningNgn(n)), `report carries ${legacyEveningNgn(n)}: ${text}`);
  }
  assert.match(text, /🧾 Fuel ₦5,500\.5/);
  assert.match(text, /Spent \*₦6,500\.5\* · Balance in hand \*₦43,499\.5\*/);
  assert.doesNotMatch(text, /USD|\$/, 'the sales-side env never reaches the cash book');
});

// ---------------------------------------------------------------------------
// 2 · R11 — the Incentives currency cell is the literal NGN
// ---------------------------------------------------------------------------

test('R11: incentivesRepository writes the literal NGN whatever the env or the caller says', async () => {
  assert.equal(incentivesRepository.INCENTIVE_CURRENCY, 'NGN');
  assert.equal(config.currency, 'USD', 'precondition — the env is NOT naira in this file');

  INCENTIVE_ROWS = [];
  WRITES = [];
  const fresh = await incentivesRepository.setAmount({ task_id: 'T-NEW', amount: 5000, currency: 'USD', set_by: '100' });
  assert.equal(fresh.currency, 'NGN');
  assert.equal(WRITES.length, 1);
  assert.equal(WRITES[0].op, 'append');
  assert.equal(WRITES[0].rows[0][2], 'NGN', 'column C on a fresh row');

  INCENTIVE_ROWS = [['T-OLD', '7000', 'USD', '100', '2026-09-01T00:00:00Z', '', '', '', '', '']];
  WRITES = [];
  const upd = await incentivesRepository.setAmount({ task_id: 'T-OLD', amount: 8000, currency: 'EUR', set_by: '100' });
  assert.equal(upd.currency, 'NGN');
  const w = WRITES.find((x) => x.op === 'update' && /^B2:E2$/.test(x.range));
  assert.ok(w, 'B..E of the existing row is rewritten');
  assert.equal(w.values[0][1], 'NGN', 'column C on the rewrite');
});

test('R11: a blank currency cell reads back as NGN, not the env', () => {
  const row = incentivesRepository._parse(['T1', '5000', '', '100', '2026-09-01T00:00:00Z', '', '', '', '', ''], 2);
  assert.equal(row.currency, 'NGN');
  assert.equal(row.amount, 5000);
});

// ---------------------------------------------------------------------------
// 3 · the env cannot relabel side A
// ---------------------------------------------------------------------------

test('the payouts queue prints ₦ with CURRENCY=USD (taskFlow → money.expense)', async () => {
  const tasksRepository = require(path.join(SRC, 'repositories/tasksRepository'));
  const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
  tasksRepository.getById = async (id) => ({ task_id: id, title: `Job ${id}`, assigned_to: '900' });
  usersRepository.findByUserId = async () => ({ name: 'Abdul' });
  config.access = { ...(config.access || {}), financeIds: ['700'] };

  const taskFlow = require(path.join(SRC, 'flows/taskFlow'));
  INCENTIVE_ROWS = [
    ['T1', '5000', 'NGN', '100', '2026-09-01T00:00:00Z', '', 'awaiting_payout', '', '', ''],
    ['T2', '2500', '', '100', '2026-09-01T00:00:00Z', '', 'awaiting_payout', '', '', ''],
    ['T3', '1200', 'NGN', '100', '2026-08-20T00:00:00Z', '', 'paid', '2026-08-21T00:00:00Z', '1200', ''],
  ];
  const sent = [];
  const bot = {
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { message_id: 1 }; },
    editMessageText: async () => { throw new Error('no anchor'); },
  };
  await taskFlow.showPayouts(bot, 700, '700', null);
  assert.equal(sent.length, 1);
  const { text, opts } = sent[0];
  assert.match(text, /\*2 incentives\* awaiting · ₦7,500/, 'one naira total, R11');
  assert.match(text, /Job T1 → Abdul · \*₦5,000\*/);
  assert.match(text, /Job T2 → Abdul · \*₦2,500\*/);
  assert.match(text, /Job T3 · \*₦1,200\*/, 'recently paid');
  assert.doesNotMatch(text, /USD|\$/);
  const markPaid = opts.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === 'tsk:py:p:T1');
  assert.ok(markPaid && /\(₦5,000\)/.test(markPaid.text), 'the Mark paid chip carries ₦');
});

test('a payment line and a cash-book line print ₦ with CURRENCY=USD', () => {
  assert.equal(paymentService.fmtNaira(45000), '₦45,000');
  assert.equal(branchOpsService.fmtNgn(185400), '₦185,400');
  assert.equal(money.code(), 'USD', 'the code itself DOES follow the env — it is for narrations only');
});

// ---------------------------------------------------------------------------
// 4 · source guards (S-CUR rule 2 in fail mode for side A)
// ---------------------------------------------------------------------------

const SIDE_A = [
  'flows/officeExpenseFlow.js',
  'flows/dailyBranchOpsFlow.js',
  'services/branchOpsService.js',
  'services/eveningExpenseReport.js',
  'services/paymentService.js',
  'flows/paymentFlow.js',
  'services/paymentCards.js',
  'flows/taskFlow.js',
  'repositories/incentivesRepository.js',
  'services/approvalReminder.js',
];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

test('no side-A file reaches config.currency, the sale helpers or the deprecated money shims', () => {
  const REACH = [/\bconfig\.currency\b/, /\bmoney\.sale\b/, /\bsaleRate\b/, /\bsaleHeader\b/, /\bsaleLegend\b/,
    /\bfmtMoneyShort\b/, /\bfmtMoney\b/, /\bDEFAULT_CURRENCY\b/, /\bCURRENCY\b/];
  for (const rel of SIDE_A) {
    const code = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    for (const re of REACH) assert.doesNotMatch(code, re, `${rel} reaches ${re.source}`);
  }
});

test('the three cash-book printers share ONE formatter, and every ₦ figure comes from money.expense', () => {
  const office = fs.readFileSync(path.join(SRC, 'flows/officeExpenseFlow.js'), 'utf8');
  const daily = fs.readFileSync(path.join(SRC, 'flows/dailyBranchOpsFlow.js'), 'utf8');
  const evening = fs.readFileSync(path.join(SRC, 'services/eveningExpenseReport.js'), 'utf8');
  assert.match(office, /const \{ fmtNgn \} = branchOpsService;/);
  assert.match(daily, /const \{ fmtNgn \} = branchOpsService;/);
  assert.match(evening, /const ngn = branchOpsService\.fmtNgn;/);
  // No file prefixes its own ₦ in front of the shared formatter any more.
  for (const [name, src] of [['officeExpenseFlow', office], ['dailyBranchOpsFlow', daily], ['eveningExpenseReport', evening]]) {
    assert.doesNotMatch(src, /₦\$\{(fmtNgn|ngn)\(/, `${name} still spells ₦ in front of the formatter`);
    assert.doesNotMatch(stripComments(src), /\bfmtQty\b/, `${name} still formats money through fmtQty`);
  }
  const branchOps = fs.readFileSync(path.join(SRC, 'services/branchOpsService.js'), 'utf8');
  assert.match(branchOps, /return money\.expense\(safe, \{ fraction \}\);/);
  const pay = fs.readFileSync(path.join(SRC, 'services/paymentService.js'), 'utf8');
  assert.match(pay, /function fmtNaira\(amount\) \{[\s\S]*?return money\.expense\(n\);/);
  const task = fs.readFileSync(path.join(SRC, 'flows/taskFlow.js'), 'utf8');
  assert.match(task, /function fmtIncentive\(n\) \{ return money\.expense\(n\); \}/);
  assert.match(task, /const currency = INCENTIVE_CURRENCY;/, 'the state-machine meta carries the literal code too');
});
