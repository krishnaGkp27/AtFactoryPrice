'use strict';

/**
 * TRM-1 — the automatic reminder sweep.
 *
 * The four promises the owner asked for, pinned as behaviour:
 *   1. A task nobody armed is NEVER nudged (the dual-admin gate is the
 *      only door in — the sweep must not have a second one).
 *   2. An armed task nudges the DOER and mirrors to the ASSIGNER, so the
 *      two stay synchronous.
 *   3. Never twice in one Lagos day, whatever the cadence.
 *   4. Reminders fall silent the moment it stops being the doer's move —
 *      including an ACTIVE task still inside the time they committed to.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_IDS = '777,888';

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');
installFakeSheets(createFakeSheets({}));

const svc = require(path.join(SRC, 'services/taskReminderService'));
const tasksRepository = require(path.join(SRC, 'repositories/tasksRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));

const DOER = '900';
const ASSIGNER = '100';
const HOUR = 3600000;

let ROWS = [];
let EVENTS = [];
tasksRepository.getAll = async () => ROWS.map((r) => ({ ...r }));
const taskEventsRepository = require(path.join(SRC, 'repositories/taskEventsRepository'));
taskEventsRepository.getAll = async () => EVENTS.map((e) => ({ ...e }));
taskEventsRepository.append = async (e) => {
  EVENTS.push({ ...e, at: e.at || new Date().toISOString() });
  return e;
};
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}` });
settingsRepository.getAll = async () => ({ TASK_REMINDER_ENABLED: 1, TASK_REMINDER_HOURS: 24 });

function task(over = {}) {
  return {
    task_id: 'T1', title: 'Payment collection', description: 'Collect from Kano.',
    assigned_to: DOER, assigned_by: ASSIGNER, status: 'assigned', track: 'salaried',
    priority: 'critical', auto_remind: true,
    assigned_at: '2026-08-01T09:00:00Z', last_event_at: '2026-08-01T09:00:00Z',
    proposed_hours: null, proposed_deadline: '', started_at: '',
    ...over,
  };
}
function fakeBot() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId: String(chatId), text, opts }); return { message_id: sent.length }; },
    to(id) { return this.sent.filter((m) => m.chatId === String(id)); },
  };
}
const NOW = new Date('2026-08-27T10:00:00Z').getTime();

test('an UNARMED task is never nudged — the dual-admin gate is the only door', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task({ auto_remind: false })];
  const bot = fakeBot();
  const out = await svc.sweep(bot, { now: NOW });
  assert.equal(out.sent, 0);
  assert.equal(bot.sent.length, 0, 'not one message');
});

test('an armed task nudges the doer AND mirrors to the assigner', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task()];
  const bot = fakeBot();
  const out = await svc.sweep(bot, { now: NOW });
  assert.equal(out.sent, 1);

  const toDoer = bot.to(DOER);
  assert.equal(toDoer.length, 1, 'exactly one DM to the doer');
  assert.match(toDoer[0].text, /waiting on you/i);
  assert.match(toDoer[0].text, /Payment collection/);
  assert.match(toDoer[0].text, /Collect from Kano/, 'the instruction travels with the nudge');
  assert.match(toDoer[0].text, /Accept — give time/, 'and the action they must take');
  const chips = JSON.stringify(toDoer[0].opts.reply_markup);
  assert.match(chips, /tsk:est:T1/, 'the DM carries the doer chip, not just words');

  const toAssigner = bot.to(ASSIGNER);
  assert.equal(toAssigner.length, 1, 'exactly one mirror to the assigner');
  assert.match(toAssigner[0].text, /Reminder sent on your behalf/i);
  assert.match(toAssigner[0].text, /User900/, 'naming who was reminded');
  assert.match(toAssigner[0].text, /Stop reminders/, 'and how to end it');
});

test('never twice in one Lagos day, and the cadence spaces the next one', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task()];
  const bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.to(DOER).length, 1);

  // An hour later the sweep is due again — the per-task day guard holds.
  await svc.sweep(bot, { now: NOW + HOUR });
  assert.equal(bot.to(DOER).length, 1, 'same day → still one');

  // Two days on, it speaks again.
  await svc.sweep(bot, { now: NOW + 48 * HOUR });
  assert.equal(bot.to(DOER).length, 2, 'a new day and past the cadence → one more');
});

test('silence the moment it is not the doer\'s move', async () => {
  const notTheirs = ['awaiting_timeline_ack', 'awaiting_incentive', 'submitted', 'completed', 'dropped'];
  for (const status of notTheirs) {
    svc._internals._resetForTests(); EVENTS = [];
    ROWS = [task({ status })];
    const bot = fakeBot();
    await svc.sweep(bot, { now: NOW });
    assert.equal(bot.sent.length, 0, `${status} must be silent`);
  }
});

test('an ACTIVE task is nudged only after the time THEY committed to', async () => {
  // Salaried: started 2h ago, gave 8h → still inside their own estimate.
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task({ status: 'active', proposed_hours: 8, started_at: new Date(NOW - 2 * HOUR).toISOString() })];
  let bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.sent.length, 0, 'working on schedule is not nagged');

  // Same task, 10h in → the agreed finish has passed.
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task({ status: 'active', proposed_hours: 8, started_at: new Date(NOW - 10 * HOUR).toISOString() })];
  bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.to(DOER).length, 1, 'past their own estimate → nudged');
  assert.match(bot.to(DOER)[0].text, /agreed time has passed/i);

  // Incentivized: a deadline is not blown until its day ends.
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task({ status: 'active', track: 'incentivized', proposed_deadline: '2026-08-27' })];
  bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.sent.length, 0, 'due TODAY is not overdue');
});

test('the master switch silences everything in one cell', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  settingsRepository.getAll = async () => ({ TASK_REMINDER_ENABLED: 0 });
  ROWS = [task()];
  const bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.sent.length, 0);
  settingsRepository.getAll = async () => ({ TASK_REMINDER_ENABLED: 1, TASK_REMINDER_HOURS: 24 });
});

test('a blocked doer DM still tells the assigner — and never throws', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task()];
  const bot = fakeBot();
  const realSend = bot.sendMessage;
  bot.sendMessage = async (chatId, text, opts) => {
    if (String(chatId) === DOER) throw new Error('ETELEGRAM: 403 bot was blocked by the user');
    return realSend.call(bot, chatId, text, opts);
  };
  const out = await svc.sweep(bot, { now: NOW });
  assert.equal(out.sent, 0, 'nothing was delivered to the doer');
  const toAssigner = bot.to(ASSIGNER);
  assert.equal(toAssigner.length, 1, 'still exactly one digest');
  assert.match(toAssigner[0].text, /not delivered/i, 'the assigner is told the truth');
});

test('a sheet failure can never take the scheduler down', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  tasksRepository.getAll = async () => { throw new Error('Sheets 503'); };
  const bot = fakeBot();
  const out = await svc.sweep(bot, { now: NOW });
  assert.deepEqual(out, { sent: 0, considered: 0 });
  tasksRepository.getAll = async () => ROWS.map((r) => ({ ...r }));
});

test('twenty armed tasks produce ONE digest to the assigner, not twenty DMs', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = Array.from({ length: 12 }, (_, i) => task({ task_id: `T${i}`, title: `Task ${i}` }));
  const bot = fakeBot();
  const out = await svc.sweep(bot, { now: NOW });
  assert.equal(out.sent, 12, 'every doer nudged');
  assert.equal(bot.to(DOER).length, 12);
  const digest = bot.to(ASSIGNER);
  assert.equal(digest.length, 1, 'ONE message to the admin, however many tasks');
  assert.match(digest[0].text, /Reminders sent on your behalf/i, 'plural when it is plural');
  assert.match(digest[0].text, /Task 0/);
  assert.match(digest[0].text, /Task 11/, 'every task named in the one digest');
});

test('a RESTART does not re-nudge — the day guard outlives the process', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task()];
  const bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.to(DOER).length, 1);
  assert.equal(EVENTS.filter((e) => e.event_type === 'reminder_sent').length, 1,
    'the reminder is recorded durably, not just in memory');

  // Simulate a redeploy: process memory is gone, the sheet is not.
  svc._internals._sentOn.clear();
  await svc.sweep(bot, { now: NOW + 2 * HOUR });
  assert.equal(bot.to(DOER).length, 1, 'same Lagos day after a restart → still one');
});

test('the manual door and the sweep share one day guard', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task()];
  // A manual 🔔 Remind happened this morning.
  await svc.noteReminded('T1', '777', { now: NOW - HOUR, via: 'manual' });
  const bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.sent.length, 0, 'the sweep respects what the human already sent');
});

test('the master switch fails CLOSED on any non-1 value', async () => {
  for (const v of [0, 'FALSE', 'no', 'off', '']) {
    svc._internals._resetForTests(); EVENTS = [];
    settingsRepository.getAll = async () => ({ TASK_REMINDER_ENABLED: v });
    ROWS = [task()];
    const bot = fakeBot();
    await svc.sweep(bot, { now: NOW });
    assert.equal(bot.sent.length, 0, `"${v}" must silence the nudges`);
  }
  settingsRepository.getAll = async () => ({ TASK_REMINDER_ENABLED: 1, TASK_REMINDER_HOURS: 24 });
});

test('a TRANSIENT failure keeps the day; a PERMANENT one does not retry', async () => {
  // 429 → the next sweep tries again rather than losing the day.
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task()];
  let bot = fakeBot();
  let fail = true;
  const realSend = bot.sendMessage;
  bot.sendMessage = async (chatId, text, opts) => {
    if (String(chatId) === DOER && fail) throw new Error('ETELEGRAM: 429 Too Many Requests');
    return realSend.call(bot, chatId, text, opts);
  };
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.to(DOER).length, 0);
  fail = false;
  await svc.sweep(bot, { now: NOW + HOUR });
  assert.equal(bot.to(DOER).length, 1, 'the blip did not cost the day');

  // Blocked → recorded, so we stop hammering a chat that cannot receive.
  svc._internals._resetForTests(); EVENTS = [];
  bot = fakeBot();
  const realSend2 = bot.sendMessage;
  bot.sendMessage = async (chatId, text, opts) => {
    if (String(chatId) === DOER) throw new Error('ETELEGRAM: 403 bot was blocked by the user');
    return realSend2.call(bot, chatId, text, opts);
  };
  await svc.sweep(bot, { now: NOW });
  await svc.sweep(bot, { now: NOW + HOUR });
  assert.equal(EVENTS.filter((e) => e.event_type === 'reminder_sent').length, 1,
    'one attempt recorded, not one per sweep');
});

test('an incentivized deadline turns overdue on the LAGOS day boundary', async () => {
  const due = { status: 'active', track: 'incentivized', proposed_deadline: '2026-08-27' };
  // 23:30 UTC on the 27th = 00:30 Lagos on the 28th → the Lagos day HAS ended.
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task(due)];
  let bot = fakeBot();
  await svc.sweep(bot, { now: Date.parse('2026-08-27T23:30:00Z') });
  assert.equal(bot.to(DOER).length, 1, 'past midnight in Lagos → overdue');

  // 22:00 UTC = 23:00 Lagos, still the 27th → not yet overdue.
  svc._internals._resetForTests(); EVENTS = [];
  bot = fakeBot();
  await svc.sweep(bot, { now: Date.parse('2026-08-27T22:00:00Z') });
  assert.equal(bot.sent.length, 0, 'still its own Lagos day → silent');
});

test('the per-sweep cap counts ATTEMPTS, so blocked chats cannot flood', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  const cap = svc._internals.MAX_DMS_PER_SWEEP;
  ROWS = Array.from({ length: cap + 8 }, (_, i) => task({ task_id: `T${i}` }));
  const bot = fakeBot();
  let attempts = 0;
  bot.sendMessage = async (chatId) => {
    if (String(chatId) === DOER) { attempts += 1; throw new Error('403 blocked'); }
    return { message_id: 1 };
  };
  await svc.sweep(bot, { now: NOW });
  assert.equal(attempts, cap, 'attempts are what the cap bounds, not successes');
});

test('a blank proposed_hours is not a commitment — no permanent overdue', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task({ status: 'active', proposed_hours: '', started_at: '2026-08-20T09:00:00Z' })];
  const bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.sent.length, 0, 'zero/blank hours must not read as "0h, so overdue"');
});

test('accepting a stale proposal restarts the clock — no nudge from minute one', async () => {
  // TSK-V2: the card promises "Accepting restarts his 2d from today".
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task({
    status: 'active', track: 'incentivized',
    proposed_deadline: '2026-08-20',              // long past
    proposed_hours: 48,
    started_at: new Date(NOW - 2 * HOUR).toISOString(), // accepted 2h ago
  })];
  let bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.sent.length, 0, 'inside the restarted 48h → silent');

  svc._internals._resetForTests(); EVENTS = [];
  ROWS[0].started_at = new Date(NOW - 50 * HOUR).toISOString();
  bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.to(DOER).length, 1, 'past the restarted 48h → nudged');
});

test('a deactivated doer is not nudged forever — the assigner is told to reassign', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  ROWS = [task()];
  usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}`, status: 'inactive' });
  const bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.to(DOER).length, 0, 'no DM to someone who has left');
  const digest = bot.to(ASSIGNER);
  assert.equal(digest.length, 1);
  assert.match(digest[0].text, /no longer active/i);
  assert.match(digest[0].text, /reassign/i, 'and what to do about it');
  usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `User${id}` });
});

test('a cadence longer than a day survives a restart', async () => {
  svc._internals._resetForTests(); EVENTS = [];
  settingsRepository.getAll = async () => ({ TASK_REMINDER_ENABLED: 1, TASK_REMINDER_HOURS: 72 });
  ROWS = [task()];
  const bot = fakeBot();
  await svc.sweep(bot, { now: NOW });
  assert.equal(bot.to(DOER).length, 1);

  // Redeploy, then a NEW Lagos day but only 26h later: the 72h cadence must
  // still hold, which it can only do by reading the durable trail.
  svc._internals._sentOn.clear();
  await svc.sweep(bot, { now: NOW + 26 * HOUR });
  assert.equal(bot.to(DOER).length, 1, '26h < 72h → still one, even after a restart');

  await svc.sweep(bot, { now: NOW + 80 * HOUR });
  assert.equal(bot.to(DOER).length, 2, 'past 72h → the next nudge');
  settingsRepository.getAll = async () => ({ TASK_REMINDER_ENABLED: 1, TASK_REMINDER_HOURS: 24 });
});
