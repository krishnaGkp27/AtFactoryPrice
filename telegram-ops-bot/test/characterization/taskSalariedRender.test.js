'use strict';

/**
 * TSK-V2 — the salaried track, RENDERED.
 *
 * The unit tests for this feature were state-machine assertions and source
 * greps. They passed while every card on the track threw at runtime
 * (`fmtDate.withTime` resolved to taskFlow's own date-only formatter, which
 * has no such method), because not one of them ever drew a card. Lint
 * cannot see a bad property access either.
 *
 * So these drive the real handleCallback with a fake bot and assert on what
 * the worker would actually see: tap the chip, tap a time, land on a running
 * card, reopen the list, open the task. Anything that throws on those paths
 * fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../src');
const taskFlow = require(path.join(SRC, 'flows/taskFlow'));
const tasksRepository = require(path.join(SRC, 'repositories/tasksRepository'));
const taskEventsRepository = require(path.join(SRC, 'repositories/taskEventsRepository'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

const DOER = '900';
let ROW;

tasksRepository.getById = async (id) => (ROW && ROW.task_id === id ? { ...ROW } : null);
tasksRepository.getByAssignedTo = async () => [{ ...ROW }];
tasksRepository.updateFields = async (id, patch) => { Object.assign(ROW, patch); return { ...ROW }; };
taskEventsRepository.append = async (e) => e;
usersRepository.findByUserId = async (id) => ({ user_id: String(id), name: `U${id}` });

function fakeBot() {
  const sent = [];
  return {
    sent,
    answerCallbackQuery: async () => true,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { message_id: sent.length }; },
    editMessageText: async (text, opts) => { sent.push({ chatId: opts.chat_id, text, opts }); return { message_id: opts.message_id }; },
    deleteMessage: async () => true,
    allText() { return sent.map((m) => m.text).join('\n---\n'); },
  };
}
const cbq = (data) => ({ id: 'q1', data, from: { id: DOER }, message: { chat: { id: DOER }, message_id: 55 } });

function seedAssigned() {
  ROW = {
    task_id: 'T1',
    title: 'Collect the Zenith draft',
    description: 'Ask for Mr Okoro at the branch.',
    assigned_to: DOER,
    assigned_by: '100',
    status: 'assigned',
    track: 'salaried',
    priority: 'normal',
    negotiation_rounds: 0,
    proposed_hours: null,
    proposed_deadline: '',
  };
  sessionStore.clear(DOER);
}

test('the whole salaried journey renders without throwing', async () => {
  seedAssigned();
  const bot = fakeBot();

  // 1. Open the time chart.
  await taskFlow.handleCallback(bot, cbq('tsk:est:T1'));
  const chart = bot.allText();
  assert.match(chart, /Time needed/i, 'the chart is drawn');
  assert.match(chart, /Ask for Mr Okoro/, 'the description travels onto the chart');
  assert.ok(!/custom/i.test(chart), 'no typed-entry escape hatch');

  // 2. Commit 4h — this is the tap that used to throw AFTER writing the row.
  await taskFlow.handleCallback(bot, cbq('tsk:ehr:4'));
  assert.equal(ROW.status, 'active', 'the clock started');
  assert.equal(ROW.proposed_hours, 4);

  const running = bot.sent[bot.sent.length - 2].text + '\n' + bot.sent[bot.sent.length - 1].text;
  assert.match(running, /clock started/i, 'the worker is shown the running card');
  assert.match(running, /Ask for Mr Okoro/, 'and can still read the instruction');
  assert.match(running, /Finish by about/i, 'with the derived finish time');
  assert.ok(!/undefined|NaN|Invalid/i.test(running), 'no broken formatting reaches the card');
});

test('the assigner is told the time was given', async () => {
  seedAssigned();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:est:T1'));
  await taskFlow.handleCallback(bot, cbq('tsk:ehr:8'));
  const toAssigner = bot.sent.filter((m) => String(m.chatId) === '100');
  assert.equal(toAssigner.length, 1, 'exactly one DM to the assigner');
  assert.match(toAssigner[0].text, /clock started/i);
  assert.match(toAssigner[0].text, /8h/);
});

test('an ACTIVE salaried task renders in the list and on its own card', async () => {
  // The state every pre-deploy salaried task in progress sits in — one of
  // these used to take down the worker's entire My Tasks screen.
  seedAssigned();
  ROW.status = 'active';
  ROW.proposed_hours = 4;
  ROW.started_at = new Date(Date.now() - 3600000).toISOString();

  const bot = fakeBot();
  await taskFlow.showMyTasks(bot, DOER, DOER, 55);
  const list = bot.allText();
  assert.match(list, /My Tasks/, 'the list renders');
  assert.ok(!/undefined|NaN/i.test(list), 'no broken time in the chip');

  const chips = JSON.stringify(bot.sent[bot.sent.length - 1].opts.reply_markup);
  assert.match(chips, /tsk:t:T1/, 'the task is a tappable chip');

  await taskFlow.handleCallback(bot, cbq('tsk:t:T1'));
  const card = bot.sent[bot.sent.length - 1].text;
  assert.match(card, /Collect the Zenith draft/);
  assert.match(card, /Ask for Mr Okoro/, 'the description has a permanent home');
  assert.ok(!/undefined|NaN/i.test(card));
});

test('Back from the chart returns the task card, not a dead end', async () => {
  seedAssigned();
  const bot = fakeBot();
  await taskFlow.handleCallback(bot, cbq('tsk:est:T1'));
  await taskFlow.handleCallback(bot, cbq('tsk:eback:T1'));
  const card = bot.sent[bot.sent.length - 1].text;
  assert.match(card, /Collect the Zenith draft/);
  assert.equal(ROW.status, 'assigned', 'backing out commits nothing');
});
