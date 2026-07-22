'use strict';

/**
 * MORN-1 — scheduler timing (Lagos), once-per-day guard, category toggles,
 * and the customer-notes window.
 */

process.env.ADMIN_IDS = '777,888';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const { createFakeBot } = require('../../helpers/fakeBot');
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const customerNotesRepository = require(path.join(SRC, 'repositories/customerNotesRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const digest = require(path.join(SRC, 'services/morningDigest'));

let settings = {};
settingsRepository.getAll = async () => ({ ...settings });
function baseSettings(extra = {}) {
  return {
    DIGEST_ENABLED: 1, DIGEST_TIME: '09:15', DIGEST_TIMEZONE: 'Africa/Lagos',
    DIGEST_NOTES_DAYS: 7, DIGEST_CUSTOMER_NOTES: 1,
    DIGEST_FOLLOWUPS: 0, DIGEST_APPROVALS: 0, DIGEST_TASKS: 0,
    DIGEST_SAMPLES: 0, DIGEST_ORDERS: 0,
    ...extra,
  };
}

const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const pendingUsersRepository = require(path.join(SRC, 'repositories/pendingUsersRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
// The resolver goes through the exported findByUserId (stubbable); the
// internal getAll closure is NOT reachable from a getAll stub.
const USERS = { 777: { user_id: '777', name: 'Krishna' }, 4242: { user_id: '4242', name: 'Abdul' } };
usersRepository.findByUserId = async (id) => USERS[String(id)] || null;
pendingUsersRepository.getAll = async () => [];

customerNotesRepository.getAll = async () => [
  { note_id: 'N1', customer: 'CJE', note: 'promised payment Friday', created_by: '777', created_at: '2026-07-16T10:00:00.000Z' },
  { note_id: 'N2', customer: 'OKSON', note: 'wants 9037 restock call', created_by: '777', created_at: '2026-07-15T09:00:00.000Z' },
  { note_id: 'N0', customer: 'Old Corp', note: 'ancient note', created_by: '777', created_at: '2026-05-01T09:00:00.000Z' },
];
approvalQueueRepository.getAllPending = async () => [
  { requestId: 'R1', user: '4242', actionJSON: { action: 'sale_bundle' }, createdAt: '2026-07-15T08:00:00.000Z' },
];

// 09:15 Lagos = 08:15 UTC.
const BEFORE = new Date('2026-07-17T08:00:00Z'); // 09:00 Lagos
const AFTER = new Date('2026-07-17T08:20:00Z');  // 09:20 Lagos
const NEXT_DAY = new Date('2026-07-18T08:20:00Z');

test('fires only at/after 09:15 Lagos, once per day, with catch-up', async () => {
  digest._resetForTests();
  settings = baseSettings();
  const bot = createFakeBot();
  assert.equal(await digest.tick(bot, BEFORE), false, 'quiet before 09:15');
  assert.equal(await digest.tick(bot, AFTER), true, 'fires at 09:20 (catch-up past 09:15)');
  assert.equal(bot.calls.filter((c) => c.method === 'sendMessage').length, 2, 'one message per admin');
  assert.equal(await digest.tick(bot, new Date('2026-07-17T10:00:00Z')), false, 'same day never repeats');
  assert.equal(await digest.tick(bot, NEXT_DAY), true, 'fires again next day');
});

test('MORN-2: an afternoon redeploy never re-greets — catch-up only inside the grace window', async () => {
  digest._resetForTests(); // a redeploy wipes the in-memory sent marker
  settings = baseSettings();
  const bot = createFakeBot();
  const AFTERNOON = new Date('2026-07-17T13:40:00Z'); // 14:40 Lagos — 5h25m past 09:15
  assert.equal(await digest.tick(bot, AFTERNOON), false, 'boot tick outside the window stays silent');
  assert.equal(bot.calls.filter((c) => c.method === 'sendMessage').length, 0, 'nothing sent');
  assert.equal(await digest.tick(bot, new Date('2026-07-17T14:00:00Z')), false, 'day marked done — stays quiet');
  assert.equal(await digest.tick(bot, NEXT_DAY), true, 'next morning fires normally');

  // The window is a Settings knob: widen it and the same afternoon boot fires.
  digest._resetForTests();
  settings = { ...baseSettings(), DIGEST_CATCHUP_MINUTES: 600 };
  const bot2 = createFakeBot();
  assert.equal(await digest.tick(bot2, AFTERNOON), true, 'DIGEST_CATCHUP_MINUTES=600 allows the late catch-up');
});

test('launch toggles: notes summary counts total + new; drill-down shows ALL notes', async () => {
  digest._resetForTests();
  settings = baseSettings();
  const { text, keyboard } = await digest.buildSummary(settings, AFTER);
  assert.match(text, /Customer notes: \*3\* total · \*2\* new in 7 days/);
  assert.ok(!/promised payment/.test(text), 'summary stays compact — note text lives in the detail');
  assert.ok(!/Approvals pending/.test(text), 'approvals section off by default');
  const btns = keyboard.inline_keyboard.flat();
  assert.equal(btns.length, 1, 'one drill-down button (notes only)');
  assert.equal(btns[0].callback_data, 'rmd:d:DIGEST_CUSTOMER_NOTES');
  const { customers, total } = await digest.notesIndex(settings);
  assert.equal(total, 3);
  assert.deepEqual(customers.map((c) => c.customer), ['CJE', 'OKSON', 'Old Corp'], 'latest-note-first customer chips');
  const cje = await digest.notesForCustomer(settings, 0, 0);
  assert.match(cje.text, /promised payment Friday/);
  assert.ok(!/ancient note/.test(cje.text), 'only the tapped customer\'s notes');
});

test('per-customer notes paginate at 3/page with friendly dates, clamp out-of-range', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    note_id: 'M' + i, customer: 'OKSON', note: 'note number ' + i,
    created_by: '777', created_at: new Date(Date.parse('2026-07-16T10:00:00Z') - i * 3600e3).toISOString(),
  }));
  const saved = customerNotesRepository.getAll;
  customerNotesRepository.getAll = async () => many;
  const p0 = await digest.notesForCustomer(baseSettings(), 0, 0);
  assert.equal(p0.totalPages, 4, '12 notes at 3/page (owner 17-Jul)');
  assert.match(p0.text, /page 1\/4/);
  assert.match(p0.text, /note number 0/);
  assert.match(p0.text, /📌 \*16-Jul\*/, 'friendly date format 16-Jul');
  const pLast = await digest.notesForCustomer(baseSettings(), 0, 99);
  assert.match(pLast.text, /page 4\/4/, 'page clamps to last');
  assert.match(pLast.text, /note number 11/);
  assert.equal(await digest.notesForCustomer(baseSettings(), 44, 0), null, 'unknown customer index → null');
  customerNotesRepository.getAll = saved;
});

test('notes are grouped by author with display names (owner 19-Jul)', async () => {
  approvalCards._resetNameCacheForTests();
  const saved = customerNotesRepository.getAll;
  customerNotesRepository.getAll = async () => [
    { note_id: 'A1', customer: 'OKSON', note: 'newest by Krishna', created_by: '777', created_at: '2026-07-18T10:00:00.000Z' },
    { note_id: 'B1', customer: 'OKSON', note: 'note by Abdul', created_by: '4242', created_at: '2026-07-17T10:00:00.000Z' },
    { note_id: 'A2', customer: 'OKSON', note: 'older by Krishna', created_by: '777', created_at: '2026-07-16T10:00:00.000Z' },
  ];
  const r = await digest.notesForCustomer(baseSettings(), 0, 0);
  assert.match(r.text, /3 note\(s\) by 2 people/);
  // Grouped: both Krishna notes sit together under ONE header, ahead of
  // Abdul's group (Krishna has the newest note), despite the interleaved
  // chronology.
  const kIdx = r.text.indexOf('👤 *Krishna*');
  const aIdx = r.text.indexOf('👤 *Abdul*');
  assert.ok(kIdx >= 0 && aIdx > kIdx, 'Krishna group first, Abdul group after');
  assert.equal(r.text.match(/👤 \*Krishna\*/g).length, 1, 'one header per author group');
  assert.ok(r.text.indexOf('older by Krishna') < aIdx, "both Krishna notes precede Abdul's group");
  // Unknown author id degrades to the raw value, blank to 'Unknown'.
  customerNotesRepository.getAll = async () => [
    { note_id: 'X1', customer: 'OKSON', note: 'mystery note', created_by: '', created_at: '2026-07-18T10:00:00.000Z' },
  ];
  const r2 = await digest.notesForCustomer(baseSettings(), 0, 0);
  assert.match(r2.text, /👤 \*Unknown\*/);
  customerNotesRepository.getAll = saved;
});

test('author with NO Users row resolves via Telegram getChat (owner screenshot 19-Jul)', async () => {
  approvalCards._resetNameCacheForTests();
  const saved = customerNotesRepository.getAll;
  // 7863545956 = an env-ADMIN_IDS admin who predates the Users sheet.
  customerNotesRepository.getAll = async () => [
    { note_id: 'O1', customer: 'OKESON', note: 'asking for stripe design price', created_by: '7863545956', created_at: '2026-07-07T10:00:00.000Z' },
  ];
  const botWithChat = { getChat: async (id) => (String(id) === '7863545956' ? { first_name: 'Krishna', last_name: 'Sahay' } : null) };
  const r = await digest.notesForCustomer(baseSettings(), 0, 0, botWithChat);
  assert.match(r.text, /👤 \*Krishna Sahay\*/, 'Telegram profile name, not the raw id');
  assert.ok(!/7863545956/.test(r.text), 'raw id no longer shown');
  // Without a bot the raw id remains the last-resort fallback (never blank).
  approvalCards._resetNameCacheForTests();
  const r2 = await digest.notesForCustomer(baseSettings(), 0, 0);
  assert.match(r2.text, /👤 \*7863545956\*/);
  customerNotesRepository.getAll = saved;
});

test('flipping a toggle adds its section; DIGEST_ENABLED=0 silences everything', async () => {
  settings = baseSettings({ DIGEST_APPROVALS: 1 });
  const { text, keyboard } = await digest.buildSummary(settings, AFTER);
  assert.match(text, /Approvals pending: \*1\*/);
  assert.equal(keyboard.inline_keyboard.flat().length, 2, 'notes + approvals buttons');
  digest._resetForTests();
  settings = baseSettings({ DIGEST_ENABLED: 0 });
  const bot = createFakeBot();
  assert.equal(await digest.tick(bot, AFTER), false, 'master switch off → nothing');
  assert.equal(bot.calls.length, 0);
});

test('notes toggle on but sheet empty → digest still greets with the none-yet line', async () => {
  customerNotesRepository.getAll = async () => [];
  settings = baseSettings();
  const text = await digest.buildDigest(settings, AFTER);
  assert.match(text, /Customer notes: none yet/);
});
