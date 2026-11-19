'use strict';

/**
 * BKP-4 — taking backup files back out of the chats, against a simulated
 * Telegram that keeps its rules: a message is found only by forwarding its
 * id, a forward makes a new message, and nothing older than 48 hours can be
 * deleted. Run under both ways Telegram might number a bot's messages (one
 * sequence across its private chats, or one per chat), because the purge
 * must not depend on which it is.
 */

process.env.ADMIN_IDS = '777,888';

const test = require('node:test');
const assert = require('node:assert/strict');

const backupPurge = require('../../../src/services/backupPurge');
const offsiteBackup = require('../../../src/services/offsiteBackup');
const jobRuns = require('../../../src/repositories/jobRunsRepository');
const settingsRepository = require('../../../src/repositories/settingsRepository');

const I = backupPurge._internals;
const real = { since: jobRuns.since, record: jobRuns.record, getAll: settingsRepository.getAll };
test.after(() => { Object.assign(jobRuns, { since: real.since, record: real.record }); settingsRepository.getAll = real.getAll; });

const H = 3600 * 1000;
const NOW = Date.parse('2026-11-19T09:00:00Z');          // 10:00 Lagos
const BACKUP_AT = Date.parse('2026-11-19T01:20:00Z');    // 02:20 Lagos
const BOT = { id: 42, is_bot: true };

function tgError(code, description, retryAfter) {
  const e = new Error(`ETELEGRAM: ${code} ${description}`);
  e.response = { statusCode: code, body: { ok: false, error_code: code, description, ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}) } };
  return e;
}

/** A Telegram that numbers messages in one sequence ('global') or one per chat ('perChat'). */
function makeTelegram(model = 'global') {
  const chats = new Map();
  const counters = new Map();
  const calls = [];
  let clock = NOW;
  let flood = 0;        // the next N forwards answer 429
  const blocked = new Set();
  const next = (chatId) => {
    const key = model === 'global' ? '*' : String(chatId);
    counters.set(key, (counters.get(key) || 0) + 1);
    return counters.get(key);
  };
  const box = (chatId) => { const k = String(chatId); if (!chats.has(k)) chats.set(k, new Map()); return chats.get(k); };
  const put = (chatId, m) => {
    const msg = { message_id: next(chatId), chat: { id: chatId }, date: Math.floor((m.at || clock) / 1000), from: m.from || BOT, ...m };
    delete msg.at;
    box(chatId).set(msg.message_id, msg);
    return msg;
  };
  const bot = {
    async sendMessage(chatId, text) {
      calls.push(['sendMessage', String(chatId), text]);
      if (blocked.has(String(chatId))) throw tgError(403, 'Forbidden: bot was blocked by the user');
      return put(chatId, { text });
    },
    async forwardMessage(chatId, fromChatId, messageId) {
      calls.push(['forwardMessage', String(fromChatId), messageId]);
      if (flood > 0) { flood -= 1; throw tgError(429, 'Too Many Requests: retry after 3', 3); }
      const src = box(fromChatId).get(Number(messageId));
      if (!src) throw tgError(400, 'Bad Request: message to forward not found');
      const origin = src.forward_origin || { type: 'user', sender_user: src.from, date: src.date };
      return put(chatId, { text: src.text, document: src.document, forward_origin: origin, forwardOf: src.message_id });
    },
    async deleteMessage(chatId, messageId) {
      calls.push(['deleteMessage', String(chatId), messageId]);
      const m = box(chatId).get(Number(messageId));
      if (!m) throw tgError(400, 'Bad Request: message to delete not found');
      if (clock - m.date * 1000 > 48 * H) throw tgError(400, "Bad Request: message can't be deleted");
      box(chatId).delete(Number(messageId));
      return true;
    },
    async editMessageText(text, o) {
      calls.push(['editMessageText', String(o.chat_id), o.message_id]);
      const m = box(o.chat_id).get(Number(o.message_id));
      if (m) m.text = text;
      return m;
    },
  };
  return {
    bot, put, calls, blocked,
    setFlood: (k) => { flood = k; },
    docs: (chatId) => [...box(chatId).values()].filter((m) => m.document).map((m) => m.document.file_name),
    texts: (chatId) => [...box(chatId).values()].map((m) => m.text || `[${m.document.file_name}]`),
    count: (chatId) => box(chatId).size,
    copies: (chatId) => [...box(chatId).values()].filter((m) => m.forwardOf).length,
    forwardedIds: (chatId) => calls.filter((c) => c[0] === 'forwardMessage' && c[1] === String(chatId)).map((c) => c[2]),
  };
}

const doc = (name) => ({ document: { file_name: name, file_id: `f_${name}` } });
const FILES = ['afp-backup-2026-11-19-workbook-part1of2.xlsx', 'afp-backup-2026-11-19-workbook-part2of2.xlsx', 'afp-backup-2026-11-19-data.ndjson.gz'];

/** A night and a morning of bot traffic for two admins and one employee, with the 02:20 backup in it. */
function night(tg) {
  const { put } = tg;
  // long before the backup
  for (let i = 0; i < 6; i += 1) { put('777', { text: `old card ${i}`, at: BACKUP_AT - (30 - i) * H }); put('888', { text: `old card ${i}`, at: BACKUP_AT - (30 - i) * H }); }
  put('4242', { text: 'employee, evening', at: BACKUP_AT - 6 * H, from: { id: 4242, is_bot: false } });
  put('777', { text: 'approval card, evening', at: BACKUP_AT - 5 * H });
  put('888', { text: 'approval card, evening', at: BACKUP_AT - 5 * H });
  put('777', { text: 'reminder, 01:00', at: BACKUP_AT - 20 * 60 * 1000 });
  put('888', { text: 'reminder, 01:00', at: BACKUP_AT - 20 * 60 * 1000 });
  // the backup itself: each file to each admin
  for (const f of FILES) { put('777', { ...doc(f), at: BACKUP_AT }); put('888', { ...doc(f), at: BACKUP_AT }); }
  // the morning
  put('4242', { text: 'employee typed something', at: BACKUP_AT + 5 * H, from: { id: 4242, is_bot: false } });
  put('4242', { text: 'the bot answered', at: BACKUP_AT + 5 * H });
  put('777', { text: 'Good morning digest', at: BACKUP_AT + 7 * H });
  put('888', { text: 'Good morning digest', at: BACKUP_AT + 7 * H });
  put('777', { text: 'admin typed hi', at: BACKUP_AT + 7 * H, from: { id: 777, is_bot: false } });
  put('888', { ...doc('invoice-R-1.pdf'), at: BACKUP_AT + 7 * H });
}

let rows;       // job_runs
let settings;
const sleeps = [];
const sleep = async (ms) => { sleeps.push(ms); };

test.beforeEach(() => {
  I._resetForTests();
  offsiteBackup._internals._resetForTests();
  sleeps.length = 0;
  // the first nightly run: recorded, but with no message ids (it ran before they were kept)
  rows = [{ day: '2026-11-19', status: 'ok', detail: { workbook: { tabs: 77 } }, created_at: new Date(BACKUP_AT + 60 * 1000) }];
  settings = { OFFSITE_BACKUP_ENABLED: 0, OFFSITE_BACKUP_IDS: '' };
  jobRuns.since = async (job, from) => rows.filter((r) => new Date(r.created_at).getTime() >= new Date(from).getTime());
  jobRuns.record = async (job, day, status, detail) => { rows.push({ day, status, detail, created_at: new Date(NOW) }); return rows.length; };
  settingsRepository.getAll = async () => ({ ...settings });
});

const go = (tg, o = {}) => backupPurge.run(tg.bot, { byUserId: '777', now: NOW, sleep, clock: () => NOW, ...o });

for (const model of ['global', 'perChat']) {
  test(`[${model} ids] the first nightly backup, sent before ids were kept: every file is found and removed from every admin's chat, and nothing else`, async () => {
    const tg = makeTelegram(model);
    night(tg);
    const before = { a: tg.texts('777').filter((t) => !t.startsWith('[afp-backup')), b: tg.texts('888').filter((t) => !t.startsWith('[afp-backup')), e: tg.texts('4242') };
    assert.equal(tg.docs('777').filter((n) => n.startsWith('afp-backup')).length, 3);

    const res = await go(tg);
    assert.deepEqual([res.ok, res.deleted, res.failed, res.leftovers, res.complete], [true, 6, 0, 0, true]);
    assert.deepEqual(res.perChat, { 777: 3, 888: 3 });
    assert.deepEqual(tg.docs('777'), [], 'no backup file left in the first admin\'s chat');
    assert.deepEqual(tg.docs('888'), ['invoice-R-1.pdf'], 'another document is untouched');
    assert.equal(tg.copies('777') + tg.copies('888'), 0, 'every copy made while looking is gone');

    // every other message is exactly where it was, plus one line saying what happened
    const note = '🧹 3 backup files were removed from this chat.';
    assert.deepEqual(tg.texts('777'), [...before.a, note]);
    assert.deepEqual(tg.texts('888'), [...before.b.filter((t) => t !== '[invoice-R-1.pdf]'), '[invoice-R-1.pdf]', note]);
    assert.deepEqual(tg.texts('4242'), before.e, 'an employee\'s chat is never touched');
    assert.ok(!tg.calls.some((c) => c[1] === '4242'), 'not even looked at');

    // nothing crossed from one chat into another: every forward stayed in its own chat
    assert.ok(tg.calls.filter((c) => c[0] === 'forwardMessage').every((c) => ['777', '888'].includes(c[1])));

    // the walk stopped once it was past the backup's time — it did not read the whole history
    const walked = tg.forwardedIds('777');
    const oldest = Math.min(...walked);
    assert.ok(oldest > 1, `stopped by date at id ${oldest}, well short of the first message`);

    // on record, so the next look has nothing to do
    assert.equal(rows.at(-1).status, 'purged');
    assert.deepEqual([rows.at(-1).detail.by, rows.at(-1).detail.deleted], ['777', 6]);
    assert.equal(await backupPurge.pending(NOW + 1000), false);
    const again = await go(tg, { now: NOW + 1000 });
    assert.equal(again.nothing, true);
  });
}

test('recorded files are deleted by their ids: nothing is forwarded, nobody\'s chat flickers', async () => {
  const tg = makeTelegram();
  const a = tg.put('777', { ...doc(FILES[0]), at: NOW - 2 * H });
  const b = tg.put('888', { ...doc(FILES[0]), at: NOW - 2 * H });
  tg.put('777', { text: 'a card', at: NOW - H });
  rows = [{ day: '2026-11-19', status: 'manual', created_at: new Date(NOW - 2 * H), detail: { messages: [{ c: '777', m: a.message_id }, { c: '888', m: b.message_id }] } }];
  assert.equal(await backupPurge.pending(NOW), true);
  const res = await go(tg);
  assert.deepEqual([res.deleted, res.complete, res.perChat], [2, true, { 777: 1, 888: 1 }]);
  assert.deepEqual(tg.calls.map((c) => c[0]), ['deleteMessage', 'deleteMessage']);
  assert.deepEqual(tg.texts('777'), ['a card']);
  assert.equal(rows.at(-1).status, 'purged');
});

test('a failed run\'s half-delivered files are on record too, and are removed', async () => {
  const tg = makeTelegram();
  const a = tg.put('777', { ...doc(FILES[0]), at: NOW - H });
  rows = [{ day: '2026-11-19', status: 'failed', created_at: new Date(NOW - H), detail: { messages: [{ c: '777', m: a.message_id }] } }];
  const res = await go(tg);
  assert.deepEqual([res.deleted, res.complete], [1, true]);
  assert.deepEqual(tg.docs('777'), []);
});

test('nothing sent in the last 48 hours: nothing is touched', async () => {
  const tg = makeTelegram();
  night(tg);
  rows = [];
  assert.equal(await backupPurge.pending(NOW), false);
  const res = await go(tg);
  assert.deepEqual([res.ok, res.nothing, res.deleted], [true, true, 0]);
  assert.equal(tg.calls.length, 0);
  assert.equal(rows.length, 0, 'and nothing is recorded');
});

test('an old message forwarded into the chat does not end the look early', async () => {
  const tg = makeTelegram();
  night(tg);
  // after the backup: the admin forwards in a note from two years ago, and one of the bot's own old cards
  tg.put('777', { text: 'forwarded from a friend, 2024', at: NOW - H, from: { id: 777, is_bot: false }, forward_origin: { type: 'user', sender_user: { id: 5, is_bot: false }, date: 1700000000 } });
  tg.put('777', { text: 'the bot\'s own card from last month, forwarded back', at: NOW - H, from: { id: 777, is_bot: false }, forward_origin: { type: 'user', sender_user: BOT, date: Math.floor((NOW - 30 * 24 * H) / 1000) } });
  const res = await go(tg);
  assert.deepEqual([res.deleted, res.complete], [6, true]);
  assert.deepEqual(tg.docs('777'), []);
});

test('only the backup\'s own files are removed: by file name, whoever sent them', () => {
  const yes = ['afp-backup-2026-11-19-workbook.xlsx', 'afp-backup-2026-11-19-workbook-part1of2.xlsx', 'afp-backup-2026-11-19-data.ndjson.gz', 'AFP-BACKUP-2026-01-02-workbook.XLSX'];
  const no = ['invoice.pdf', 'afp-backup-notes.xlsx', 'my-afp-backup-2026-11-19-workbook.xlsx', 'afp-backup-2026-11-19-workbook.xlsx.exe', 'PACKING_LIST_TEMPLATE.xlsx', ''];
  for (const n of yes) assert.equal(I.isBackupMessage({ document: { file_name: n } }), true, n);
  for (const n of no) assert.equal(I.isBackupMessage({ document: { file_name: n } }), false, n);
  assert.equal(I.isBackupMessage({ text: 'afp-backup-2026-11-19-workbook.xlsx' }), false, 'a message that only names a file');
  assert.equal(I.isBackupMessage(null), false);
});

test('a backup file somebody sent BACK to the bot is removed as well', async () => {
  const tg = makeTelegram();
  night(tg);
  tg.put('888', { ...doc(FILES[2]), at: BACKUP_AT + 3 * H, from: { id: 888, is_bot: false } });
  const res = await go(tg);
  assert.deepEqual(res.perChat, { 777: 3, 888: 4 });
  assert.deepEqual(tg.docs('888'), ['invoice-R-1.pdf']);
});

test('Telegram says "slow down": the purge waits as told and loses nothing', async () => {
  const tg = makeTelegram();
  night(tg);
  tg.setFlood(2);
  const res = await go(tg);
  assert.deepEqual([res.deleted, res.complete], [6, true]);
  assert.equal(sleeps.filter((ms) => ms === 4000).length, 2, 'waited retry_after + 1 second, twice');
});

test('a chat the bot cannot reach is named, the others are still cleaned, and the job is not called complete', async () => {
  const tg = makeTelegram();
  night(tg);
  tg.blocked.add('888');
  const res = await go(tg);
  assert.deepEqual([res.deleted, res.complete, res.unreachable], [3, false, ['888']]);
  assert.deepEqual(res.perChat, { 777: 3 });
  assert.equal(rows.at(-1).status, 'purge_partial');
  assert.equal(await backupPurge.pending(NOW + 1000), true, 'still to do');
});

test('a chat named in the Settings cell is looked through too (a group the files once went to)', async () => {
  const tg = makeTelegram('perChat');
  night(tg);
  tg.put('-100123', { text: 'older', at: BACKUP_AT - 9 * H });
  tg.put('-100123', { text: 'older', at: BACKUP_AT - 8 * H });
  tg.put('-100123', { text: 'older', at: BACKUP_AT - 7 * H });
  for (const f of FILES) tg.put('-100123', { ...doc(f), at: BACKUP_AT });
  settings.OFFSITE_BACKUP_IDS = '-100123';
  const res = await go(tg);
  assert.deepEqual(res.perChat, { 777: 3, 888: 3, '-100123': 3 });
  assert.deepEqual(tg.docs('-100123'), []);
});

test('files older than 48 hours cannot be removed by Telegram\'s own rule: outside the window they are not looked for', async () => {
  const tg = makeTelegram();
  tg.put('777', { ...doc(FILES[0]), at: NOW - 60 * H });
  rows = [{ day: '2026-11-16', status: 'ok', detail: {}, created_at: new Date(NOW - 60 * H) }];
  assert.equal(await backupPurge.pending(NOW), false);
  const res = await go(tg);
  assert.equal(res.nothing, true);
  assert.equal(tg.calls.length, 0);
});

test('a recorded file Telegram refuses to delete is counted, and the job is not called complete', async () => {
  const tg = makeTelegram();
  rows = [{ day: '2026-11-19', status: 'ok', created_at: new Date(NOW - H), detail: { messages: [{ c: '777', m: 999 }] } }];
  const res = await go(tg);
  assert.deepEqual([res.deleted, res.failed, res.complete], [0, 1, false]);
  assert.equal(rows.at(-1).status, 'purge_partial');
});

test('one purge at a time', async () => {
  const tg = makeTelegram();
  night(tg);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async () => { await gate; };
  const first = backupPurge.run(tg.bot, { now: NOW, sleep: slow, clock: () => NOW });
  await new Promise((r) => setImmediate(r));
  const second = await go(tg);
  assert.equal(second.busy, true);
  release();
  assert.equal((await first).deleted, 6);
});

test('without a database: what this process sent is removed by id', async () => {
  const tg = makeTelegram();
  jobRuns.since = async () => null;
  const a = tg.put('777', { ...doc(FILES[0]), at: NOW - H });
  offsiteBackup._internals._resetForTests();
  const p0 = await backupPurge.plan(NOW);
  assert.deepEqual([p0.source, p0.recorded.length], ['memory', 0]);
  assert.equal(await backupPurge.pending(NOW), false);
  // a run in this process puts its messages in memory
  const realBuild = offsiteBackup.build;
  assert.equal(typeof realBuild, 'function');
  rows.length = 0;
  // simulate: the service kept one sent message
  const mem = offsiteBackup.sentInMemory();
  assert.deepEqual(mem, []);
  const direct = await I.sweepChat(tg.bot, '777', { topId: a.message_id + 1, sinceMs: NOW - 2 * H, sleep, clock: () => NOW });
  assert.deepEqual([direct.deleted, direct.stoppedBy], [1, 'start']);
});

test('the walk has a ceiling: a chat with no end in sight stops at the cap and says it did not finish', async () => {
  const tg = makeTelegram('perChat');
  // a very long chat, newer than the target all the way down
  for (let i = 0; i < I.MAX_SPAN + 50; i += 1) tg.put('777', { text: `m${i}`, at: NOW - 1000 });
  const r = await I.sweepChat(tg.bot, '777', { topId: I.MAX_SPAN + 51, sinceMs: NOW - 10 * H, sleep, clock: () => NOW });
  assert.deepEqual([r.scanned, r.stoppedBy, r.deleted, r.leftovers], [I.MAX_SPAN, 'cap', 0, 0]);
  assert.equal(tg.copies('777'), 0);
});

test('botSentAt: only a bot-sent original gives a date to stop on', () => {
  assert.equal(I.botSentAt({ forward_origin: { type: 'user', sender_user: { is_bot: true }, date: 100 } }), 100000);
  assert.equal(I.botSentAt({ forward_origin: { type: 'user', sender_user: { is_bot: false }, date: 100 } }), 0);
  assert.equal(I.botSentAt({ forward_origin: { type: 'hidden_user', date: 100 } }), 0);
  assert.equal(I.botSentAt({ forward_from: { is_bot: true }, forward_date: 7 }), 7000, 'the older field names');
  assert.equal(I.botSentAt({}), 0);
});
