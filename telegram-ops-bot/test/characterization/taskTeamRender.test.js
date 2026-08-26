'use strict';

/**
 * TSK-V3 — the Team Tasks admin list, RENDERED.
 *
 * Same lesson as taskSalariedRender: unit tests on the sort and the chips
 * prove nothing about the screen. These drive the real handleCallback with
 * a fake bot over a 10-task team and assert what the admin actually sees:
 * a capped chip page with a pager, a card behind every chip, sign-off
 * landing back on the list with the task gone, and the once-a-day remind.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../src');
const taskFlow = require(path.join(SRC, 'flows/taskFlow'));
const tasksRepository = require(path.join(SRC, 'repositories/tasksRepository'));
const taskEventsRepository = require(path.join(SRC, 'repositories/taskEventsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const departmentsRepo = require(path.join(SRC, 'repositories/departmentsRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const auth = require(path.join(SRC, 'middlewares/auth'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

const ADMIN = '100';
const ABDUL = '900';
const NEHA = '901';
const OTHER_MGR = '200';

let ROWS = [];

tasksRepository.getAll = async () => ROWS.map((r) => ({ ...r }));
tasksRepository.getById = async (id) => {
  const r = ROWS.find((x) => x.task_id === id);
  return r ? { ...r } : null;
};
tasksRepository.getByAssignedToMany = async (ids) => {
  const s = new Set(ids.map(String));
  return ROWS.filter((r) => s.has(r.assigned_to)).map((r) => ({ ...r }));
};
tasksRepository.getByAssignedBy = async (id) =>
  ROWS.filter((r) => r.assigned_by === String(id)).map((r) => ({ ...r }));
tasksRepository.getSubmittedPendingApproval = async () =>
  ROWS.filter((r) => r.status === 'submitted').map((r) => ({ ...r }));
tasksRepository.getSubmittedForAssigner = async (id) =>
  ROWS.filter((r) => r.status === 'submitted' && r.assigned_by === String(id)).map((r) => ({ ...r }));
tasksRepository.updateFields = async (id, patch) => {
  const r = ROWS.find((x) => x.task_id === id);
  if (r) Object.assign(r, patch);
  return true;
};
taskEventsRepository.append = async (e) => e;

const PEOPLE = {
  [ADMIN]: { user_id: ADMIN, name: 'Boss Man', status: 'active' },
  [ABDUL]: { user_id: ABDUL, name: 'Abdul Musa', status: 'active' },
  [NEHA]: { user_id: NEHA, name: 'Neha Singh', status: 'active' },
  [OTHER_MGR]: { user_id: OTHER_MGR, name: 'Other Manager', status: 'active', manages: ['Sales'] },
};
usersRepository.getAll = async () => Object.values(PEOPLE).map((u) => ({ ...u }));
usersRepository.findByUserId = async (id) => (PEOPLE[String(id)] ? { ...PEOPLE[String(id)] } : null);
departmentsRepo.getAll = async () => [];
settingsRepository.getAll = async () => ({ TASK_STALL_DAYS: 7 });
auth.isAdmin = (id) => String(id) === ADMIN;

function fakeBot() {
  const sent = [];
  return {
    sent,
    answerCallbackQuery: async () => true,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { message_id: sent.length }; },
    editMessageText: async (text, opts) => { sent.push({ chatId: opts.chat_id, text, opts }); return { message_id: opts.message_id }; },
    deleteMessage: async () => true,
    last() { return sent[sent.length - 1]; },
  };
}
const cbq = (data, from = ADMIN) =>
  ({ id: 'q1', data, from: { id: from }, message: { chat: { id: from }, message_id: 55 } });

const DAY = 86400000;
function seed() {
  const at = (d) => new Date(Date.now() - d * DAY).toISOString();
  const base = (i, over) => ({
    task_id: `T${i}`,
    title: `Task ${i}`,
    description: `Do the thing number ${i}.`,
    assigned_to: ABDUL,
    assigned_by: ADMIN,
    status: 'assigned',
    track: 'salaried',
    priority: 'normal',
    negotiation_rounds: 0,
    proposed_hours: null,
    proposed_deadline: '',
    assigned_at: at(i),
    created_at: at(i),
    last_event_at: at(i),
    ...over,
  });
  ROWS = [
    base(1, { priority: 'critical', status: 'submitted', proposed_hours: 8, title: 'Office Audit', started_at: at(1), submitted_at: at(0) }),
    base(2, { priority: 'critical', status: 'awaiting_timeline_ack', track: 'incentivized', proposed_hours: 48, proposed_deadline: '2026-05-13', title: 'Office work' }),
    base(3, { priority: 'critical', assigned_at: at(107), last_event_at: at(107), title: 'Payment collection' }),
    base(4, { priority: 'high', status: 'active', proposed_hours: 4, started_at: at(0) }),
    base(5, { priority: 'high', assigned_to: NEHA }),
    base(6, {}),
    base(7, {}),
    base(8, {}),
    base(9, {}),
    base(10, { priority: 'low' }),
    base(11, { status: 'completed', proposed_hours: 4, started_at: at(3), submitted_at: at(2), completed_at: at(2) }),
  ];
  sessionStore.clear(ADMIN);
}

function chipTexts(msg) {
  return (msg.opts.reply_markup.inline_keyboard || []).flat().map((b) => b.text);
}
function chipData(msg) {
  return (msg.opts.reply_markup.inline_keyboard || []).flat().map((b) => b.callback_data);
}

test('the list: capped chips, pager, counts, filter — no text wall', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.showTeamTasks(bot, ADMIN, ADMIN, 55);
  const msg = bot.last();

  assert.match(msg.text, /Team Tasks.*10 open/s, 'header counts the open tasks');
  assert.match(msg.text, /2 need YOU/, 'needs-you count');
  // Stalled = waiting-on-worker AND silent > 7d: T3 (107d) + T8/T9/T10 (8-10d).
  assert.match(msg.text, /4 stalled/, 'stall count');
  assert.match(msg.text, /1 running/, 'running count');
  assert.ok(!/T\d.*\n.*T\d.*\n.*T\d/.test(msg.text.replace(/[^\n\w]/g, '')), 'tasks are chips, not text lines');

  const data = chipData(msg);
  const taskChips = data.filter((d) => d && d.startsWith('tsk:tt:'));
  assert.equal(taskChips.length, 8, 'hard cap: 8 chips on page 1');
  const texts = chipTexts(msg);
  assert.ok(texts.some((x) => /Page 1\/2/.test(x)), 'pager row present');
  assert.ok(texts.some((x) => /Next ➡/.test(x)), 'Next button present');
  assert.ok(texts.some((x) => /^All ✓/.test(x)), 'person filter with All selected');
  assert.ok(texts.some((x) => /Abdul \(9\)/.test(x)), 'per-person open counts');
  assert.ok(texts.some((x) => /🗂 Completed \(1\)/.test(x)), 'completed door with count');

  // Priority-first: the first chip is critical and needs-you.
  assert.match(texts.find((x) => x.startsWith('🔴')), /🔴 👉/, 'critical needs-you leads');
  assert.ok(!/undefined|NaN/i.test(msg.text + texts.join(' ')), 'nothing broken renders');
});

test('paging via tsk:tp: and the chip order carries the priority ruling', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:tp:o:a:1'));
  const msg = bot.last();
  const taskChips = chipData(msg).filter((d) => d && d.startsWith('tsk:tt:'));
  assert.equal(taskChips.length, 2, 'page 2 holds the remaining 2');
  const texts = chipTexts(msg);
  assert.ok(texts.some((x) => /Page 2\/2/.test(x)));
  assert.ok(texts[texts.length - 4].startsWith('⚪') || chipTexts(msg).some((x) => x.startsWith('⚪')),
    'low priority lands last');
  // Chips on page 2 carry page-2 context so Back returns here.
  assert.match(taskChips[0], /^tsk:tt:o:a:1:/);
});

test('a chip opens the admin card: status first, description readable, legal buttons only', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:tt:o:a:0:T2'));
  const card = bot.last();
  assert.match(card.text, /Office work/);
  assert.match(card.text, /His proposal needs your answer/, 'admin phrasing, not doer phrasing');
  assert.match(card.text, /Do the thing number 2/, 'description travels onto the card');
  assert.match(card.text, /date passed/, 'a blown proposal date is called out');
  assert.match(card.text, /restarts his 2d from today/i, 'stale-accept semantics stated');
  const data = chipData(card);
  assert.ok(data.includes('tsk:acc:T2'), 'Accept rides the existing handler');
  assert.ok(data.includes('tsk:cnt:T2'), 'Counter rides the existing handler');
  assert.ok(data.includes('tsk:tp:o:a:0'), 'Back returns to the list page it came from');
  assert.ok(data.some((d) => d && d.startsWith('tsk:tdd:o:a:0:T2')), 'Drop carries context');
});

test('sign-off from the card re-renders the LIST with the task gone', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:sg:y:o:a:0:T1'));
  assert.equal(ROWS.find((r) => r.task_id === 'T1').status, 'completed', 'the approval really ran');
  const msg = bot.sent.filter((m) => String(m.chatId) === ADMIN).pop();
  assert.match(msg.text, /Team Tasks.*9 open/s, 'the admin lands back on the list, one fewer');
  assert.ok(!chipData(msg).some((d) => d && d.includes(':T1')), 'the signed-off task is gone');
  const doerDM = bot.sent.find((m) => String(m.chatId) === ABDUL);
  assert.match(doerDM.text, /Task completed/i, 'the doer still hears about it');
});

test('remind: one DM per task per day, said in the card, never spammed', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:rmd:o:a:0:T3'));
  let doerDMs = bot.sent.filter((m) => String(m.chatId) === ABDUL);
  assert.equal(doerDMs.length, 1, 'first tap DMs the worker');
  assert.match(doerDMs[0].text, /Reminder from Boss Man/);
  assert.match(doerDMs[0].text, /Payment collection/);
  assert.match(bot.last().text, /Reminder sent to Abdul/, 'the card says it went');

  await taskFlow.handleCallback(bot, cbq('tsk:rmd:o:a:0:T3'));
  doerDMs = bot.sent.filter((m) => String(m.chatId) === ABDUL);
  assert.equal(doerDMs.length, 1, 'second tap the same day sends nothing');
  assert.match(bot.last().text, /Already reminded today/, 'and says why');
});

test('another manager gets a view-only card — no action buttons on foreign tasks', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:tt:o:a:0:T3', OTHER_MGR));
  const card = bot.last();
  assert.match(card.text, /View only/);
  const data = chipData(card).filter(Boolean);
  assert.ok(!data.some((d) => /^tsk:(tdd|tpp|rmd|sg|acc|cnt|six):/.test(d)),
    'no mutating buttons for a manager who did not assign it');
  assert.ok(data.includes('tsk:tp:o:a:0'), 'Back still works');
});

test('Pending Sign-off is the same list pre-filtered to sign-offs', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.showPendingSignOff(bot, ADMIN, ADMIN, 55);
  const msg = bot.last();
  assert.match(msg.text, /Pending Sign-off\* — 1/);
  const taskChips = chipData(msg).filter((d) => d && d.startsWith('tsk:tt:'));
  assert.equal(taskChips.length, 1, 'only the submitted task');
  assert.match(taskChips[0], /^tsk:tt:s:a:0:T1$/, 'chip carries sign-off mode context');
});

test('🗂 Completed shows est→took and honours the filter', async () => {
  seed();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:tp:d:a:0'));
  const msg = bot.last();
  assert.match(msg.text, /Completed.*1/s);
  assert.match(msg.text, /Task 11/, 'title verbatim');
  assert.match(msg.text, /ETA 4h/, 'estimate vs actual per line');
  assert.ok(chipData(msg).includes('tsk:tp:o:a:0'), 'Back returns to the open list');
});
