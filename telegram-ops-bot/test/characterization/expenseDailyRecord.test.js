'use strict';

/**
 * EXP-1 — the daily office record + 20:00 finance report (owner-confirmed
 * layout, 08-Aug-2026). Pinned:
 *
 *  - the entry screen is a category picker (person / office / commission /
 *    cash in / today / zero-day);
 *  - person chips come from the Users sheet (active staff only) and the
 *    item lands kind=person_allowance with the person's user_id in ref_id
 *    — ONE concise row per item;
 *  - commission rides a who/what remark; cash-in records IMMEDIATELY and
 *    reports the computed balance; no approval row for cash-in;
 *  - the zero-day chip works SESSION-FREE (it lives on the reminder DM)
 *    and refuses once outflows exist;
 *  - the 🌇 report DMs every admin per active branch; a branch that filed
 *    nothing gets its recent filers reminded with File-now / zero-day
 *    chips; the tick fires once per day inside the catch-up window.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = 'abdul,yarima';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const branchOpsService = require(path.join(SRC, 'services/branchOpsService'));
const branchOpsLogRepository = require(path.join(SRC, 'repositories/branchOpsLogRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const flow = require(path.join(SRC, 'flows/officeExpenseFlow'));
const eveningReport = require(path.join(SRC, 'services/eveningExpenseReport'));

const TODAY = branchOpsService.todayInTz();

auditLogRepository.append = async () => {};
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: String(id) === 'abdul' ? 'Abdul' : 'Yarima', warehouses: ['Idumota'] });
usersRepository.getAll = async () => [
  { user_id: 'abdul', name: 'Abdul', status: 'active', warehouses: ['Idumota'] },
  { user_id: 'yarima', name: 'Yarima', status: 'active', warehouses: ['Idumota'] },
  { user_id: 'gone', name: 'Old Guy', status: 'inactive', warehouses: ['Idumota'] },
];

// In-memory BranchOpsLog.
let logRows = [];
branchOpsLogRepository.getAll = async () => logRows.map((r) => ({ ...r }));
branchOpsLogRepository.findByBranchDate = async (branch, date) => logRows
  .filter((r) => r.branch.toLowerCase() === String(branch).toLowerCase() && r.date === date)
  .map((r) => ({ ...r }));
branchOpsLogRepository.append = async (r) => {
  const rec = { status: 'logged', ...r, amount: r.amount === '' ? 0 : Number(r.amount) || 0 };
  logRows.push(rec); return rec;
};
branchOpsLogRepository.appendMany = async (rows) => {
  const out = [];
  for (const r of rows) out.push(await branchOpsLogRepository.append(r));
  return out;
};

let queued = [];
approvalQueueRepository.append = async (rec) => { queued.push(rec); return rec; };

function lastMsg(bot) {
  const c = bot.calls.filter((x) => ['sendMessage', 'editMessageText'].includes(x.method)).pop();
  return { text: (c && c.args.text) || '', kb: (((c || {}).args || {}).opts?.reply_markup?.inline_keyboard || []).flat() };
}
const txt = (text, uid = 'abdul') => ({ chat: { id: uid }, from: { id: uid }, text });

test('entry screen is the category picker with all six choices', async () => {
  logRows = []; queued = [];
  const bot = createFakeBot();
  await flow.start(bot, 'abdul', 'abdul', null);
  const { text, kb } = lastMsg(bot);
  assert.match(text, /Office Expenses/);
  const datas = kb.map((b) => b.callback_data);
  for (const d of ['ofex:cat:per', 'ofex:cat:off', 'ofex:cat:com', 'ofex:cat:cash', 'ofex:today', 'ofex:zd']) {
    assert.ok(datas.includes(d), `${d} offered`);
  }
});

test('person allowance: Users-sheet chips (active only) → one concise typed row in the batch', async () => {
  logRows = []; queued = [];
  const bot = createFakeBot();
  await flow.start(bot, 'abdul', 'abdul', null);
  await flow.handleCallback(bot, cb('ofex:cat:per', 'abdul'));
  const { kb } = lastMsg(bot);
  const names = kb.filter((b) => (b.callback_data || '').startsWith('ofex:per:')).map((b) => b.text);
  assert.deepEqual(names, ['👤 Abdul', '👤 Yarima'], `inactive staff never get a chip, got: ${names}`);

  await flow.handleCallback(bot, cb('ofex:per:0', 'abdul')); // Abdul
  await flow.handleText(bot, txt('1000'));
  const session = sessionStore.get('abdul');
  assert.deepEqual(session.items, [{ kind: 'person_allowance', title: 'Abdul', amount: 1000, ref_id: 'abdul' }]);
  assert.equal(session.step, 'pick_cat', 'back on the category picker');

  // Commission joins the same batch.
  await flow.handleCallback(bot, cb('ofex:cat:com', 'abdul'));
  await flow.handleText(bot, txt('Sir Pee — 52 bales'));
  await flow.handleText(bot, txt('104000'));
  assert.equal(sessionStore.get('abdul').items.length, 2);

  // Submit — ONE approval row; eager sheet rows carry kind + ref_id.
  await flow.handleCallback(bot, cb('ofex:submit', 'abdul'));
  assert.equal(queued.length, 1);
  const items = queued[0].actionJSON.items;
  assert.deepEqual(items.map((i) => i.kind), ['person_allowance', 'commission']);
  const eager = logRows.filter((r) => r.status === 'pending_approval');
  assert.equal(eager.length, 2);
  assert.equal(eager[0].kind, 'person_allowance');
  assert.equal(eager[0].ref_id, 'abdul');
  assert.equal(eager[0].subject, 'Abdul', 'concise: the subject is just the name');
  assert.equal(eager[1].kind, 'commission');
  sessionStore.clear('abdul');
});

test('cash received records IMMEDIATELY with the computed balance — no approval row', async () => {
  logRows = []; queued = [];
  const bot = createFakeBot();
  await flow.start(bot, 'abdul', 'abdul', null);
  await flow.handleCallback(bot, cb('ofex:cat:cash', 'abdul'));
  await flow.handleText(bot, txt('50000'));
  assert.equal(queued.length, 0, 'no approval batch for the owner\'s own cash');
  const rows = logRows.filter((r) => r.kind === 'cash_in');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 50000);
  assert.match(lastMsg(bot).text, /Balance in hand: \*₦50,000\*/);
  sessionStore.clear('abdul');
});

test('zero-day chip is session-free, and refuses once outflows exist', async () => {
  logRows = []; queued = [];
  sessionStore.clear('abdul');
  const bot = createFakeBot();
  await flow.handleCallback(bot, cb('ofex:zd', 'abdul')); // no session at all
  assert.equal(logRows.filter((r) => r.kind === 'zero_day').length, 1);
  assert.match(bot.allText(), /nothing spent today/i);

  logRows = [{ branch: 'Idumota', date: TODAY, kind: 'expense', subject: 'Fuel', amount: 500, status: 'logged', manager_id: 'abdul' }];
  const bot2 = createFakeBot();
  await flow.handleCallback(bot2, cb('ofex:zd', 'abdul'));
  assert.equal(logRows.filter((r) => r.kind === 'zero_day').length, 0, 'marker refused');
  assert.match(bot2.allText(), /contradict/);
});

/* ── the 🌇 20:00 finance report + reminder ── */

function seedFiledDay() {
  logRows = [
    { branch: 'Idumota', date: TODAY, kind: 'person_allowance', subject: 'Abdul', ref_id: 'abdul', amount: 1000, status: 'approved', manager_id: 'abdul' },
    { branch: 'Idumota', date: TODAY, kind: 'expense', subject: 'Fuel', amount: 5500, status: 'pending_approval', manager_id: 'abdul' },
    { branch: 'Idumota', date: TODAY, kind: 'commission', subject: 'Sir Pee — 52 bales', amount: 104000, status: 'approved', manager_id: 'abdul' },
    { branch: 'Idumota', date: TODAY, kind: 'cash_in', subject: 'Cash received', amount: 150000, status: 'logged', manager_id: 'abdul' },
  ];
}

test('🌇 report: every admin gets the branch day-card with spent + running balance', async () => {
  seedFiledDay();
  const bot = createFakeBot();
  const { reports, reminders } = await eveningReport.sendReports(bot);
  assert.equal(reports, 1, 'one admin configured → one report');
  assert.equal(reminders, 0, 'filed day → no reminder');
  const msg = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === '777');
  assert.ok(msg, 'report went to the admin');
  const t = String(msg.args.text);
  assert.match(t, /Office expenses — .*Idumota/);
  assert.match(t, /👤 Abdul ₦1,000/);
  assert.match(t, /🧾 Fuel ₦5,500/);
  assert.match(t, /🤝 Sir Pee — 52 bales ₦104,000/);
  assert.match(t, /➕ Cash received ₦150,000/);
  assert.match(t, /Spent \*₦110,500\* · Balance in hand \*₦39,500\*/);
  assert.match(t, /awaiting sign-off/);
});

test('nothing filed: recent filers get the two-chip reminder, admins get the ⚠️ card', async () => {
  // Yesterday's activity makes the branch (and Abdul as filer) active;
  // today is empty.
  logRows = [
    { branch: 'Idumota', date: '2026-08-01', kind: 'expense', subject: 'Fuel', amount: 500, status: 'approved', manager_id: 'abdul' },
  ];
  const bot = createFakeBot();
  const { reports, reminders } = await eveningReport.sendReports(bot);
  assert.equal(reminders, 1, 'Abdul reminded');
  assert.equal(reports, 1);
  const rem = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === 'abdul');
  assert.ok(rem, 'reminder DM sent');
  const chips = (rem.args.opts.reply_markup.inline_keyboard || []).flat().map((b) => b.callback_data);
  // EXP-1b — the zero-day chip carries ITS day so a late tap can refuse.
  assert.deepEqual(chips, ['act:office_expense', `ofex:zd:${TODAY}`], 'File now + dated zero-day chips');
  const adm = bot.callsTo('sendMessage').find((c) => String(c.args.chatId) === '777');
  assert.match(String(adm.args.text), /Nothing filed today/i);
  assert.match(String(adm.args.text), /Reminder sent/i);
});

test('EXP-1b: a dated zero-day chip tapped after its day refuses; report claims stay honest', async () => {
  logRows = []; queued = [];
  sessionStore.clear('abdul');
  const bot = createFakeBot();
  await flow.handleCallback(bot, cb('ofex:zd:2026-01-01', 'abdul'));
  assert.equal(logRows.filter((r) => r.kind === 'zero_day').length, 0, 'yesterday\'s chip marks nothing');
  assert.match(bot.allText(), /day has passed/i);

  // No reachable filer → the admins' card must NOT claim a reminder went out.
  logRows = [
    { branch: 'Idumota', date: '2026-08-01', kind: 'expense', subject: 'Fuel', amount: 500, status: 'approved', manager_id: 'gone' },
  ];
  const bot2 = createFakeBot();
  const { reminders } = await eveningReport.sendReports(bot2);
  assert.equal(reminders, 0, 'inactive filer skipped');
  const adm = bot2.callsTo('sendMessage').find((c) => String(c.args.chatId) === '777');
  assert.match(String(adm.args.text), /Could not reach any filer/i, 'the card says what actually happened');
  assert.ok(!/Reminder sent/i.test(String(adm.args.text)));
});

test('EXP-1b: zero-day marker goes VOID once outflows land the same day', async () => {
  logRows = [
    { branch: 'Idumota', date: TODAY, kind: 'zero_day', subject: 'Nothing spent', amount: 0, status: 'logged', manager_id: 'abdul' },
    { branch: 'Idumota', date: TODAY, kind: 'expense', subject: 'Fuel', amount: 5500, status: 'approved', manager_id: 'abdul' },
  ];
  const rep = await branchOpsService.getExpenseDayReport({ branch: 'Idumota' });
  assert.equal(rep.zeroDay, false, 'the day reads as its expenses, never as both');
  assert.equal(rep.spent, 5500);
});

test('tick: fires once per day at/after the set time, never after the catch-up window', async () => {
  seedFiledDay();
  settingsRepository.getAll = async () => ({
    EXPENSE_REPORT_ENABLED: 1, EXPENSE_REPORT_TIME: '20:00', EXPENSE_REPORT_CATCHUP_MINUTES: 120,
  });
  eveningReport._internals.resetForTest();
  // Lagos is UTC+1 → 20:05 Lagos = 19:05Z.
  const at2005 = new Date(`${TODAY}T19:05:00Z`);
  const bot = createFakeBot();
  assert.equal(await eveningReport.tick(bot, new Date(`${TODAY}T18:00:00Z`)), false, '19:00 Lagos — too early');
  assert.equal(await eveningReport.tick(bot, at2005), true, '20:05 Lagos — fires');
  assert.equal(await eveningReport.tick(bot, new Date(`${TODAY}T19:30:00Z`)), false, 'same day — never twice');

  eveningReport._internals.resetForTest();
  const late = createFakeBot();
  assert.equal(await eveningReport.tick(late, new Date(`${TODAY}T21:30:00Z`)), false,
    '22:30 Lagos — beyond catch-up, the day is marked done silently');
  assert.equal(late.calls.length, 0, 'nothing sent at midnight-ish');
});
